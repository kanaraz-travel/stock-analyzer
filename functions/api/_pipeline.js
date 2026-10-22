// functions/api/_pipeline.js
// 분석 파이프라인의 도메인 규칙: 검증, 정규화, 이력 조회, 일관성 판정, 저장, 정리.

import { createClient } from '@supabase/supabase-js';
import { VALID_RECS_BUY, VALID_RECS_SELL } from './_constants.js';

// ★ 하위 호환 재-export (analyze.js의 기존 import 경로 유지)
export { VALID_RECS_BUY, VALID_RECS_SELL };

// ─── 등급별 자연어 부제 / 행동 힌트 ───
const REC_METADATA = {
  '매수 추천': { label: '적극 매수 관점', hint: '여러 지표가 정렬된 강한 매수 신호입니다. 다만 분할 매수로 리스크를 관리하세요.' },
  '매수 고려': { label: '신중한 매수 검토', hint: '긍정적 신호가 있으나 확신이 완전하지 않습니다. 추가 확인 후 진입을 검토하세요.' },
  '기다리기': { label: '관망 (지켜보기)', hint: '방향성이 뚜렷하지 않습니다. 추세가 명확해질 때까지 관망이 안전합니다.' },
  '매도 고려': { label: '리스크 인지, 일부 정리 검토', hint: '부정적 신호가 나타나고 있습니다. 일부 이익실현이나 손절을 검토하세요.' },
  '매도 추천': { label: '적극 매도 관점', hint: '여러 지표가 정렬된 강한 매도 신호입니다. 보유 중이라면 정리를 우선 검토하세요.' },
  '판단 보류': { label: '판단 유보', hint: '데이터 부족 또는 상충 신호로 판단을 내리기 어렵습니다. 재분석을 권장합니다.' },
  '부분 매도 고려': { label: '일부 이익실현 검토', hint: '일부 매도로 이익을 확정하고 리스크를 줄이는 것을 검토하세요.' },
  '보유 유지': { label: '홀드 (유지)', hint: '현재 포지션 유지가 적절합니다. 추가 매수나 매도 신호는 아직 뚜렷하지 않습니다.' },
  '추가 매수 고려': { label: '추가 매수 검토', hint: '보유 종목에 대한 긍정 신호가 있습니다. 비중 조절을 고려한 추가 매수를 검토하세요.' },
};

export function getRecommendationMeta(rec) {
  return REC_METADATA[rec] || { label: rec || '-', hint: '' };
}

export function interpretConfidence(confidence) {
  if (confidence == null || !Number.isFinite(confidence)) {
    return { level: 'unknown', label: '확신도 미제공' };
  }
  const pct = (confidence * 100).toFixed(0);
  if (confidence >= 0.8) return { level: 'high', label: `높은 확신 (${pct}%)` };
  if (confidence >= 0.6) return { level: 'medium', label: `중간 확신 (${pct}%)` };
  if (confidence >= 0.4) return { level: 'low', label: `낮은 확신 (${pct}%)` };
  return { level: 'very_low', label: `매우 낮은 확신 (${pct}%)` };
}

// ─── 동의어 매핑 ───
const REC_SYNONYMS_BUY = {
  '매수': '매수 고려', '매수추천': '매수 추천', '적극매수': '매수 추천', '강력매수': '매수 추천',
  '매도': '매도 고려', '매도추천': '매도 추천', '적극매도': '매도 추천', '강력매도': '매도 추천',
  '기다림': '기다리기', '대기': '기다리기', '관망': '기다리기', '관망세': '기다리기',
  '중립': '판단 보류', '판단보류': '판단 보류',
};
const REC_SYNONYMS_SELL = {
  '매도': '부분 매도 고려', '매도추천': '매도 추천', '적극매도': '매도 추천', '강력매도': '매도 추천',
  '매수': '추가 매수 고려', '매수추천': '추가 매수 고려',
  '보유': '보유 유지', '홀드': '보유 유지', '홀딩': '보유 유지', '존버': '보유 유지',
  '기다림': '보유 유지', '대기': '보유 유지', '관망': '보유 유지', '관망세': '보유 유지',
  '중립': '판단 보류', '판단보류': '판단 보류',
};

const REC_LEVEL = {
  '매수 추천': 2, '추가 매수 고려': 2,
  '매수 고려': 1, '보유 유지': 1,
  '기다리기': 0, '판단 보류': 0,
  '매도 고려': -1, '부분 매도 고려': -1,
  '매도 추천': -2,
};

