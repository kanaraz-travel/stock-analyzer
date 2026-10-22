// functions/api/analyze.js
// POST /api/analyze — HTTP 핸들러, 오케스트레이션, 입력 검증, 이력 조회, 일관성 보정
//
// [v25.5 변경사항]
// - 추세 이력은 종목 기준으로 모든 사용자 통합 조회 (서비스 롤 사용)
// - 일관성 보정·중복 판정은 여전히 유저별
// - 프라이버시: market_facts에서 trend 관련 필드만 사용, 보유/판단 정보는 노출 안 함

import { createClient } from '@supabase/supabase-js';
import {
  VALID_RECS_BUY,
  VALID_RECS_SELL,
  runPriceVolumeAgent,
  runNewsAgent,
  runTrendAgent,
  runJudgeAgent,
} from './_agents.js';

const RULESET_VERSION = 'RULESET_AI_V25_5_GLOBAL_TREND_HISTORY';
const MAX_BODY_BYTES = 100 * 1024;
const MAX_NEWS_ITEMS = 30;
const MAX_URL_LENGTH = 2048;

// 이력 정책
const TREND_HISTORY_DAYS = 15;
const TREND_HISTORY_LOOKBACK_DAYS = 45;
const TREND_HISTORY_MAX_ROWS = 500;   // ★ 200 → 500 (사용자 확장 대비)
const TREND_INTRADAY_FALLBACK_MAX = 5;
const DUPLICATE_WINDOW_MS = 5 * 60 * 1000;
const DUPLICATE_PRICE_TOLERANCE_PCT = 0.5;
const RETENTION_DAYS = 90;
const CLEANUP_PROBABILITY = 0.2;
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

// 명시적 동의어 매핑 — 여기 없는 표현은 정규화 실패
const REC_SYNONYM_MAP = {
  '매수': '매수 고려',
  '매수추천': '매수 추천',
  '적극매수': '매수 추천',
  '강력매수': '매수 추천',
  '매도': '매도 고려',
  '매도추천': '매도 추천',
  '적극매도': '매도 추천',
  '강력매도': '매도 추천',
  '보유': '보유 유지',
  '홀드': '보유 유지',
  '기다림': '기다리기',
  '대기': '기다리기',
  '관망': '기다리기',
  '관망세': '기다리기',
  '중립': '판단 보류',
  '판단보류': '판단 보류',
};

// 판단 강도 매핑
const REC_LEVEL = {
  '매수 추천': 2, '추가 매수 고려': 2,
  '매수 고려': 1, '보유 유지': 1,
  '기다리기': 0, '판단 보류': 0,
  '매도 고려': -1, '부분 매도 고려': -1,
  '매도 추천': -2,
};

