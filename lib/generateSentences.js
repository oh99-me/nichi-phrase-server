const CATEGORIES = ["travel", "daily", "intermediate"];

/**
 * Claude API를 호출해 새 일본어 학습 문장을 생성합니다.
 * @param {Object} opts
 * @param {string[]} opts.excludeJp - 이미 사용된 일본어 문장 목록 (반복 방지용)
 * @param {number} opts.count - 생성할 문장 개수
 * @returns {Promise<Array>} 생성된 문장 객체 배열
 */
async function generateSentences({ excludeJp = [], count = 10 }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY가 설정되지 않았습니다. .env 파일에 키를 추가해주세요."
    );
  }
  const model = process.env.CLAUDE_MODEL || "claude-sonnet-5";

  // 프롬프트가 너무 길어지지 않도록 최근 150개만 "제외 목록"으로 전달
  const excludeSample = excludeJp.slice(-150);

  const system =
    "당신은 일본어 학습 앱을 위한 문장 생성기입니다. " +
    "반드시 지정된 JSON 배열 형식으로만 응답하세요. " +
    "설명, 인사말, 마크다운 코드펜스(```) 등 JSON 이외의 텍스트는 절대 포함하지 마세요.";

  const user = `아래 조건에 맞는 표준 일본어 학습 문장 ${count}개를 새로 만들어 주세요.

조건:
- 카테고리는 travel(여행), daily(일상), intermediate(중급) 3가지를 사용할 것. advanced(고급)는 더 이상 사용하지 않음.
- 전체 ${count}개 중 절반 이상은 travel(여행) 카테고리로 만들 것 (공항, 숙소, 식당, 길찾기, 쇼핑 등 실전 여행 상황 위주). 나머지는 daily와 intermediate를 섞어서 구성.
- "제외 목록"에 있는 문장과 표현·의미가 겹치지 않는, 완전히 새로운 문장일 것
- 각 항목은 다음 필드를 가진 JSON 객체:
  - category: travel|daily|intermediate 중 하나
  - jp: 일본어 문장 (한자+가나 혼용, 표준 문어체)
  - reading: 히라가나로만 표기한 읽는 법
  - kr: 자연스러운 한국어 뜻
  - tags: 한국어 키워드 1~3개 배열
- 출력은 그 객체 ${count}개로 이루어진 JSON 배열 하나뿐이어야 합니다. 다른 텍스트는 금지.

제외 목록 (이미 사용됨 — 절대 반복하거나 유사 표현으로 재생성하지 말 것):
${excludeSample.length ? excludeSample.join("\n") : "(아직 없음)"}
`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      // 일본어/한국어는 토큰을 많이 소모하므로 여유 있게 설정 (JSON 응답 잘림 방지)
      max_tokens: Number(process.env.CLAUDE_MAX_TOKENS) || 4000,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Claude API 오류 (HTTP ${res.status}): ${errText}`);
  }

  const data = await res.json();
  const textBlock = (data.content || []).find((b) => b.type === "text");
  if (!textBlock) {
    throw new Error("Claude 응답에서 텍스트 블록을 찾을 수 없습니다.");
  }
  if (data.stop_reason === "max_tokens") {
    throw new Error(
      "Claude 응답이 max_tokens 한도에 걸려 중간에 잘렸습니다. " +
        ".env의 CLAUDE_MAX_TOKENS 값을 더 올려주세요 (예: 6000)."
    );
  }

  let jsonStr = textBlock.text.trim();
  // 혹시 모델이 코드펜스를 붙였을 경우 제거
  jsonStr = jsonStr
    .replace(/^```json/i, "")
    .replace(/^```/, "")
    .replace(/```$/, "")
    .trim();

  let arr;
  try {
    arr = JSON.parse(jsonStr);
  } catch (e) {
    throw new Error(
      `Claude 응답 JSON 파싱 실패: ${e.message}\n원문 일부: ${jsonStr.slice(0, 300)}`
    );
  }
  if (!Array.isArray(arr)) {
    throw new Error("Claude 응답이 배열 형식이 아닙니다.");
  }

  return arr
    .filter((item) => item && typeof item.jp === "string" && item.jp.trim())
    .map((item) => ({
      category: CATEGORIES.includes(item.category) ? item.category : "daily",
      jp: item.jp.trim(),
      reading: typeof item.reading === "string" ? item.reading.trim() : "",
      kr: typeof item.kr === "string" ? item.kr.trim() : "",
      tags: Array.isArray(item.tags) ? item.tags.slice(0, 3) : [],
    }));
}

module.exports = { generateSentences, CATEGORIES };
