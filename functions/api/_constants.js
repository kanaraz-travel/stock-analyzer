// functions/api/_constants.js

// 매수 관점(미보유): 매수/관망/보류만 존재
export const VALID_RECS_BUY = ['매수 추천', '매수 고려', '기다리기', '판단 보류'];

// 매도 관점(보유): 매도/보유/추가매수/보류
export const VALID_RECS_SELL = ['매도 추천', '부분 매도 고려', '보유 유지', '추가 매수 고려', '매수 추천', '판단 보류'];

// ★ 무료 뉴런 소모를 최소화하기 위해 모든 에이전트를 Llama 3.1 8B 모델로 통일
export const MODELS = {
  price_volume: '@cf/meta/llama-3.1-8b-instruct',
  news: '@cf/meta/llama-3.1-8b-instruct',
  trend: '@cf/meta/llama-3.1-8b-instruct', 
  judge: '@cf/meta/llama-3.1-8b-instruct',
};