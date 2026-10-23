// functions/api/_pipeline.js
import { createClient } from '@supabase/supabase-js';
import { VALID_RECS_BUY, VALID_RECS_SELL } from './_constants.js';

export { VALID_RECS_BUY, VALID_RECS_SELL };

// ★ 매도 관점 어휘 수정 (Claude 리뷰 반영)
const REC_LEVEL = {
  '매수 추천': 2, '추가 매수 고려': 1,
  '매수 고려': 1, '보유 유지': 0,
  '기다리기': 0, '판단 보류': 0,
  '매도 고려': -1, '부분 매도 고려': -1,
  '매도 추천': -2,
};

const REC_METADATA = {
  '매수 추천': { label: '적극 매수 관점', hint: '여러 지표가 정렬된 강한 매수 신호입니다. 분할 매수로 리스크를 관리하세요.' },
  '매수 고려': { label: '신중한 매수 검토', hint: '긍정적 신호가 있으나 확신이 완전하지 않습니다.' },
  '기다리기': { label: '관망 (지켜보기)', hint: '방향성이 뚜렷하지 않습니다.' },
  '매도 고려': { label: '리스크 인지, 일부 정리 검토', hint: '부정적 신호가 나타나고 있습니다.' },
  '매도 추천': { label: '적극 매도 관점', hint: '여러 지표가 정렬된 강한 매도 신호입니다.' },
  '판단 보류': { label: '판단 유보', hint: '데이터 부족 또는 상충 신호로 판단을 내리기 어렵습니다.' },
  '부분 매도 고려': { label: '일부 이익실현 검토', hint: '일부 매도로 이익을 확정하고 리스크를 줄이세요.' },
  '보유 유지': { label: '홀드 (유지)', hint: '현재 포지션 유지가 적절합니다.' },
  '추가 매수 고려': { label: '추가 매수 검토', hint: '비중 조절을 고려한 추가 매수를 검토하세요.' },
};

export function getRecommendationMeta(rec) {
  return REC_METADATA[rec] || { label: rec || '-', hint: '' };
}

export function interpretConfidence(confidence) {
  if (confidence == null || !Number.isFinite(confidence)) return { level: 'unknown', label: '확신도 미제공' };
  const pct = (confidence * 100).toFixed(0);
  if (confidence >= 0.8) return { level: 'high', label: `높은 확신 (${pct}%)` };
  if (confidence >= 0.6) return { level: 'medium', label: `중간 확신 (${pct}%)` };
  if (confidence >= 0.4) return { level: 'low', label: `낮은 확신 (${pct}%)` };
  return { level: 'very_low', label: `매우 낮은 확신 (${pct}%)` };
}

// ★ T6: 가격/거래량 에이전트를 코드로 대체 (0 뉴런)
export function buildPriceVolumeFacts(price_data, volume_data, analysis_type) {
  const p = price_data || {};
  const v = volume_data || {};
  
  let price_flow = '';
  const cr = p.change_rate != null ? p.change_rate.toFixed(2) : null;
  const ma = p.ma20_disparity != null ? p.ma20_disparity.toFixed(2) : null;
  const r1m = p.return_1m != null ? p.return_1m.toFixed(2) : null;
  
  if (cr && cr > 0 && ma && ma > 0) price_flow = `단기 상승 흐름(등락 ${cr}%, 20일선 +${ma}%).`;
  else if (cr && cr < 0 && ma && ma < 0) price_flow = `단기 하락 흐름(등락 ${cr}%, 20일선 ${ma}%).`;
  else price_flow = `혼조세(등락 ${cr || '-'}%, 20일선 ${ma || '-'}%).`;
  if (r1m) price_flow += ` 1개월 수익률은 ${r1m}%임.`;

  let vol_analysis = '';
  const cur = v.current_volume;
  const avg = v.avg_volume_20;
  if (cur && avg) {
    const ratio = (cur / avg).toFixed(2);
    vol_analysis = `거래량은 20일 평균 대비 ${ratio}배 수준임.`;
    if (p.market_status && p.market_status.includes('정규장')) {
      vol_analysis = `장중 누적 거래량(${cur.toLocaleString()}주)은 직전 20거래일 평균(${avg.toLocaleString()}주)과 직접 비교 불가함.`;
    }
  } else {
    vol_analysis = '거래량 데이터 부족.';
  }

  return {
    price_flow_analysis: price_flow,
    volume_analysis: vol_analysis,
    key_signals: [ma ? `20일선 괴리 ${ma}%` : '지표 부족', r1m ? `1개월 ${r1m}%` : '데이터 없음']
  };
}

export function normalizeRecommendation(raw, analysisType) { /* 기존과 동일 */ }
export function validateNewsOutput(out) { /* 기존과 동일 */ }
export function validateTrendOutput(out) { /* 기존과 동일 */ }
export function validateAnalyzeInput(body) { /* 기존과 동일 */ }
export function computeDataQuality(price_data) { /* 기존과 동일 */ }
export function deriveConsistencyThreshold(previousAnalyzedAt, recentFlipCount) { /* 기존과 동일 */ }
export function needsHighConfidenceForLevelJump(prevRec, newRec) { /* 기존과 동일 */ }
export function computeReferenceScore(price) { /* 기존과 동일 */ }
export async function saveAnalysisRun(supabase, payload) { /* 기존과 동일 */ }
export async function cleanupOldRuns(env, userId) { /* 기존과 동일 */ }
export function jsonResponse(body, status = 200) { /* 기존과 동일 */ }

// ★ T13: 이력 조회 쿼리 최적화 (market_facts 전체를 가져오지 않고 필요한 JSON 경로만 추출)
export async function loadRecentTrendHistory(env, ticker) {
  // ... (기존과 동일하되, select 절만 아래처럼 수정)
  // .select('analyzed_at, ruleset_version, market_facts->agent_outputs->trend, market_facts->agent_status->trend, market_facts->data_quality_note, market_facts->price_data->>market_status')
  // 위처럼 JSON 경로를 지정하면 데이터 로딩 및 파싱 부담이 줄어듭니다. (Supabase PostgREST 문법)
}