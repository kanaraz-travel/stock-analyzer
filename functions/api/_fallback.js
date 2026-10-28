// functions/api/_fallback.js
export function buildRuleBasedFallback({ price_data, volume_data, analysis_type, trendResult }) {
  const p = price_data || {};
  let score = 0;

  if (p.ma20_disparity > 2) score += 1;
  else if (p.ma20_disparity < -2) score -= 1;

  if (p.return_1m > 5) score += 1;
  else if (p.return_1m < -5) score -= 1;

  if (p.change_rate > 2) score += 1;
  else if (p.change_rate < -2) score -= 1;

  if (p.w52_hgpr && p.w52_lwpr && p.current_price) {
    const pos = ((p.current_price - p.w52_lwpr) / (p.w52_hgpr - p.w52_lwpr)) * 100;
    if (pos > 80) score += 1;
    else if (pos < 20) score -= 1;
  }

  if (trendResult) {
    if (trendResult.short_term_trend === '상승') score += 1;
    if (trendResult.short_term_trend === '하락') score -= 1;
  }

  let recommendation = '판단 보류';
  const isSell = analysis_type === 'sell';

  if (isSell) {
    // 매도 관점 (보유 중)
    if (score >= 2) recommendation = '보유 유지';
    else if (score <= -2) recommendation = '매도 고려';
    else recommendation = '보유 유지';
  } else {
    // 매수 관점 (미보유)
    if (score >= 2) recommendation = '매수 고려';
    else if (score <= -2) recommendation = '기다리기';
    else recommendation = '기다리기';
  }

  const parts = [];
  if (p.change_rate != null && Number.isFinite(p.change_rate)) parts.push(`당일 ${p.change_rate.toFixed(2)}%`);
  if (p.ma20_disparity != null && Number.isFinite(p.ma20_disparity)) parts.push(`20일선 대비 ${p.ma20_disparity.toFixed(2)}%`);
  if (p.return_1m != null && Number.isFinite(p.return_1m)) parts.push(`1개월 ${p.return_1m.toFixed(2)}%`);
  const dataStr = parts.length > 0 ? parts.join(', ') : '지표 데이터 부족';

  const overall_summary = `[임시 판단] AI 분석을 진행할 수 없어 수집된 수치 지표만으로 산출한 참고용 결과입니다. ${dataStr} 등을 종합한 결과입니다. AI 없이 지표만으로 판단한 것이므로 투자에 주의하시기 바랍니다.`;

  return { recommendation, overall_summary, fallback_kind: 'RULE_BASED' };
}