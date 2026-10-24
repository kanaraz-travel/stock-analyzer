// functions/api/_constants.js

// 매수 관점(미보유): 매수/관망/보류만 존재
export const VALID_RECS_BUY = ['매수 추천', '매수 고려', '기다리기', '판단 보류'];

// 매도 관점(보유): 매도/보유/추가매수/보류
export const VALID_RECS_SELL = ['매도 추천', '부분 매도 고려', '보유 유지', '추가 매수 고려', '매수 추천', '판단 보류'];

// ⚠️ 아래 news/trend 모델은 2026-05-30 Cloudflare 폐기 목록에 포함됨.
//    교체 여부는 기획자(사용자) 결정 후 이 파일의 문자열만 변경하면 됨.
//    후보: @cf/meta/llama-3.1-8b-instruct-fast, @cf/google/gemma-4-26b-a4b-it
export const MODELS = {
  price_volume: '@cf/meta/llama-3-8b-instruct', // 코드로 대체되어 미사용
  news: '@cf/meta/llama-3-8b-instruct',          // ⚠️ 폐기됨
  trend: '@cf/meta/llama-3-8b-instruct',         // ⚠️ 폐기됨
  judge: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', // 유지됨
};