// functions/api/_fallback.js
export function buildRuleBasedFallback({ price_data, volume_data, analysis_type, trendResult }) {
  const p = price_data || {};
  let score = 0;

  // 1. 20일선 괴리
  if (p.ma20_disparity > 2) score += 1;
  else if (p.ma20_disparity < -2) score -= 1;

  // 2. 1개월 수익률
  if (p.return_1m > 5) score += 1;
  else if (p.return_1m < -5) score -= 1;

  // 3. 당일 등락률
  if (p.change_rate > 2) score += 1;
  else if (p.change_rate < -2) score -= 1;

  // 4. 52주 위치
  if (p.w52_hgpr && p.w52_lwpr && p.current_price) {
    const pos = ((p.current_price - p.w52_lwpr) / (p.w52_hgpr - p.w52_lwpr)) * 100;
    if (pos > 80) score += 1;
    else if (pos < 20) score -= 1;
  }

  // 5. 추세 보정 (심판만 실패한 경우)
  if (trendResult) {
    if (trendResult.short_term_trend === '상승') score += 1;
    if (trendResult.short_term_trend === '하락') score -= 1;
  }

  let recommendation = '판단 보류';
  const isSell = analysis_type === 'sell';

  if (score >= 2) recommendation = isSell ? '보유 유지' : '매수 고려';
  else if (score <= -2) recommendation = isSell ? '부분 매도 고려' : '매도 고려';
  else recommendation = isSell ? '보유 유지' : '기다리기';

  const changeStr = p.change_rate != null ? `당일 ${p.change_rate.toFixed(2)}%` : '등락률 미확인';
  const ma20Str = p.ma20_disparity != null ? `20일선 대비 ${p.ma20_disparity.toFixed(2)}%` : '';
  const returnStr = p.return_1m != null ? `1개월 ${p.return_1m.toFixed(2)}%` : '';

  const overall_summary = `[임시 판단] AI 분석을 진행할 수 없어 수집된 수치 지표만으로 산출한 참고용 결과입니다. ${changeStr}, ${ma20Str}, ${returnStr} 등을 종합한 결과입니다. AI 없이 지표만으로 판단한 것이므로 투자에 주의하시기 바랍니다.`;

  return { recommendation, overall_summary, fallback_kind: 'RULE_BASED' };
}