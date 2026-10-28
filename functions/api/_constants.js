// functions/api/_constants.js

// 매수 관점(미보유): 매수/관망/보류만 존재
export const VALID_RECS_BUY = ['매수 추천', '매수 고려', '기다리기', '판단 보류'];

// 매도 관점(보유): 매도/보유/추가매수/보류
export const VALID_RECS_SELL = ['매도 추천', '부분 매도 고려', '보유 유지', '추가 매수 고려', '매수 추천', '판단 보류'];

// ★ 모델 구성 최적화
// - 뉴스/추세: Llama 3.1 8B Fast (가장 저렴하고 빠름)
// - 심판: Qwen 3 30B MoE (뉴런 소모는 8B와 유사하면서 추론 능력이 우수함)
export const MODELS = {
  price_volume: '@cf/meta/llama-3.1-8b-instruct-fast', // 코드로 대체되어 미사용
  news: '@cf/meta/llama-3.1-8b-instruct-fast',
  trend: '@cf/meta/llama-3.1-8b-instruct-fast',
  judge: '@cf/qwen/qwen3-30b-a3b-fp8', 
};