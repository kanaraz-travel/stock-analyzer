// functions/api/_constants.js

// 매수 관점(미보유): 매수/관망/보류만 존재
export const VALID_RECS_BUY = ['매수 추천', '매수 고려', '기다리기', '판단 보류'];

// 매도 관점(보유): 매도/보유/추가매수/보류
export const VALID_RECS_SELL = ['매도 추천', '부분 매도 고려', '보유 유지', '추가 매수 고려', '매수 추천', '판단 보류'];

// ★ 폐기된 Llama 3.1 8B 대신, 현재 Cloudflare Workers AI에서 무료로 정상 지원되는 Llama 3.3 70B 모델로 통일
//    (추론 성능도 뛰어나며, 안정적으로 동작합니다.)
export const MODELS = {
  price_volume: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', // 코드로 대체되어 미사용
  news: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  trend: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  judge: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
};