export async function onRequestPost(context) {
  const { request, env } = context;

  const authHeader = request.headers.get('authorization') || '';
  const token = authHeader.replace('Bearer ', '');
  if (!token) return jsonResponse({ error: '인증이 필요합니다.', error_code: 'UNAUTHORIZED' }, 401);

  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData?.user) return jsonResponse({ error: '인증이 필요합니다.', error_code: 'UNAUTHORIZED' }, 401);
  const userId = userData.user.id;

  let rawBody = '';
  try { rawBody = await request.text(); } catch {
    return jsonResponse({ error: '요청을 읽을 수 없습니다.', error_code: 'INVALID_BODY' }, 400);
  }
  const byteLength = new TextEncoder().encode(rawBody).length;
  if (byteLength > MAX_BODY_BYTES) {
    return jsonResponse({ error: '요청 본문이 너무 큽니다.', error_code: 'BODY_TOO_LARGE', bytes: byteLength }, 413);
  }

  let body = {};
  try { body = JSON.parse(rawBody); } catch {
    return jsonResponse({ error: '잘못된 JSON 형식입니다.', error_code: 'INVALID_JSON' }, 400);
  }

  const validation = validateAnalyzeInput(body);
  if (!validation.valid) {
    return jsonResponse({
      error: '입력값 검증에 실패했습니다.',
      error_code: 'INVALID_INPUT',
      details: validation.errors.slice(0, 10),
    }, 400);
  }

  const { ticker, stock_name, price_data, volume_data, news_items, analysis_type = 'buy', holdings_data } = body;

  const dataQuality = computeDataQuality(price_data);
  const isStale = price_data?.price_source === 'STALE';

  // UNKNOWN/INSUFFICIENT: 저장 차단
  if (dataQuality.status === 'UNKNOWN' || dataQuality.status === 'INSUFFICIENT') {
    return jsonResponse({
      score: null,
      recommendation: '판단 보류',
      overall_summary: '시세 기준 시각을 확인할 수 없거나 데이터가 부족하여 판단을 보류합니다.',
      data_quality: dataQuality,
      fallback: true,
      fallback_reason: 'DATA_INSUFFICIENT',
      ruleset_version: RULESET_VERSION,
      saved: false,
      save_skip_reason: 'DATA_INSUFFICIENT',
    });
  }

  const referenceScore = computeReferenceScore(price_data);
  let finalData = null;
  let isFallback = false;
  let fallbackReason = null;
  let dataQualityNote = null;
  let pvResult = null;
  let newsResult = null;
  let trendResult = null;
  let trendSummary = null;
  let previousAnalyzedAt = null;
  let previousRec = null;
  let latestRun = null;

  const agentStatus = {
    price_volume: { ok: false, status: 'skipped', reason: null },
    news: { ok: false, status: 'skipped', reason: null },
    trend: { ok: false, status: 'skipped', reason: null },
    judge: { ok: false, status: 'skipped', reason: null },
  };

  const validRecs = analysis_type === 'sell' ? VALID_RECS_SELL : VALID_RECS_BUY;

  try {
    if (!env.AI) throw new Error('AI_NOT_CONFIGURED');

    // (A) 일관성 기준점: 유저별 (판단 보류 제외 최근 5건)
    let recentFlipCount = 0;
    try {
      const { data: prevRuns, error: prevErr } = await supabase
        .from('stock_analysis_runs')
        .select('recommendation, analyzed_at, market_facts')
        .eq('user_id', userId).eq('ticker', ticker)
        .eq('market_facts->>analysis_type', analysis_type || 'buy')
        .neq('recommendation', '판단 보류')
        .order('analyzed_at', { ascending: false }).limit(5);

      if (prevErr) {
        console.warn('[analyze] prev runs query error:', prevErr.message);
      } else if (prevRuns && prevRuns.length > 0) {
        const validRuns = prevRuns.filter(r => validRecs.includes(r.recommendation));
        if (validRuns.length > 0) {
          previousRec = validRuns[0].recommendation;
          previousAnalyzedAt = validRuns[0].analyzed_at;
          for (let i = 1; i < validRuns.length; i++) {
            if (validRuns[i].recommendation !== validRuns[i - 1].recommendation) recentFlipCount++;
          }
        }
      }
    } catch (dbErr) { console.warn('[analyze] prev runs query failed:', dbErr.message); }

    // (B) 중복 판정 기준점: 유저별 최신 1건 (판단 보류 포함)
    try {
      const { data: latestRuns, error: latestErr } = await supabase
        .from('stock_analysis_runs')
        .select('recommendation, analyzed_at, market_facts')
        .eq('user_id', userId).eq('ticker', ticker)
        .order('analyzed_at', { ascending: false }).limit(1);
      if (!latestErr && latestRuns && latestRuns.length > 0) latestRun = latestRuns[0];
    } catch (dbErr) { console.warn('[analyze] latest run query failed:', dbErr.message); }

    // (C) 추세 이력 조회 — ★ 종목 기준 모든 사용자 통합 (서비스 롤)
    const trendHistoryResult = await loadRecentTrendHistory(env, ticker);
    trendSummary = summarizeTrendHistory(trendHistoryResult.entries, trendHistoryResult.status);

    // (D) [1] + [2] 병렬
    const [pvRaw, newsRaw] = await Promise.all([
      runPriceVolumeAgent(env, { ticker, stock_name, price_data, volume_data, analysis_type })
        .catch(e => { console.error('[analyze] pv agent exception:', e.message); return null; }),
      runNewsAgent(env, { ticker, stock_name, news_items })
        .catch(e => { console.error('[analyze] news agent exception:', e.message); return null; }),
    ]);

    const pvValidation = validatePvOutput(pvRaw);
    if (pvValidation.valid) {
      pvResult = pvRaw;
      agentStatus.price_volume = { ok: true, status: 'success', reason: null };
    } else {
      agentStatus.price_volume = { ok: false, status: 'invalid', reason: pvValidation.reason };
      pvResult = null;
    }

    const newsValidation = validateNewsOutput(newsRaw);
    if (newsValidation.valid) {
      newsResult = newsRaw;
      agentStatus.news = { ok: true, status: 'success', reason: null };
    } else {
      agentStatus.news = { ok: false, status: 'invalid', reason: newsValidation.reason };
      newsResult = null;
    }

    // (E) [3] 추세
    const trendRaw = await runTrendAgent(env, {
      ticker, stock_name, analysis_type, price_data, volume_data,
      price_volume_result: pvResult,
      news_result: newsResult,
      trend_history_summary: trendSummary,
    }).catch(e => { console.error('[analyze] trend agent exception:', e.message); return null; });

    const trendValidation = validateTrendOutput(trendRaw);
    if (trendValidation.valid) {
      trendResult = trendRaw;
      agentStatus.trend = { ok: true, status: 'success', reason: null };
    } else {
      agentStatus.trend = { ok: false, status: 'invalid', reason: trendValidation.reason };
      trendResult = null;
    }

    // (F) [4] 심판
    const judgeRaw = await runJudgeAgent(env, {
      ticker, stock_name, analysis_type, holdings_data, price_data,
      price_volume_result: pvResult,
      news_result: newsResult,
      trend_result: trendResult,
      trend_history_summary: trendSummary,
      previous_recommendation: previousRec,
    }).catch(e => {
      console.error('[analyze] judge agent exception:', e.message);
      agentStatus.judge = { ok: false, status: 'error', reason: e.message };
      return null;
    });

    if (!judgeRaw || typeof judgeRaw !== 'object') {
      if (agentStatus.judge.status === 'skipped') agentStatus.judge = { ok: false, status: 'empty', reason: 'EMPTY_RESPONSE' };
      throw new Error('JUDGE_FAILED');
    }

    const normalizedRec = normalizeRecommendation(judgeRaw.recommendation, analysis_type);
    if (!normalizedRec) {
      agentStatus.judge = { ok: false, status: 'invalid', reason: 'BAD_RECOMMENDATION' };
      throw new Error('RECOMMENDATION_INVALID');
    }
    agentStatus.judge = { ok: true, status: 'success', reason: null };

    let confidence = judgeRaw.confidence;
    if (typeof confidence !== 'number' || !Number.isFinite(confidence)) confidence = null;
    else confidence = Math.max(0, Math.min(1, confidence));

    let finalSummary = (typeof judgeRaw.overall_summary === 'string' && judgeRaw.overall_summary.trim().length > 0)
      ? judgeRaw.overall_summary
      : '(종합 분석 누락 - 재분석 권장)';

    let finalRecommendation = normalizedRec;

    // 첫 분석 runtime guard
    if (!previousRec) {
      const isStrong = finalRecommendation === '매수 추천' || finalRecommendation === '매도 추천';
      if (isStrong && (confidence == null || confidence < 0.7)) {
        if (finalRecommendation === '매수 추천') finalRecommendation = '매수 고려';
        else if (finalRecommendation === '매도 추천') finalRecommendation = '매도 고려';
        finalSummary = `[첫 분석 확신도 낮음으로 강도 하향] ${finalSummary}`;
      }
    }

    // 일관성 보정 (정규화·검증 후)
    const threshold = deriveConsistencyThreshold(previousAnalyzedAt, recentFlipCount);
    const jumpPenalty = needsHighConfidenceForLevelJump(previousRec, finalRecommendation) ? 0.9 : 0;
    const effectiveThreshold = Math.max(threshold, jumpPenalty);

    const shouldKeep = previousRec && previousRec !== finalRecommendation &&
      (confidence == null || confidence < effectiveThreshold);

    if (shouldKeep) {
      finalRecommendation = previousRec;
      const confStr = confidence == null ? '미제공' : `${(confidence * 100).toFixed(0)}%`;
      finalSummary = `[판단 유지] ${finalSummary} (확신도 ${confStr} < 임계 ${(effectiveThreshold * 100).toFixed(0)}%)`;
    }

    // 데이터 신선도 다운그레이드
    const pvFailed = !agentStatus.price_volume.ok;
    const trendFailed = !agentStatus.trend.ok;

    if ((pvFailed || trendFailed) && !(pvFailed && trendFailed)) {
      if (finalRecommendation === '매수 추천') finalRecommendation = '매수 고려';
      else if (finalRecommendation === '매도 추천') finalRecommendation = '매도 고려';
      const missed = pvFailed ? '가격·거래량 분석 누락' : '추세 분석 누락';
      finalSummary = `[${missed}으로 강도 하향] ${finalSummary}`;
    }

    if (dataQuality.status === 'STALE') {
      if (finalRecommendation === '매수 추천') finalRecommendation = '매수 고려';
      else if (finalRecommendation === '매도 추천') finalRecommendation = '매도 고려';
      finalSummary = `[데이터 오래됨/이전 가격으로 강도 하향] ${finalSummary}`;
      dataQualityNote = 'STALE';
    } else if (dataQuality.status === 'DELAYED') {
      dataQualityNote = 'DELAYED';
      finalSummary = `[데이터 지연됨] ${finalSummary}`;
    } else if (dataQuality.quote_time_verified === false) {
      dataQualityNote = 'OK_UNVERIFIED';
      finalSummary = `[시세 시각 미확인] ${finalSummary}`;
    }

    if (isStale && !dataQualityNote) dataQualityNote = 'STALE_SOURCE';

    finalData = { recommendation: finalRecommendation, overall_summary: finalSummary };
  } catch (e) {
    console.error('[analyze] internal error:', e && e.message, e && e.stack);
    isFallback = true;
    fallbackReason = 'AI_ERROR';
    finalData = {
      recommendation: '판단 보류',
      overall_summary: 'AI 분석이 일시적으로 실패하여 판단을 보류합니다. 잠시 후 다시 시도해 주세요.',
    };
    if (agentStatus.judge.status === 'skipped') {
      agentStatus.judge = { ok: false, status: 'error', reason: 'UNKNOWN' };
    }
  }

  // 저장 판단
  let saved = false;
  let saveSkipReason = null;

  const pvOk = agentStatus.price_volume.ok;
  const trendOk = agentStatus.trend.ok;
  const criticalFailure = !pvOk && !trendOk;

  let isDuplicate = false;
  if (latestRun && finalData?.recommendation && trendResult) {
    const latestRec = latestRun.recommendation;
    const latestTrend = latestRun.market_facts?.agent_outputs?.trend;
    const latestPrice = latestRun.market_facts?.price_data?.current_price;
    const currPrice = price_data?.current_price;
    const priceDiffPct = (latestPrice && currPrice)
      ? Math.abs(currPrice - latestPrice) / latestPrice * 100 : null;
    const isPriceSame = priceDiffPct != null && priceDiffPct < DUPLICATE_PRICE_TOLERANCE_PCT;
    const withinWindow = latestRun.analyzed_at &&
      (Date.now() - new Date(latestRun.analyzed_at).getTime()) < DUPLICATE_WINDOW_MS;

    isDuplicate =
      latestRec === finalData.recommendation &&
      latestTrend &&
      latestTrend.short_term_trend === trendResult.short_term_trend &&
      latestTrend.medium_term_trend === trendResult.medium_term_trend &&
      isPriceSame && withinWindow;
  }

  if (isFallback) {
    saveSkipReason = fallbackReason || 'AI_ERROR';
  } else if (criticalFailure) {
    saveSkipReason = 'CRITICAL_AGENT_FAILURE';
    console.log('[analyze] skip save: both pv and trend failed');
  } else if (isDuplicate) {
    saveSkipReason = 'DUPLICATE';
    console.log('[analyze] skip save: duplicate within 5 min');
  } else {
    try {
      await saveAnalysisRun(supabase, {
        user_id: userId, ticker, stock_name,
        analyzed_at: new Date().toISOString(),
        quote_price: price_data.current_price ?? null,
        quote_as_of: price_data.quote_as_of ?? null,
        data_status: dataQuality.status,
        score: referenceScore,
        recommendation: finalData.recommendation,
        ruleset_version: RULESET_VERSION,
        market_facts: {
          price_data, volume_data, news_items, analysis_type, holdings_data,
          agent_outputs: { price_volume: pvResult, news: newsResult, trend: trendResult },
          agent_status: agentStatus,
          trend_history_summary: trendSummary,
          data_quality_note: dataQualityNote,
        },
        overall_summary: finalData.overall_summary,
        price_flow_summary: pvResult?.price_flow_analysis ?? null,
        volume_summary: pvResult?.volume_analysis ?? null,
        news_summary: newsResult?.news_analysis ?? null,
        tip: '',
        sources: news_items?.map((n) => ({ title: n.title, url: n.url })) ?? null,
      });
      saved = true;
    } catch (saveErr) {
      console.error('[analyze] saveAnalysisRun failed:', {
        message: saveErr.message, code: saveErr.code, details: saveErr.details, hint: saveErr.hint,
      });
      saveSkipReason = 'SAVE_ERROR';
    }
  }

  // TTL 정리 (20% 확률, 백그라운드)
  let cleanupTriggered = false;
  try {
    if (context.waitUntil && Math.random() < CLEANUP_PROBABILITY) {
      context.waitUntil(cleanupOldRuns(env, userId));
      cleanupTriggered = true;
    }
  } catch (cleanupErr) { console.warn('[analyze] cleanup trigger failed:', cleanupErr.message); }

  return jsonResponse({
    score: referenceScore,
    recommendation: finalData.recommendation,
    overall_summary: finalData.overall_summary,
    data_quality: dataQuality,
    data_quality_note: dataQualityNote,
    ruleset_version: RULESET_VERSION,
    fallback: isFallback,
    fallback_reason: fallbackReason,
    agent_status: agentStatus,
    trend_history_count: trendSummary?.count ?? 0,
    trend_history_days: trendSummary?.distinct_days ?? 0,
    trend_history_stability: trendSummary?.stability ?? 'unknown',
    trend_history_label: trendSummary?.stability_label ?? '-',
    trend_history_sample_mode: trendSummary?.sample_mode ?? 'unknown',
    trend_history_scope: 'global',   // ★ 신규: 통합 이력임을 명시
    saved,
    save_skip_reason: saveSkipReason,
    cleanup_triggered: cleanupTriggered,
  });
}

