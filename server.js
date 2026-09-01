const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const cookieParser = require("cookie-parser");
const { generateSentences } = require("./lib/generateSentences");

/* ---------------------------------------------------------------------
   .env 파일 로더 (외부 dotenv 패키지 없이 최소 구현)
--------------------------------------------------------------------- */
function loadEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf8").split("\n");
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const idx = trimmed.indexOf("=");
    if (idx === -1) return;
    const key = trimmed.slice(0, idx).trim();
    let val = trimmed.slice(idx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  });
}
loadEnv();

const PORT = process.env.PORT || 3000;
const BATCH_SIZE = 10;
const DB_PATH = path.join(__dirname, "data", "db.json");

/* ---------------------------------------------------------------------
   아주 단순한 파일 기반 DB
--------------------------------------------------------------------- */
function ensureDB() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DB_PATH)) {
    const initial = {
      history: [], // 지금까지 생성된 모든 문장 (중복 방지 및 조회용)
      byDate: {}, // { "2026-08-31": ["2026-08-31-01", ...] }
      completedAll: [],
      discardedAll: [],
      sessionCompleted: [], // 오늘 배치 안에서 완료 처리한 id
      sessionDiscarded: [], // 오늘 배치 안에서 폐기 처리한 id
      lastSessionDate: null,
      devDateOverride: null, // 테스트용: 실제 날짜 대신 사용할 날짜
      authTokens: [], // 로그인 시 발급되는 랜덤 세션 토큰 목록 (쿠키에 비밀번호 원문을 넣지 않기 위함)
    };
    fs.writeFileSync(DB_PATH, JSON.stringify(initial, null, 2));
  }
}
function readDB() {
  ensureDB();
  const db = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  // 구버전 db.json 마이그레이션: 새로 추가된 필드가 없으면 채워넣음
  if (!Array.isArray(db.authTokens)) db.authTokens = [];
  return db;
}
function writeDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function todayStr(db) {
  return db.devDateOverride || new Date().toISOString().slice(0, 10);
}

/**
 * 오늘 날짜의 배치가 없으면 Claude API를 호출해 새로 생성한다.
 * 핵심: history에 쌓인 "지금까지 나온 모든 문장"을 exclude 목록으로 넘겨
 *       중복 생성을 최대한 막고, 응답을 받은 뒤에도 한 번 더 로컬에서 중복 검사한다.
 */
