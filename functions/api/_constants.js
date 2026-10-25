// functions/api/_constants.js

// 매수 관점(미보유): 매수/관망/보류만 존재
export const VALID_RECS_BUY = ['매수 추천', '매수 고려', '기다리기', '판단 보류'];

// 매도 관점(보유): 매도/보유/추가매수/보류
export const VALID_RECS_SELL = ['매도 추천', '부분 매도 고려', '보유 유지', '추가 매수 고려', '매수 추천', '판단 보류'];

// ★ 모델 구성: 뉴스=Llama 3.1 8B, 추세=Qwen 3.8 27B, 심판=Llama 3.3 70B
//    - Qwen 3.8 27B: @cf/qwen/qwen3.8-27b (262K 컨텍스트, 입력 $0.45/1M, 출력 $3.20/1M)
//    - Llama 3.3 70B: @cf/meta/llama-3.3-70b-instruct-fp8-fast (심판용 대형 모델)
export const MODELS = {
  price_volume: '@cf/meta/llama-3.1-8b-instruct', // 코드로 대체되어 미사용
  news: '@cf/meta/llama-3.1-8b-instruct',
  trend: '@cf/qwen/qwen3.8-27b',
  judge: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
};