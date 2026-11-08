// functions/api/_constants.js

// 매수 관점(미보유): 매수/관망/보류만 존재
export const VALID_RECS_BUY = ['매수 추천', '매수 고려', '기다리기', '판단 보류'];

// 매도 관점(보유): 매도/보유/추가매수/보류
export const VALID_RECS_SELL = ['매도 추천', '매도 고려', '부분 매도 고려', '보유 유지', '추가 매수 고려', '판단 보류'];

// ★ 모델 구성 최적화 (2026년 11월 20일 폐기 일정 대응)
// - 뉴스/추세: Llama 3.1 8B Fast (가장 저렴하고 빠름, 유지)
// - 심판: Qwen 3.8 27B (기존 Qwen 3 30B 폐기에 따른 공식 대체 모델)
//   · 27B 파라미터, 262,144 토큰 컨텍스트 윈도우
//   · Reasoning(추론), Function calling, Vision 지원
//   · 가격: 입력 $0.45/M, 출력 $3.20/M (Qwen 3 30B MoE와 유사한 비용 효율)
export const MODELS = {
  price_volume: '@cf/meta/llama-3.1-8b-instruct-fast',
  news: '@cf/meta/llama-3.1-8b-instruct-fast',
  trend: '@cf/meta/llama-3.1-8b-instruct-fast',
  judge: '@cf/qwen/qwen3.8-27b', // 👈 폐기 예정인 qwen3-30b-a3b-fp8에서 교체
};