async function ensureTodaysBatch(db) {
  const date = todayStr(db);

  if (db.byDate[date] && db.byDate[date].length) {
    if (db.lastSessionDate !== date) {
      db.sessionCompleted = [];
      db.sessionDiscarded = [];
      db.lastSessionDate = date;
      writeDB(db);
    }
    return date;
  }

  const excludeJp = db.history.map((h) => h.jp);
  let generated = await generateSentences({ excludeJp, count: BATCH_SIZE });

  // 응답에 혹시 겹치는 문장이 섞여 있으면 제거
  const seen = new Set(excludeJp);
  generated = generated.filter((item) => {
    const key = item.jp.trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // 중복 제거로 개수가 모자라면 부족분만큼 최대 3회까지 재요청
  let retries = 0;
  while (generated.length < BATCH_SIZE && retries < 3) {
    retries++;
    const need = BATCH_SIZE - generated.length;
    try {
      const more = await generateSentences({
        excludeJp: [...excludeJp, ...generated.map((g) => g.jp)],
        count: need,
      });
      more.forEach((item) => {
        const key = item.jp.trim();
        if (!seen.has(key)) {
          seen.add(key);
          generated.push(item);
        }
      });
    } catch (e) {
      console.warn(`보충 생성 실패 (시도 ${retries}/3):`, e.message);
      break; // API 자체가 실패하면 더 재시도해도 소용없으므로 중단
    }
  }
  if (generated.length < BATCH_SIZE) {
    console.warn(
      `⚠️ 오늘 문장이 ${generated.length}/${BATCH_SIZE}개만 채워졌습니다 (중복 회피로 인한 부족).`
    );
  }

  const ids = [];
  generated.forEach((item, i) => {
    const id = `${date}-${String(i + 1).padStart(2, "0")}`;
    db.history.push({ id, dateGenerated: date, ...item });
    ids.push(id);
  });

  db.byDate[date] = ids;
  db.sessionCompleted = [];
  db.sessionDiscarded = [];
  db.lastSessionDate = date;
  writeDB(db);
  return date;
}

/* ---------------------------------------------------------------------
   서버
--------------------------------------------------------------------- */
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

/* ---------------------------------------------------------------------
   간단한 비밀번호 잠금
   - .env 에 SITE_PASSWORD 를 설정하면 활성화됩니다.
   - 설정 안 하면(로컬 테스트 시) 그냥 통과 — 기존 동작과 동일합니다.
   - 정적 페이지(/, manifest.json, 아이콘 등)는 항상 200으로 열어두고,
     실제 문장 데이터를 주는 /api/* 요청만 비밀번호로 막습니다.
     (이래야 PWABuilder 같은 외부 크롤러도 앱을 정상적으로 인식합니다.)
--------------------------------------------------------------------- */
function requireAuth(req, res, next) {
  const pw = process.env.SITE_PASSWORD;
  if (!pw) return next();
  if (!req.path.startsWith("/api/")) return next();
  const token = req.cookies && req.cookies.nichi_auth;
  const db = readDB();
  if (token && db.authTokens.includes(token)) return next();
  return res.status(401).json({ error: "비밀번호 인증이 필요합니다." });
}
app.use(requireAuth);

app.get("/login", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>로그인 · 오늘의 일본어</title>
<link rel="manifest" href="/manifest.json">
<meta name="theme-color" content="#1B2A3B">
<link rel="icon" href="/icons/icon-192.png">
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
<style>
  body{font-family:'Noto Sans KR',sans-serif;background:#1B2A3B;color:#F7F3E7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px;}
  form{background:#F7F3E7;color:#201E1B;padding:32px;min-width:260px;display:flex;flex-direction:column;gap:12px;}
  h2{margin:0 0 8px;font-size:20px;}
  input{padding:11px;border:1px solid #ccc;font-size:15px;}
  button{padding:11px;background:#B8412F;color:#fff;border:none;font-weight:600;font-size:14px;cursor:pointer;}
  .err{color:#B8412F;font-size:13px;margin:0;}
</style></head>
<body>
  <form method="POST" action="/login">
    <h2>오늘의 일본어 문장</h2>
    <input type="password" name="password" placeholder="비밀번호" autofocus required />
    <button type="submit">입장</button>
    ${req.query.error ? '<p class="err">비밀번호가 틀렸어요.</p>' : ""}
  </form>
  <script>
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(()=>{});
    }
  </script>
</body></html>`);
});

app.post("/login", (req, res) => {
  const pw = process.env.SITE_PASSWORD;
  if (pw && req.body.password === pw) {
    const db = readDB();
    const token = crypto.randomBytes(32).toString("hex");
    db.authTokens.push(token);
    // 토큰이 무한정 쌓이지 않도록 최근 20개만 유지
    if (db.authTokens.length > 20) db.authTokens = db.authTokens.slice(-20);
    writeDB(db);
    res.cookie("nichi_auth", token, {
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 24 * 30, // 30일 유지
    });
    return res.redirect("/");
  }
  res.redirect("/login?error=1");
});

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/today", async (req, res) => {
  try {
    const db = readDB();
    const date = await ensureTodaysBatch(db);
    const fresh = readDB();
    const ids = fresh.byDate[date] || [];
    const sentences = ids
      .map((id) => fresh.history.find((h) => h.id === id))
      .filter(Boolean);

    res.json({
      date,
      dayIndex: Object.keys(fresh.byDate).sort().indexOf(date) + 1,
      sentences,
      sessionCompleted: fresh.sessionCompleted,
      sessionDiscarded: fresh.sessionDiscarded,
      totalGenerated: fresh.history.length,
      totalCompleted: fresh.completedAll.length,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/complete", (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: "id가 필요합니다." });
  const db = readDB();
  if (!db.sessionCompleted.includes(id)) db.sessionCompleted.push(id);
  if (!db.completedAll.includes(id)) db.completedAll.push(id);
  writeDB(db);
  res.json({ ok: true });
});

app.post("/api/discard", (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: "id가 필요합니다." });
  const db = readDB();
  if (!db.sessionDiscarded.includes(id)) db.sessionDiscarded.push(id);
  if (!db.discardedAll.includes(id)) db.discardedAll.push(id);
  writeDB(db);
  res.json({ ok: true });
});

app.post("/api/reset-discard", (req, res) => {
  const db = readDB();
  db.sessionDiscarded = [];
  writeDB(db);
  res.json({ ok: true });
});

app.get("/api/export", (req, res) => {
  const db = readDB();
  const lines = db.completedAll
    .map((id) => {
      const s = db.history.find((h) => h.id === id);
      return s ? `${s.jp} - ${s.kr}` : null;
    })
    .filter(Boolean);
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    'attachment; filename="nichi-phrase.txt"'
  );
  res.send(lines.join("\n"));
});

// 개발/테스트용: 실제 하루를 기다리지 않고 다음 날짜로 강제 이동
// (호출 시 Claude API가 1회 호출되어 비용이 발생합니다)
app.post("/api/dev/advance-date", async (req, res) => {
  try {
    const db = readDB();
    const base = db.devDateOverride
      ? new Date(db.devDateOverride + "T00:00:00")
      : new Date();
    base.setDate(base.getDate() + 1);
    db.devDateOverride = base.toISOString().slice(0, 10);
    writeDB(db);
    res.json({ ok: true, date: db.devDateOverride });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 테스트용 날짜 이동을 실제 오늘 날짜로 되돌림 (Claude API 호출 없음, 비용 없음)
app.post("/api/dev/reset-date", (req, res) => {
  const db = readDB();
  db.devDateOverride = null;
  writeDB(db);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`✅ Nichi Phrase 서버 실행 중: http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn(
      "⚠️  ANTHROPIC_API_KEY가 설정되지 않았습니다. .env 파일을 만들고 키를 넣어주세요 (.env.example 참고)."
    );
  }
});