// ─────────────────────────────────────────────────────────────
// ★ 추세 이력 조회 — 종목 기준 모든 사용자 통합 (서비스 롤)
//
// [프라이버시 원칙]
// - market_facts에서 trend 방향·확신도·market_status만 사용
// - 보유 수량·평단·최종 판단·뉴스 요약 등은 조회 후에도 사용하지 않음
// - 클라이언트 직접 접근 차단 (RLS 유지), 백엔드에서만 서비스 롤 사용
// ─────────────────────────────────────────────────────────────
async function loadRecentTrendHistory(env, ticker) {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    console.warn('[analyze] loadRecentTrendHistory: SERVICE_ROLE_KEY missing → unavailable');
    return { status: 'unavailable', entries: [] };
  }

  const since = new Date(Date.now() - TREND_HISTORY_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();

  try {
    const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });

    const { data, error } = await admin
      .from('stock_analysis_runs')
      .select('analyzed_at, market_facts')
      .eq('ticker', ticker)                  // ★ user_id 필터 제거 (종목 기준 통합)
      .gte('analyzed_at', since)
      .order('analyzed_at', { ascending: false })
      .limit(TREND_HISTORY_MAX_ROWS);

    if (error) {
      console.warn('[analyze] history query error:', error.message);
      return { status: 'unavailable', entries: [] };
    }
    if (!data || data.length === 0) return { status: 'empty', entries: [] };

    const byDate = new Map();
    const allEntries = [];

    for (const row of data) {
      const t = row.market_facts?.agent_outputs?.trend;
      if (!t) continue;
      const pd = row.market_facts?.price_data || {};
      const ms = String(pd.market_status || '');
      const isAfterHours = pd.is_after_hours_quote === true || /애프터마켓|시간외/.test(ms);

      // ★ 프라이버시: 추세 관련 필드만 추출, 사용자 식별 정보 제외
      const entry = {
        analyzed_at: row.analyzed_at,
        short_term: t.short_term_trend || null,
        medium_term: t.medium_term_trend || null,
        strength: t.trend_strength || null,
        confidence: typeof t.trend_confidence === 'number' ? t.trend_confidence : null,
        market_status: pd.market_status || null,
        is_after_hours_quote: isAfterHours,
      };
      allEntries.push(entry);

      const kstDate = getKstDate(row.analyzed_at);
      if (kstDate && !byDate.has(kstDate)) byDate.set(kstDate, entry);
    }

    if (allEntries.length === 0) return { status: 'empty', entries: [] };

    if (byDate.size >= 3) {
      return { status: 'loaded', entries: Array.from(byDate.values()).slice(0, TREND_HISTORY_DAYS) };
    }
    return { status: 'loaded', entries: allEntries.slice(0, TREND_INTRADAY_FALLBACK_MAX) };
  } catch (e) {
    console.warn('[analyze] loadRecentTrendHistory exception:', e.message);
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

function summarizeTrendHistory(history, loadStatus) {
  if (loadStatus === 'unavailable') {
    return {
      count: 0, distinct_days: 0, sample_mode: 'unavailable',
      text: '- 이력 조회 실패 (DB 오류)',
      stability: 'insufficient',
      stability_label: '판단 보류 (이력 조회 실패)',
      short_term_distribution: null, medium_term_distribution: null,
      flips_short: 0, flips_medium: 0,
      after_hours_count: 0, intraday_count: 0, confirmed_closed_count: 0,
      latest_age_days: null, max_gap_days: null,
      data_basis_note: '이력 조회 실패',
    };
  }
  if (!history || history.length === 0) {
    return {
      count: 0, distinct_days: 0, sample_mode: 'none',
      text: '- 이전 추세 판단 이력 없음 (첫 분석)',
      stability: 'insufficient',
      stability_label: '판단 보류 (이력 없음)',
      short_term_distribution: null, medium_term_distribution: null,
      flips_short: 0, flips_medium: 0,
      after_hours_count: 0, intraday_count: 0, confirmed_closed_count: 0,
      latest_age_days: null, max_gap_days: null,
      data_basis_note: '데이터 없음',
    };
  }

  const shortDist = { '상승': 0, '횡보': 0, '하락': 0 };
  const mediumDist = { '상승': 0, '횡보': 0, '하락': 0 };
  let flipsShort = 0, flipsMedium = 0;
  let afterHoursCount = 0, intradayCount = 0, confirmedClosedCount = 0;
  const distinctDates = new Set();

  history.forEach((h, idx) => {
    if (h.short_term) shortDist[h.short_term] = (shortDist[h.short_term] || 0) + 1;
    if (h.medium_term) mediumDist[h.medium_term] = (mediumDist[h.medium_term] || 0) + 1;
    const kstDate = getKstDate(h.analyzed_at);
    if (kstDate) distinctDates.add(kstDate);

    const ms = String(h.market_status || '');
    if (h.is_after_hours_quote) afterHoursCount++;
    else if (ms.includes('정규장')) intradayCount++;
    else if (/휴장|마감/.test(ms)) confirmedClosedCount++;

    if (idx > 0) {
      if (h.short_term && history[idx - 1].short_term && h.short_term !== history[idx - 1].short_term) flipsShort++;
      if (h.medium_term && history[idx - 1].medium_term && h.medium_term !== history[idx - 1].medium_term) flipsMedium++;
    }
  });

  const count = history.length;
  const distinctDays = distinctDates.size;
  const sampleMode = distinctDays >= 3 ? 'daily' : 'intraday';

  const sortedDates = Array.from(distinctDates).sort();
  const latestDateStr = sortedDates[sortedDates.length - 1];
  const latestDateMs = latestDateStr ? new Date(latestDateStr + 'T00:00:00+09:00').getTime() : null;
  const latestAgeDays = latestDateMs != null
    ? Math.max(0, Math.floor((Date.now() - latestDateMs) / 86400000)) : null;

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
    const ms = String(h.market_status || '');
    let basis = '';
    if (h.is_after_hours_quote) basis = ' [확정 종가]';
    else if (ms.includes('정규장')) basis = ' [장중 잠정]';
    else if (/휴장|마감/.test(ms)) basis = ' [확정 종가]';
    return `- ${dt}: 단기 ${h.short_term || '-'} / 중기 ${h.medium_term || '-'} (강도 ${h.strength || '-'}, 확신 ${conf})${basis}`;
  }).join('\n');

  const confirmedTotal = afterHoursCount + confirmedClosedCount;
  let dataBasisNote = '';
  if (confirmedTotal > 0 && intradayCount === 0) dataBasisNote = `최근 ${count}건 모두 확정 종가`;
  else if (confirmedTotal === 0 && intradayCount > 0) dataBasisNote = `최근 ${count}건 모두 장중 잠정`;
  else if (confirmedTotal > 0 && intradayCount > 0) dataBasisNote = `최근 ${count}건 중 ${confirmedTotal}건 확정, ${intradayCount}건 장중`;
  else dataBasisNote = `최근 ${count}건 데이터 기준 불명확`;

  const samplingNote = sampleMode === 'daily'
    ? `일별 샘플링 (${distinctDays}일, 최신 ${latestAgeDays ?? '?'}일 전)`
    : `장중 샘플링 (${count}건, 3일 미만)`;

  return {
    count, distinct_days: distinctDays, sample_mode: sampleMode,
    text: lines, stability, stability_label: stabilityLabel,
    short_term_distribution: shortDist, medium_term_distribution: mediumDist,
    flips_short: flipsShort, flips_medium: flipsMedium,
    after_hours_count: afterHoursCount, intraday_count: intradayCount,
    confirmed_closed_count: confirmedClosedCount,
    latest_age_days: latestAgeDays, max_gap_days: maxGapDays,
    data_basis_note: `${samplingNote} / ${dataBasisNote}`,
  };
}