// ─── 이력 정책 ───
const TREND_HISTORY_DAYS = 15;
const TREND_HISTORY_LOOKBACK_DAYS = 45;
const TREND_HISTORY_MAX_ROWS = 500;
const TREND_RECENT_FALLBACK_MAX = 5;
const RETENTION_DAYS = 90;
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

const MAX_NEWS_ITEMS = 30;
const MAX_URL_LENGTH = 2048;

// ─────────────────────────────────────────────────────────────
// 추천 정규화
// ─────────────────────────────────────────────────────────────
export function normalizeRecommendation(raw, analysisType) {
  if (raw && typeof raw === 'object') {
    raw = raw.recommendation || raw.label || raw.value || raw.action || '';
  }
  if (typeof raw !== 'string') return null;

  const cleaned = raw.replace(/\s+/g, '').replace(/[^\w가-힣]/g, '');
  if (!cleaned) return null;

  const validRecs = analysisType === 'sell' ? VALID_RECS_SELL : VALID_RECS_BUY;
  const cleanRec = (r) => r.replace(/\s+/g, '').replace(/[^\w가-힣]/g, '');

  for (const rec of validRecs) {
    if (cleanRec(rec) === cleaned) return rec;
  }
  const synonyms = analysisType === 'sell' ? REC_SYNONYMS_SELL : REC_SYNONYMS_BUY;
  if (synonyms[cleaned]) {
    const mapped = synonyms[cleaned];
    if (validRecs.includes(mapped)) return mapped;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// 에이전트 출력 검증
// ─────────────────────────────────────────────────────────────
export function validatePvOutput(out) {
  if (!out || typeof out !== 'object') return { valid: false, reason: 'NOT_OBJECT' };
  if (typeof out.price_flow_analysis !== 'string' || !out.price_flow_analysis.trim()) return { valid: false, reason: 'MISSING_PRICE_FLOW' };
  if (typeof out.volume_analysis !== 'string' || !out.volume_analysis.trim()) return { valid: false, reason: 'MISSING_VOLUME' };
  return { valid: true, reason: null };
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

// ─────────────────────────────────────────────────────────────
// 입력 검증
// ─────────────────────────────────────────────────────────────
export function validateAnalyzeInput(body) {
  const errors = [];
  if (!body || typeof body !== 'object') return { valid: false, errors: ['본문이 객체가 아닙니다.'] };
  const { ticker, stock_name, price_data, volume_data, news_items, analysis_type, holdings_data } = body;
  const now = Date.now();

  if (typeof ticker !== 'string' || !/^[0-9A-Z]{6}$/i.test(ticker)) errors.push('ticker는 6자리 코드여야 합니다.');
  if (typeof stock_name !== 'string' || stock_name.length === 0 || stock_name.length > 50) errors.push('stock_name은 1~50자 문자열이어야 합니다.');
  if (analysis_type != null && !['buy', 'sell'].includes(analysis_type)) errors.push("analysis_type은 'buy' 또는 'sell'이어야 합니다.");

  if (!price_data || typeof price_data !== 'object') errors.push('price_data가 누락되었습니다.');
  else {
    const { current_price, change_rate, return_1m, ma20_disparity, w52_hgpr, w52_lwpr, quote_as_of, server_time, price_source } = price_data;
    if (current_price == null || !Number.isFinite(current_price) || current_price <= 0) errors.push('current_price는 0보다 큰 유한한 숫자여야 합니다.');
    if (change_rate != null && !Number.isFinite(change_rate)) errors.push('change_rate는 유한한 숫자여야 합니다.');
    if (return_1m != null && !Number.isFinite(return_1m)) errors.push('return_1m은 유한한 숫자여야 합니다.');
    if (ma20_disparity != null && !Number.isFinite(ma20_disparity)) errors.push('ma20_disparity는 유한한 숫자여야 합니다.');
    if (w52_hgpr != null && (!Number.isFinite(w52_hgpr) || w52_hgpr < 0)) errors.push('w52_hgpr은 0 이상이어야 합니다.');
    if (w52_lwpr != null && (!Number.isFinite(w52_lwpr) || w52_lwpr < 0)) errors.push('w52_lwpr은 0 이상이어야 합니다.');
    if (quote_as_of != null) {
      const t = new Date(quote_as_of).getTime();
      if (isNaN(t)) errors.push('quote_as_of는 유효한 시간이어야 합니다.');
      else if (t > now + FUTURE_TOLERANCE_MS) errors.push('quote_as_of는 미래 시각일 수 없습니다.');
    }
    if (server_time != null) {
      const t = new Date(server_time).getTime();
      if (isNaN(t)) errors.push('server_time은 유효한 시간이어야 합니다.');
      else if (t > now + FUTURE_TOLERANCE_MS) errors.push('server_time은 미래 시각일 수 없습니다.');
    }
    if (price_source != null && !['FRESH', 'STALE'].includes(price_source)) errors.push("price_source는 'FRESH' 또는 'STALE'이어야 합니다.");
  }

  if (volume_data != null) {
    if (typeof volume_data !== 'object') errors.push('volume_data 형식이 올바르지 않습니다.');
    else {
      const { current_volume, avg_volume_20 } = volume_data;
      if (current_volume != null && (!Number.isFinite(current_volume) || current_volume < 0)) errors.push('current_volume은 0 이상이어야 합니다.');
      if (avg_volume_20 != null && (!Number.isFinite(avg_volume_20) || avg_volume_20 < 0)) errors.push('avg_volume_20은 0 이상이어야 합니다.');
    }
  }

  if (news_items != null) {
    if (!Array.isArray(news_items)) errors.push('news_items는 배열이어야 합니다.');
    else if (news_items.length > MAX_NEWS_ITEMS) errors.push(`news_items는 최대 ${MAX_NEWS_ITEMS}개까지만 허용됩니다.`);
    else news_items.forEach((n, i) => {
      if (!n || typeof n !== 'object') { errors.push(`news_items[${i}]가 객체가 아닙니다.`); return; }
      if (typeof n.title !== 'string' || n.title.length === 0 || n.title.length > 500) errors.push(`news_items[${i}].title은 1~500자 문자열이어야 합니다.`);
      if (n.url != null && (typeof n.url !== 'string' || n.url.length > MAX_URL_LENGTH || !/^https?:\/\//i.test(n.url))) errors.push(`news_items[${i}].url은 유효한 http(s) URL이어야 합니다.`);
      if (n.published_at != null) {
        if (typeof n.published_at !== 'string') errors.push(`news_items[${i}].published_at은 문자열이어야 합니다.`);
        else if (isNaN(new Date(n.published_at).getTime())) errors.push(`news_items[${i}].published_at은 유효한 시각이어야 합니다.`);
        else if (new Date(n.published_at).getTime() > now + FUTURE_TOLERANCE_MS) errors.push(`news_items[${i}].published_at은 미래일 수 없습니다.`);
      }
    });
  }

  if (holdings_data != null) {
    if (typeof holdings_data !== 'object') errors.push('holdings_data 형식이 올바르지 않습니다.');
    else {
      const { quantity, avg_cost } = holdings_data;
      if (quantity != null && (!Number.isFinite(quantity) || quantity < 0)) errors.push('holdings_data.quantity는 0 이상이어야 합니다.');
      if (avg_cost != null && (!Number.isFinite(avg_cost) || avg_cost < 0)) errors.push('holdings_data.avg_cost는 0 이상이어야 합니다.');
    }
  }

  return { valid: errors.length === 0, errors };
}

// ─────────────────────────────────────────────────────────────
// 데이터 품질
// ─────────────────────────────────────────────────────────────
export function computeDataQuality(price_data) {
  const marketStatus = price_data?.market_status || '';
  const serverTimeStr = price_data?.server_time || null;
  const quoteTimeStr = price_data?.quote_as_of || null;
  const now = Date.now();

  if (price_data?.price_source === 'STALE') {
    return { status: 'STALE', label: '시세 재조회 실패 (이전 가격 사용)', quote_time_verified: false };
  }
  if (quoteTimeStr) {
    const qt = new Date(quoteTimeStr).getTime();
    if (!isNaN(qt)) {
      if (qt > now + FUTURE_TOLERANCE_MS) return { status: 'UNKNOWN', label: '시세 시각이 미래로 설정됨', quote_time_verified: false };
      const ageMin = Math.max(0, (now - qt) / 60000);
      if (ageMin > 60) return { status: 'STALE', label: '오래된 데이터', age_min: Math.round(ageMin), quote_time_verified: true };
      if (ageMin > 10) return { status: 'DELAYED', label: '지연된 데이터', age_min: Math.round(ageMin), quote_time_verified: true };
      return { status: 'OK', label: '정상', quote_time_verified: true };
    }
  }
  if (serverTimeStr) {
    const st = new Date(serverTimeStr).getTime();
    if (!isNaN(st)) {
      if (st > now + FUTURE_TOLERANCE_MS) return { status: 'UNKNOWN', label: '서버 시각이 미래로 설정됨', quote_time_verified: false };
      const ageMin = Math.max(0, (now - st) / 60000);
      if (ageMin <= 10) {
        let label = '최근 조회 (시세 기준 시각 미확인)';
        if (marketStatus.includes('정규장')) label = '장중 조회 (시세 기준 시각 미확인)';
        else if (marketStatus.includes('마감')) label = '장 마감 종가 (시세 기준 시각 미확인)';
        return { status: 'OK', label, quote_time_verified: false, market_status: marketStatus };
      }
      if (ageMin > 60) return { status: 'STALE', label: '오래된 데이터', age_min: Math.round(ageMin), quote_time_verified: false };
      if (ageMin > 10) return { status: 'DELAYED', label: '지연된 데이터', age_min: Math.round(ageMin), quote_time_verified: false };
    }
  }
  return { status: 'UNKNOWN', label: '기준 시각 확인 불가', quote_time_verified: false };
}

// ─────────────────────────────────────────────────────────────
// 추세 이력 조회 — 세션/가격기준 분리 (v25.8)
// ─────────────────────────────────────────────────────────────
export async function loadRecentTrendHistory(env, ticker) {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    console.warn('[pipeline] loadRecentTrendHistory: SERVICE_ROLE_KEY missing → unavailable');
    return { status: 'unavailable', entries: [] };
  }

  const since = new Date(Date.now() - TREND_HISTORY_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();

  try {
    const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });

    // ★ ruleset_version도 조회 (분포 로깅용)
    const { data, error } = await admin
      .from('stock_analysis_runs')
      .select('analyzed_at, market_facts, ruleset_version')
      .eq('ticker', ticker)
      .gte('analyzed_at', since)
      .order('analyzed_at', { ascending: false })
      .limit(TREND_HISTORY_MAX_ROWS);

    if (error) {
      console.warn('[pipeline] history query error:', error.message);
      return { status: 'unavailable', entries: [] };
    }
    if (!data || data.length === 0) return { status: 'empty', entries: [] };

    // ★ 버전 분포 로깅 (필터링은 안 함, 관찰용)
    const versionDist = {};
    for (const row of data) {
      const v = row.ruleset_version || 'unknown';
      versionDist[v] = (versionDist[v] || 0) + 1;
    }
    console.log('[pipeline] history version distribution:', versionDist);

    const byDate = new Map();
    const allEntries = [];

    for (const row of data) {
      const t = row.market_facts?.agent_outputs?.trend;
      if (!t) continue;

      const mf = row.market_facts || {};
      const agStatus = mf.agent_status || {};
      const dqNote = mf.data_quality_note;

      if (agStatus.trend?.ok === false) continue;
      if (agStatus.trend?.status === 'invalid') continue;
      if (dqNote === 'STALE' || dqNote === 'STALE_SOURCE') continue;

      const pd = mf.price_data || {};
      const ms = String(pd.market_status || '');

      // ★ 세션 분류 (시장이 어떤 국면이었는가)
      let sessionKind = 'unknown';
      if (/애프터마켓|시간외/.test(ms)) sessionKind = 'after_hours';
      else if (/장마감|장 마감|휴장/.test(ms)) sessionKind = 'closed';
      else if (ms.includes('정규장')) sessionKind = 'regular';

      // ★ 가격 기준 분류 (그 가격이 무엇을 의미하는가)
      let basisClass = 'unknown';
      if (sessionKind === 'after_hours' || sessionKind === 'closed') basisClass = 'confirmed';
      else if (sessionKind === 'regular') basisClass = 'intraday';

      const entry = {
        analyzed_at: row.analyzed_at,
        short_term: t.short_term_trend || null,
        medium_term: t.medium_term_trend || null,
        strength: t.trend_strength || null,
        confidence: typeof t.trend_confidence === 'number' ? t.trend_confidence : null,
        market_status: pd.market_status || null,
        market_session: sessionKind,
        basis_class: basisClass,
        ruleset_version: row.ruleset_version || null,
      };
      allEntries.push(entry);

      const kstDate = getKstDate(row.analyzed_at);
      if (kstDate && !byDate.has(kstDate)) byDate.set(kstDate, entry);
    }

    if (allEntries.length === 0) return { status: 'empty', entries: [] };

    if (byDate.size >= 3) {
      return { status: 'loaded', entries: Array.from(byDate.values()).slice(0, TREND_HISTORY_DAYS) };
    }
    return { status: 'loaded', entries: allEntries.slice(0, TREND_RECENT_FALLBACK_MAX) };
  } catch (e) {
    console.warn('[pipeline] loadRecentTrendHistory exception:', e.message);
    return { status: 'unavailable', entries: [] };
  }
}

function getKstDate(isoStr) {
  if (!isoStr) return null;
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return null;
  const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}

export function summarizeTrendHistory(history, loadStatus) {
  if (loadStatus === 'unavailable') {
    return {
      count: 0, distinct_days: 0, sample_mode: 'unavailable',
      text: '- 이력 조회 실패 (DB 오류)',
      stability: 'insufficient', stability_label: '판단 보류 (이력 조회 실패)',
      short_term_distribution: null, medium_term_distribution: null,
      flips_short: 0, flips_medium: 0,
      after_hours_session_count: 0, closed_session_count: 0, regular_session_count: 0,
      basis_confirmed_count: 0, basis_intraday_count: 0, basis_unknown_count: 0,
      latest_age_days: null, max_gap_days: null, data_basis_note: '이력 조회 실패',
    };
  }
  if (!history || history.length === 0) {
    return {
      count: 0, distinct_days: 0, sample_mode: 'none',
      text: '- 이전 추세 판단 이력 없음 (첫 분석)',
      stability: 'insufficient', stability_label: '판단 보류 (이력 없음)',
      short_term_distribution: null, medium_term_distribution: null,
      flips_short: 0, flips_medium: 0,
      after_hours_session_count: 0, closed_session_count: 0, regular_session_count: 0,
      basis_confirmed_count: 0, basis_intraday_count: 0, basis_unknown_count: 0,
      latest_age_days: null, max_gap_days: null, data_basis_note: '데이터 없음',
    };
  }

  const shortDist = { '상승': 0, '횡보': 0, '하락': 0 };
  const mediumDist = { '상승': 0, '횡보': 0, '하락': 0 };
  let flipsShort = 0, flipsMedium = 0;
  // 세션 카운트
  let afterHoursSession = 0, closedSession = 0, regularSession = 0, unknownSession = 0;
  // 가격 기준 카운트
  let basisConfirmed = 0, basisIntraday = 0, basisUnknown = 0;
  const distinctDates = new Set();

  history.forEach((h, idx) => {
    if (h.short_term) shortDist[h.short_term] = (shortDist[h.short_term] || 0) + 1;
    if (h.medium_term) mediumDist[h.medium_term] = (mediumDist[h.medium_term] || 0) + 1;
    const kstDate = getKstDate(h.analyzed_at);
    if (kstDate) distinctDates.add(kstDate);

    // 세션
    if (h.market_session === 'after_hours') afterHoursSession++;
    else if (h.market_session === 'closed') closedSession++;
    else if (h.market_session === 'regular') regularSession++;
    else unknownSession++;

    // 가격 기준
    if (h.basis_class === 'confirmed') basisConfirmed++;
    else if (h.basis_class === 'intraday') basisIntraday++;
    else basisUnknown++;

    if (idx > 0) {
      if (h.short_term && history[idx - 1].short_term && h.short_term !== history[idx - 1].short_term) flipsShort++;
      if (h.medium_term && history[idx - 1].medium_term && h.medium_term !== history[idx - 1].medium_term) flipsMedium++;
    }
  });

  const count = history.length;
  const distinctDays = distinctDates.size;
  const sampleMode = distinctDays >= 3 ? 'daily' : 'recent_fallback';

  const sortedDates = Array.from(distinctDates).sort();
  const latestDateStr = sortedDates[sortedDates.length - 1];
  const latestDateMs = latestDateStr ? new Date(latestDateStr + 'T00:00:00+09:00').getTime() : null;
  const latestAgeDays = latestDateMs != null ? Math.max(0, Math.floor((Date.now() - latestDateMs) / 86400000)) : null;

  let maxGapDays = 0;
  for (let i = 1; i < sortedDates.length; i++) {
    const a = new Date(sortedDates[i - 1] + 'T00:00:00+09:00').getTime();
    const b = new Date(sortedDates[i] + 'T00:00:00+09:00').getTime();
    const gap = Math.floor((b - a) / 86400000);
    if (gap > maxGapDays) maxGapDays = gap;
  }

  let stability, stabilityLabel;
  if (distinctDays < 3) {
    stability = 'insufficient';
    stabilityLabel = `판단 보류 (이력 부족 - ${distinctDays}일)`;
  } else if (latestAgeDays != null && latestAgeDays > 14) {
    stability = 'insufficient';
    stabilityLabel = `판단 보류 (최신 이력 ${latestAgeDays}일 전)`;
  } else if (flipsShort >= 2 || flipsMedium >= 2) {
    stability = 'unstable';
    stabilityLabel = '낮음 (전환 잦음)';
  } else if (maxGapDays >= 10) {
    stability = 'sparse';
    stabilityLabel = `보통 (관측 간격 최대 ${maxGapDays}일)`;
  } else if (flipsShort === 0 && flipsMedium === 0 && distinctDays >= 5) {
    stability = 'stable';
    stabilityLabel = '높음 (완전 일관)';
  } else {
    stability = 'moderate';
    stabilityLabel = '보통';
  }

  const lines = history.map(h => {
    const dt = h.analyzed_at
      ? new Date(h.analyzed_at).toLocaleString('ko-KR', {
          timeZone: 'Asia/Seoul',
          month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
        })
      : '-';
    const conf = h.confidence != null ? `${(h.confidence * 100).toFixed(0)}%` : '-';
    let basis = '';
    if (h.basis_class === 'confirmed') basis = ' [확정 종가]';
    else if (h.basis_class === 'intraday') basis = ' [장중 잠정]';
    else basis = ' [기준 불명]';
    return `- ${dt}: 단기 ${h.short_term || '-'} / 중기 ${h.medium_term || '-'} (강도 ${h.strength || '-'}, 확신 ${conf})${basis}`;
  }).join('\n');

  // ★ basis_class 기반 데이터 기준 문구
  let dataBasisNote = '';
  if (basisConfirmed === count) dataBasisNote = `최근 ${count}건 모두 확정 종가`;
  else if (basisIntraday === count) dataBasisNote = `최근 ${count}건 모두 장중 잠정`;
  else if (basisConfirmed > 0 && basisIntraday > 0) {
    dataBasisNote = `최근 ${count}건 중 ${basisConfirmed}건 확정, ${basisIntraday}건 장중` +
      (basisUnknown > 0 ? `, ${basisUnknown}건 불명` : '');
  } else if (basisUnknown > 0) {
    dataBasisNote = `최근 ${count}건 중 ${basisUnknown}건 데이터 기준 불명`;
  } else {
    dataBasisNote = `최근 ${count}건 데이터 기준 불명확`;
  }

  const samplingNote = sampleMode === 'daily'
    ? `일별 샘플링 (${distinctDays}일, 최신 ${latestAgeDays ?? '?'}일 전)`
    : `최근 관측값 사용 (${count}건, 3일 미만)`;

  return {
    count, distinct_days: distinctDays, sample_mode: sampleMode,
    text: lines, stability, stability_label: stabilityLabel,
    short_term_distribution: shortDist, medium_term_distribution: mediumDist,
    flips_short: flipsShort, flips_medium: flipsMedium,
    after_hours_session_count: afterHoursSession,
    closed_session_count: closedSession,
    regular_session_count: regularSession,
    basis_confirmed_count: basisConfirmed,
    basis_intraday_count: basisIntraday,
    basis_unknown_count: basisUnknown,
    latest_age_days: latestAgeDays, max_gap_days: maxGapDays,
    data_basis_note: `${samplingNote} / ${dataBasisNote}`,
  };
}

// ─────────────────────────────────────────────────────────────
// 일관성 판정
// ─────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────
// 참고 지표 / 저장 / 정리 / 응답
// ─────────────────────────────────────────────────────────────
export function computeReferenceScore(price) {
  const rate = price.change_rate || 0;
  let score = 0;
  if (rate > 2) score += 1;
  else if (rate < -2) score -= 1;
  return score;
}

export async function saveAnalysisRun(supabase, payload) {
  const { error } = await supabase.from('stock_analysis_runs').insert(payload).select('id').single();
  if (error) throw error;
  return true;
}

export async function cleanupOldRuns(env, userId) {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return;
  try {
    const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const { error, count } = await admin
      .from('stock_analysis_runs')
      .delete({ count: 'exact' })
      .eq('user_id', userId)
      .lt('analyzed_at', cutoff);
    if (error) console.warn('[cleanup] failed:', error.message);
    else console.log('[cleanup] removed', count ?? 0, 'old runs for user', userId);
  } catch (e) { console.warn('[cleanup] exception:', e.message); }
}

export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}