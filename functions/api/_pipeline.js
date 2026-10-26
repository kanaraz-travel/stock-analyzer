// functions/api/_pipeline.js
import { createClient } from '@supabase/supabase-js';
import { VALID_RECS_BUY, VALID_RECS_SELL } from './_constants.js';

export { VALID_RECS_BUY, VALID_RECS_SELL };

// ... (REC_LEVEL, REC_METADATA, getRecommendationMeta, interpretConfidence, getFallbackMessage, buildPriceVolumeFacts, normalizeRecommendation, validateNewsOutput, validateTrendOutput, validateAnalyzeInput, computeDataQuality, deriveConsistencyThreshold, needsHighConfidenceForLevelJump, computeReferenceScore, cleanupOldRuns, jsonResponse, loadRecentTrendHistory, summarizeTrendHistory 함수는 이전과 동일하므로 생략하지 않고 전체 코드에 포함합니다.)

const REC_LEVEL = {
  '매수 추천': 2, '추가 매수 고려': 1,
  '매수 고려': 1, '보유 유지': 0,
  '기다리기': 0, '판단 보류': 0,
  '매도 고려': -1, '부분 매도 고려': -1,
  '매도 추천': -2,
};

const REC_METADATA = {
  '매수 추천': { label: '적극 매수 관점', hint: '여러 지표가 정렬된 강한 매수 신호입니다.' },
  '매수 고려': { label: '신중한 매수 검토', hint: '긍정적 신호가 있으나 확신이 완전하지 않습니다.' },
  '기다리기': { label: '관망 (지켜보기)', hint: '방향성이 뚜렷하지 않습니다.' },
  '매도 고려': { label: '리스크 인지, 일부 정리 검토', hint: '부정적 신호가 나타나고 있습니다.' },
  '매도 추천': { label: '적극 매도 관점', hint: '여러 지표가 정렬된 강한 매도 신호입니다.' },
  '판단 보류': { label: '판단 유보', hint: '데이터 부족 또는 상충 신호입니다.' },
  '부분 매도 고려': { label: '일부 이익실현 검토', hint: '일부 매도로 리스크를 줄이세요.' },
  '보유 유지': { label: '홀드 (유지)', hint: '현재 포지션 유지가 적절합니다.' },
  '추가 매수 고려': { label: '추가 매수 검토', hint: '비중 조절을 고려하세요.' },
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

export function getFallbackMessage(reason) {
  if (reason === 'AI_QUOTA_EXCEEDED') return '⚠️ 오늘 AI 무료 한도를 모두 사용했습니다. 한국시간 오전 9시 이후 다시 시도해 주세요.';
  if (reason === 'AI_MODEL_DEPRECATED') return '⚠️ AI 모델 설정에 문제가 있어 임시 판단을 제공합니다. 관리자에게 알려 주세요.';
  if (reason === 'CRITICAL_AGENT_FAILURE') return '⚠️ 핵심 분석 에이전트가 실패하여 임시 판단을 제공합니다. 잠시 후 다시 시도해 주세요.';
  if (reason === 'JUDGE_FAILED') return '⚠️ AI 판단 응답을 해석하지 못했습니다. 잠시 후 다시 시도해 주세요.';
  if (reason === 'JUDGE_INVALID_REC') return '⚠️ AI가 유효하지 않은 판단 등급을 반환했습니다. 잠시 후 다시 시도해 주세요.';
  if (reason === 'AI_ERROR' || reason === 'AI_NOT_CONFIGURED') return '⚠️ AI 서비스에 일시적 오류가 발생했습니다.';
  if (reason === 'DATA_INSUFFICIENT') return '⚠️ 시세 기준 시각을 확인할 수 없습니다.';
  return '⚠️ AI 분석 대신 수치 지표로 임시 판단을 제공합니다.';
}

export function buildPriceVolumeFacts(price_data, volume_data, analysis_type) {
  const p = price_data || {};
  const v = volume_data || {};
  const cr = p.change_rate != null ? p.change_rate.toFixed(2) : null;
  const ma = p.ma20_disparity != null ? p.ma20_disparity.toFixed(2) : null;
  const r1m = p.return_1m != null ? p.return_1m.toFixed(2) : null;

  let w52Pos = null;
  if (p.w52_hgpr && p.w52_lwpr && p.current_price && p.w52_hgpr > p.w52_lwpr) {
    w52Pos = ((p.current_price - p.w52_lwpr) / (p.w52_hgpr - p.w52_lwpr)) * 100;
  }

  let price_flow = '';
  if (cr && cr > 0 && ma && ma > 0) price_flow = `단기 상승 흐름(등락 ${cr}%, 20일선 +${ma}%).`;
  else if (cr && cr < 0 && ma && ma < 0) price_flow = `단기 하락 흐름(등락 ${cr}%, 20일선 ${ma}%).`;
  else price_flow = `혼조세(등락 ${cr || '-'}%, 20일선 ${ma || '-'}%).`;
  if (r1m) price_flow += ` 1개월 수익률 ${r1m}%.`;
  if (w52Pos != null) price_flow += ` 52주 밴드 내 ${w52Pos.toFixed(1)}% 위치.`;

  let vol_analysis = '';
  const cur = v.current_volume;
  const avg = v.avg_volume_20;
  const isMarketClosed = String(p.market_status || '').includes('휴장') || String(p.market_status || '').includes('마감');

  if (cur && avg) {
    if (String(p.market_status || '').includes('정규장')) {
      vol_analysis = `장중 누적 거래량(${cur.toLocaleString()}주)은 직전 20거래일 평균(${avg.toLocaleString()}주)과 직접 비교 불가.`;
    } else if (isMarketClosed) {
      vol_analysis = `장 마감 기준 거래량(${cur.toLocaleString()}주)은 20일 평균 대비 ${(cur / avg).toFixed(2)}배 수준.`;
    } else {
      vol_analysis = `거래량은 20일 평균 대비 ${(cur / avg).toFixed(2)}배 수준.`;
    }
  } else {
    vol_analysis = '거래량 데이터 부족.';
  }

  return {
    price_flow_analysis: price_flow,
    volume_analysis: vol_analysis,
    key_signals: [ma ? `20일선 괴리 ${ma}%` : '지표 부족', r1m ? `1개월 ${r1m}%` : '-'],
  };
}

export function normalizeRecommendation(raw, analysisType) {
  if (raw && typeof raw === 'object') raw = raw.recommendation || raw.label || raw.value || raw.action || '';
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(/\s+/g, '').replace(/[^\w가-힣]/g, '');
  if (!cleaned) return null;
  const validRecs = analysisType === 'sell' ? VALID_RECS_SELL : VALID_RECS_BUY;
  const cleanRec = (r) => r.replace(/\s+/g, '').replace(/[^\w가-힣]/g, '');
  for (const rec of validRecs) {
    if (cleanRec(rec) === cleaned) return rec;
  }
  return null;
}

export function validateNewsOutput(out) {
  if (!out || typeof out !== 'object') return { valid: false, reason: 'NOT_OBJECT' };
  if (out.status === 'error') return { valid: false, reason: 'AGENT_ERROR' };
  if (typeof out.news_analysis !== 'string' || !out.news_analysis.trim()) return { valid: false, reason: 'MISSING_ANALYSIS' };
  return { valid: true, reason: null };
}

export function validateTrendOutput(out) {
  if (!out || typeof out !== 'object') return { valid: false, reason: 'NOT_OBJECT' };
  if (!['상승', '횡보', '하락'].includes(out.short_term_trend)) return { valid: false, reason: 'INVALID_SHORT_TERM' };
  if (!['상승', '횡보', '하락'].includes(out.medium_term_trend)) return { valid: false, reason: 'INVALID_MEDIUM_TERM' };
  if (!['강', '중', '약'].includes(out.trend_strength)) return { valid: false, reason: 'INVALID_STRENGTH' };
  if (typeof out.trend_confidence !== 'number' || !Number.isFinite(out.trend_confidence)
      || out.trend_confidence < 0 || out.trend_confidence > 1) return { valid: false, reason: 'INVALID_CONFIDENCE' };
  return { valid: true, reason: null };
}

export function validateAnalyzeInput(body) {
  const errors = [];
  if (!body || typeof body !== 'object') return { valid: false, errors: ['본문이 객체가 아닙니다.'] };
  const { ticker, stock_name, price_data, volume_data, news_items, analysis_type } = body;
  if (typeof ticker !== 'string' || !/^[0-9A-Z]{6}$/i.test(ticker)) errors.push('ticker 형식 오류.');
  if (typeof stock_name !== 'string' || stock_name.length === 0 || stock_name.length > 50) errors.push('stock_name 오류.');
  if (analysis_type != null && !['buy', 'sell'].includes(analysis_type)) errors.push('analysis_type 오류.');
  if (!price_data || typeof price_data !== 'object') errors.push('price_data 누락.');
  else {
    const { current_price, change_rate, return_1m, ma20_disparity, w52_hgpr, w52_lwpr, quote_as_of, server_time, price_source } = price_data;
    if (current_price == null || !Number.isFinite(current_price) || current_price <= 0) errors.push('current_price 오류.');
    if (change_rate != null && !Number.isFinite(change_rate)) errors.push('change_rate 오류.');
    if (return_1m != null && !Number.isFinite(return_1m)) errors.push('return_1m 오류.');
    if (ma20_disparity != null && !Number.isFinite(ma20_disparity)) errors.push('ma20_disparity 오류.');
    if (w52_hgpr != null && (!Number.isFinite(w52_hgpr) || w52_hgpr < 0)) errors.push('w52_hgpr 오류.');
    if (w52_lwpr != null && (!Number.isFinite(w52_lwpr) || w52_lwpr < 0)) errors.push('w52_lwpr 오류.');
    if (quote_as_of != null && isNaN(new Date(quote_as_of).getTime())) errors.push('quote_as_of 오류.');
    if (server_time != null && isNaN(new Date(server_time).getTime())) errors.push('server_time 오류.');
    if (price_source != null && !['FRESH', 'STALE'].includes(price_source)) errors.push('price_source 오류.');
  }
  if (volume_data != null) {
    if (typeof volume_data !== 'object') errors.push('volume_data 형식 오류.');
    else {
      const { current_volume, avg_volume_20 } = volume_data;
      if (current_volume != null && (!Number.isFinite(current_volume) || current_volume < 0)) errors.push('current_volume 오류.');
      if (avg_volume_20 != null && (!Number.isFinite(avg_volume_20) || avg_volume_20 < 0)) errors.push('avg_volume_20 오류.');
    }
  }
  if (news_items != null) {
    if (!Array.isArray(news_items)) errors.push('news_items 배열 아님.');
    else if (news_items.length > 30) errors.push('news_items 30개 초과.');
  }
  return { valid: errors.length === 0, errors };
}

export function computeDataQuality(price_data) {
  const marketStatus = price_data?.market_status || '';
  const serverTimeStr = price_data?.server_time || null;
  const quoteTimeStr = price_data?.quote_as_of || null;
  const now = Date.now();
  if (price_data?.price_source === 'STALE') return { status: 'STALE', label: '시세 재조회 실패 (이전 가격)', quote_time_verified: false };
  if (quoteTimeStr) {
    const qt = new Date(quoteTimeStr).getTime();
    if (!isNaN(qt)) {
      if (qt > now + 5 * 60 * 1000) return { status: 'UNKNOWN', label: '미래 시각', quote_time_verified: false };
      const ageMin = Math.max(0, (now - qt) / 60000);
      if (ageMin > 60) return { status: 'STALE', label: '오래된 데이터', quote_time_verified: true };
      if (ageMin > 10) return { status: 'DELAYED', label: '지연된 데이터', quote_time_verified: true };
      return { status: 'OK', label: '정상', quote_time_verified: true };
    }
  }
  if (serverTimeStr) {
    const st = new Date(serverTimeStr).getTime();
    if (!isNaN(st)) {
      if (st > now + 5 * 60 * 1000) return { status: 'UNKNOWN', label: '미래 시각', quote_time_verified: false };
      const ageMin = Math.max(0, (now - st) / 60000);
      if (ageMin <= 10) {
        let label = '최근 조회 (시각 미확인)';
        if (marketStatus.includes('정규장')) label = '장중 조회 (시각 미확인)';
        else if (marketStatus.includes('마감')) label = '장 마감 종가 (시각 미확인)';
        return { status: 'OK', label, quote_time_verified: false, market_status: marketStatus };
      }
      if (ageMin > 60) return { status: 'STALE', label: '오래된 데이터', quote_time_verified: false };
      if (ageMin > 10) return { status: 'DELAYED', label: '지연된 데이터', quote_time_verified: false };
    }
  }
  return { status: 'UNKNOWN', label: '확인 불가', quote_time_verified: false };
}

export function deriveConsistencyThreshold(previousAnalyzedAt, recentFlipCount) {
  let threshold = 0.8;
  if (previousAnalyzedAt) {
    const t = new Date(previousAnalyzedAt).getTime();
    if (!isNaN(t)) {
      const minutes = (Date.now() - t) / 60000;
      if (minutes < 30) threshold = 0.9;
      else if (minutes < 60) threshold = 0.85;
    }
  }
  if (recentFlipCount >= 2) threshold = Math.max(threshold, 0.88);
  return threshold;
}

export function needsHighConfidenceForLevelJump(prevRec, newRec) {
  if (!prevRec || !newRec) return false;
  const pl = REC_LEVEL[prevRec];
  const nl = REC_LEVEL[newRec];
  if (pl == null || nl == null) return false;
  return Math.abs(nl - pl) >= 2;
}

export function computeReferenceScore(price) {
  const rate = price.change_rate || 0;
  let score = 0;
  if (rate > 2) score += 1;
  else if (rate < -2) score -= 1;
  return score;
}

// ★ 단순 insert만 수행하여 PGRST116 에러 원천 차단
export async function saveAnalysisRun(supabase, payload) {
  const { error } = await supabase.from('stock_analysis_runs').insert(payload);
  if (error) throw error;
  return true;
}

export async function cleanupOldRuns(env, userId) {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return;
  try {
    const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const { error, count } = await admin.from('stock_analysis_runs').delete({ count: 'exact' }).eq('user_id', userId).lt('analyzed_at', cutoff);
    if (error) console.warn('[cleanup] failed:', error.message);
    else console.log('[cleanup] removed', count ?? 0, 'runs');
  } catch (e) { console.warn('[cleanup] exception:', e.message); }
}

export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

export async function loadRecentTrendHistory(env, ticker) {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return { status: 'unavailable', entries: [] };
  const since = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();
  try {
    const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { data, error } = await admin.from('stock_analysis_runs')
      .select('analyzed_at, market_facts')
      .eq('ticker', ticker).gte('analyzed_at', since)
      .order('analyzed_at', { ascending: false }).limit(500);
    if (error || !data) return { status: 'unavailable', entries: [] };
    if (data.length === 0) return { status: 'empty', entries: [] };

    const byDate = new Map();
    const allEntries = [];
    for (const row of data) {
      const t = row.market_facts?.agent_outputs?.trend;
      if (!t) continue;
      const mf = row.market_facts || {};
      const agStatus = mf.agent_status || {};
      const dqNote = mf.data_quality_note;
      if (agStatus.trend?.ok === false || agStatus.trend?.status === 'invalid') continue;
      if (dqNote === 'STALE' || dqNote === 'STALE_SOURCE') continue;

      const pd = mf.price_data || {};
      const ms = String(pd.market_status || '');
      const isAfterHours = pd.is_after_hours_quote === true || /애프터마켓|시간외/.test(ms);
      let basisClass = 'unknown';
      if (isAfterHours) basisClass = 'confirmed';
      else if (ms.includes('정규장')) basisClass = 'intraday';
      else if (/휴장|마감/.test(ms)) basisClass = 'confirmed';

      const entry = {
        analyzed_at: row.analyzed_at,
        short_term: t.short_term_trend || null,
        medium_term: t.medium_term_trend || null,
        strength: t.trend_strength || null,
        confidence: typeof t.trend_confidence === 'number' ? t.trend_confidence : null,
        market_status: pd.market_status || null,
        basis_class: basisClass,
      };
      allEntries.push(entry);
      const kstDate = new Date(new Date(row.analyzed_at).getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
      if (kstDate && !byDate.has(kstDate)) byDate.set(kstDate, entry);
    }
    if (allEntries.length === 0) return { status: 'empty', entries: [] };
    if (byDate.size >= 3) return { status: 'loaded', entries: Array.from(byDate.values()).slice(0, 15) };
    return { status: 'loaded', entries: allEntries.slice(0, 5) };
  } catch (e) {
    console.warn('[pipeline] loadRecentTrendHistory exception:', e.message);
    return { status: 'unavailable', entries: [] };
  }
}

export function summarizeTrendHistory(history, loadStatus) {
  if (loadStatus === 'unavailable' || !history || history.length === 0) {
    return {
      count: 0,
      distinct_days: 0,
      text: '- 이력 없음',
      stability: 'insufficient',
      stability_label: '판단 보류',
      flips_short: 0,
      flips_medium: 0,
      short_term_distribution: { '상승': 0, '횡보': 0, '하락': 0 },
      medium_term_distribution: { '상승': 0, '횡보': 0, '하락': 0 },
      data_basis_note: '-',
      sample_mode: 'none',
    };
  }

  const shortDist = { '상승': 0, '횡보': 0, '하락': 0 };
  const mediumDist = { '상승': 0, '횡보': 0, '하락': 0 };
  let flipsShort = 0, flipsMedium = 0;
  const distinctDates = new Set();

  history.forEach((h, idx) => {
    if (h.short_term) shortDist[h.short_term]++;
    if (h.medium_term) mediumDist[h.medium_term]++;
    if (h.analyzed_at) {
      distinctDates.add(new Date(new Date(h.analyzed_at).getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10));
    }
    if (idx > 0) {
      if (h.short_term && history[idx - 1].short_term && h.short_term !== history[idx - 1].short_term) flipsShort++;
      if (h.medium_term && history[idx - 1].medium_term && h.medium_term !== history[idx - 1].medium_term) flipsMedium++;
    }
  });

  const count = history.length;
  const distinctDays = distinctDates.size;

  let stability = 'medium', stabilityLabel = '보통';
  if (distinctDays < 3) { stability = 'insufficient'; stabilityLabel = '이력 부족'; }
  else if (flipsShort >= 2 || flipsMedium >= 2) { stability = 'unstable'; stabilityLabel = '낮음 (전환 잦음)'; }
  else if (flipsShort === 0 && flipsMedium === 0) { stability = 'stable'; stabilityLabel = '높음 (완전 일관)'; }

  const text =
    `최근 ${count}건 (${distinctDays}일) — ` +
    `단기 [상승 ${shortDist['상승']}/횡보 ${shortDist['횡보']}/하락 ${shortDist['하락']}], ` +
    `중기 [상승 ${mediumDist['상승']}/횡보 ${mediumDist['횡보']}/하락 ${mediumDist['하락']}], ` +
    `안정성 ${stabilityLabel} (단기 전환 ${flipsShort}회, 중기 전환 ${flipsMedium}회).`;

  const sampleMode = distinctDays >= 3 ? 'daily_sampled' : 'raw_entries';
  const dataBasisNote = distinctDays >= 3 ? '일별 샘플링' : '원본 이력 (일별 샘플링 미적용)';

  return {
    count,
    distinct_days: distinctDays,
    text,
    stability,
    stability_label: stabilityLabel,
    flips_short: flipsShort,
    flips_medium: flipsMedium,
    short_term_distribution: shortDist,
    medium_term_distribution: mediumDist,
    data_basis_note: dataBasisNote,
    sample_mode: sampleMode,
  };
}