// ─────────────────────────────────────────────────────────────
// TTL 정리 (백그라운드)
// ─────────────────────────────────────────────────────────────
async function cleanupOldRuns(env, userId) {
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

// ─────────────────────────────────────────────────────────────
// 데이터 품질
// ─────────────────────────────────────────────────────────────
function computeDataQuality(price_data) {
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
      if (qt > now + FUTURE_TOLERANCE_MS) {
        return { status: 'UNKNOWN', label: '시세 시각이 미래로 설정됨', quote_time_verified: false };
      }
      const ageMin = Math.max(0, (now - qt) / 60000);
      if (ageMin > 60) return { status: 'STALE', label: '오래된 데이터', age_min: Math.round(ageMin), quote_time_verified: true };
      if (ageMin > 10) return { status: 'DELAYED', label: '지연된 데이터', age_min: Math.round(ageMin), quote_time_verified: true };
      return { status: 'OK', label: '정상', quote_time_verified: true };
    }
  }
  if (serverTimeStr) {
    const st = new Date(serverTimeStr).getTime();
    if (!isNaN(st)) {
      if (st > now + FUTURE_TOLERANCE_MS) {
        return { status: 'UNKNOWN', label: '서버 시각이 미래로 설정됨', quote_time_verified: false };
      }
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
// 입력 검증
// ─────────────────────────────────────────────────────────────
function validateAnalyzeInput(body) {
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
// 일관성 헬퍼
// ─────────────────────────────────────────────────────────────
function deriveConsistencyThreshold(previousAnalyzedAt, recentFlipCount) {
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

function needsHighConfidenceForLevelJump(prevRec, newRec) {
  if (!prevRec || !newRec) return false;
  const pl = REC_LEVEL[prevRec];
  const nl = REC_LEVEL[newRec];
  if (pl == null || nl == null) return false;
  return Math.abs(nl - pl) >= 2;
}

// 참고 등락률 지표 (AI 판단과 무관, 노출용)
function computeReferenceScore(price) {
  const rate = price.change_rate || 0;
  let score = 0;
  if (rate > 2) score += 1;
  else if (rate < -2) score -= 1;
  return score;
}

async function saveAnalysisRun(supabase, payload) {
  const { error } = await supabase.from('stock_analysis_runs').insert(payload).select('id').single();
  if (error) throw error;
  return true;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}