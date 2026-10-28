// functions/api/_constants.js

// 매수 관점(미보유): 매수/관망/보류만 존재
export const VALID_RECS_BUY = ['매수 추천', '매수 고려', '기다리기', '판단 보류'];

// 매도 관점(보유): 매도/보유/추가매수/보류
export const VALID_RECS_SELL = ['매도 추천', '부분 매도 고려', '보유 유지', '추가 매수 고려', '매수 추천', '판단 보류'];

// ★ [롤백] Qwen 30B에서 문제가 발생할 경우, 모든 에이전트를 Llama 3.1 8B Fast로 되돌립니다.
export const MODELS = {
  price_volume: '@cf/meta/llama-3.1-8b-instruct-fast',
  news: '@cf/meta/llama-3.1-8b-instruct-fast',
  trend: '@cf/meta/llama-3.1-8b-instruct-fast',
  judge: '@cf/meta/llama-3.1-8b-instruct-fast',
};