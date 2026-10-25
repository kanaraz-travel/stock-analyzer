// functions/api/_constants.js

// 매수 관점(미보유): 매수/관망/보류만 존재
export const VALID_RECS_BUY = ['매수 추천', '매수 고려', '기다리기', '판단 보류'];

// 매도 관점(보유): 매도/보유/추가매수/보류
export const VALID_RECS_SELL = ['매도 추천', '부분 매도 고려', '보유 유지', '추가 매수 고려', '매수 추천', '판단 보류'];

// ★ 모델 구성 최신화
//    - 뉴스: Llama 3.1 8B (정상)
//    - 추세: Qwen 1.5 7B는 폐기됨 → Qwen 3 8B로 교체
//    - 심판: Qwen 3 30B (정상)
export const MODELS = {
  price_volume: '@cf/meta/llama-3.1-8b-instruct', // 코드로 대체되어 미사용
  news: '@cf/meta/llama-3.1-8b-instruct',
  trend: '@cf/qwen/qwen3-8b',
  judge: '@cf/qwen/qwen3-30b-a3b-fp8',
};