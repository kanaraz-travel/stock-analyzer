// functions/api/_constants.js
export const VALID_RECS_BUY = ['매수 추천', '매수 고려', '기다리기', '매도 고려', '매도 추천', '판단 보류'];
export const VALID_RECS_SELL = ['매도 추천', '부분 매도 고려', '보유 유지', '추가 매수 고려', '매수 추천', '판단 보류'];

// 뉴런 절약을 위한 에이전트별 모델 분리
// (추후 A/B 테스트를 통해 4번도 8b로 내릴 수 있음)
export const MODELS = {
  price_volume: '@cf/meta/llama-3.1-8b-instruct', // 이제 코드로 대체되지만 호환용
  news: '@cf/meta/llama-3.1-8b-instruct',
  trend: '@cf/meta/llama-3.1-8b-instruct',
  judge: '@cf/meta/llama-3.3-70b-instruct-fp8-fast'
};