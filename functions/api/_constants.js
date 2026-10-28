export const VALID_RECS_BUY = ['매수 추천', '매수 고려', '기다리기', '판단 보류'];
export const VALID_RECS_SELL = ['매도 추천', '매도 고려', '부분 매도 고려', '보유 유지', '추가 매수 고려', '판단 보류'];
export const MODELS = {
  price_volume: '@cf/meta/llama-3.1-8b-instruct-fast',
  news: '@cf/meta/llama-3.1-8b-instruct-fast',
  trend: '@cf/meta/llama-3.1-8b-instruct-fast',
  judge: '@cf/qwen/qwen3-30b-a3b-fp8', 
};