// functions/api/analyze.js
// POST /api/analyze — HTTP 핸들러 + 오케스트레이션 + 응답 조립

import { createClient } from '@supabase/supabase-js';
import {
  VALID_RECS_BUY,
  VALID_RECS_SELL,
  normalizeRecommendation,
  validateAnalyzeInput,
  validatePvOutput,
  validateNewsOutput,
  validateTrendOutput,
  computeDataQuality,
  loadRecentTrendHistory,
  summarizeTrendHistory,
  deriveConsistencyThreshold,
  needsHighConfidenceForLevelJump,
  computeReferenceScore,
  saveAnalysisRun,
  cleanupOldRuns,
  getRecommendationMeta,
  interpretConfidence,
  jsonResponse,
} from './_pipeline.js';

import {
  runPriceVolumeAgent,
  runNewsAgent,
  runTrendAgent,
  runJudgeAgent,
} from './_agents.js';

const RULESET_VERSION = 'RULESET_AI_V25_9_HISTORY_GUARD';
const MAX_BODY_BYTES = 100 * 1024;

const DUPLICATE_WINDOW_MS = 5 * 60 * 1000;
const DUPLICATE_PRICE_TOLERANCE_PCT = 0.5;
const CLEANUP_PROBABILITY = 0.2;

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

  // ★ 신규: 과거 시세 데이터 누락 감지 (KIS API 점검 시간 등)
  // history.js가 실패하거나 데이터가 부족하면 return_1m, ma20_disparity가 모두 null이 됨
  const hasHistoryData = price_data?.return_1m != null || price_data?.ma20_disparity != null;
  if (!hasHistoryData) {
    console.warn('[analyze] history data missing → reject analysis');
    return jsonResponse({
      score: null,
      recommendation: '판단 보류',
      overall_summary: '과거 시세 데이터를 불러오지 못해 분석을 진행할 수 없습니다. 증권사 API 점검 시간일 수 있으니 잠시 후 다시 시도해 주세요.',
      data_quality: { status: 'INSUFFICIENT', label: '과거 데이터 누락', quote_time_verified: false },
      fallback: true,
      fallback_reason: 'HISTORY_DATA_MISSING',
      ruleset_version: RULESET_VERSION,
      saved: false,
      save_skip_reason: 'DATA_INSUFFICIENT',
    });
  }

  // ★ 데이터 기준 시각 확인 불가 또는 부족 시 차단
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
  let judgeConfidence = null;
  let originalJudgeRec = null;
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

    // (A) 일관성 기준점
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

    // (B) 중복 판정 기준점
    try {
      const { data: latestRuns, error: latestErr } = await supabase
        .from('stock_analysis_runs')
        .select('recommendation, analyzed_at, market_facts')
        .eq('user_id', userId).eq('ticker', ticker)
        .order('analyzed_at', { ascending: false }).limit(1);
      if (!latestErr && latestRuns && latestRuns.length > 0) latestRun = latestRuns[0];
    } catch (dbErr) { console.warn('[analyze] latest run query failed:', dbErr.message); }

    // (C) 추세 이력
    const trendHistoryResult = await loadRecentTrendHistory(env, ticker);
    trendSummary = summarizeTrendHistory(trendHistoryResult.entries, trendHistoryResult.status);

    // (D) [1] + [2] 병렬 (예외를 sentinel로 구분)
    const pvRaw = await runPriceVolumeAgent(env, { ticker, stock_name, price_data, volume_data, analysis_type })
      .catch(e => { console.error('[analyze] pv agent exception:', e.message); return { __exception: true }; });
    const newsRaw = await runNewsAgent(env, { ticker, stock_name, news_items })
      .catch(e => { console.error('[analyze] news agent exception:', e.message); return { __exception: true }; });

    if (pvRaw && pvRaw.__exception) {
      agentStatus.price_volume = { ok: false, status: 'error', reason: 'AGENT_EXCEPTION' };
      pvResult = null;
    } else {
      const v = validatePvOutput(pvRaw);
      if (v.valid) { pvResult = pvRaw; agentStatus.price_volume = { ok: true, status: 'success', reason: null }; }
      else { agentStatus.price_volume = { ok: false, status: 'invalid', reason: v.reason }; pvResult = null; }
    }

    if (newsRaw && newsRaw.__exception) {
      agentStatus.news = { ok: false, status: 'error', reason: 'AGENT_EXCEPTION' };
      newsResult = null;
    } else {
      const v = validateNewsOutput(newsRaw);
      if (v.valid) { newsResult = newsRaw; agentStatus.news = { ok: true, status: 'success', reason: null }; }
      else { agentStatus.news = { ok: false, status: 'invalid', reason: v.reason }; newsResult = null; }
    }

    // (E) [3] 추세
    const trendRaw = await runTrendAgent(env, {
      ticker, stock_name, analysis_type, price_data, volume_data,
      price_volume_result: pvResult,
      news_result: newsResult,
      trend_history_summary: trendSummary,
    }).catch(e => { console.error('[analyze] trend agent exception:', e.message); return { __exception: true }; });

    if (trendRaw && trendRaw.__exception) {
      agentStatus.trend = { ok: false, status: 'error', reason: 'AGENT_EXCEPTION' };
      trendResult = null;
    } else {
      const v = validateTrendOutput(trendRaw);
      if (v.valid) { trendResult = trendRaw; agentStatus.trend = { ok: true, status: 'success', reason: null }; }
      else { agentStatus.trend = { ok: false, status: 'invalid', reason: v.reason }; trendResult = null; }
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
      agentStatus.judge = { ok: false, status: 'error', reason: 'AGENT_EXCEPTION' };
      return null;
    });

    // ★ 필수 필드 검증 (미완성 시 throw → catch 블록이 실패 처리)
    if (!judgeRaw || typeof judgeRaw !== 'object') {
      if (agentStatus.judge.status === 'skipped') agentStatus.judge = { ok: false, status: 'empty', reason: 'EMPTY_RESPONSE' };
      const err = new Error('JUDGE_EMPTY');
      err.fallbackReason = 'JUDGE_EMPTY';
      throw err;
    }

    const hasRec = typeof judgeRaw.recommendation === 'string' && judgeRaw.recommendation.trim().length > 0;
    const hasSummary = typeof judgeRaw.overall_summary === 'string' && judgeRaw.overall_summary.trim().length > 0;

    if (!hasRec || !hasSummary) {
      const missing = !hasRec ? 'MISSING_RECOMMENDATION' : 'MISSING_SUMMARY';
      agentStatus.judge = { ok: false, status: 'incomplete', reason: missing };
      const err = new Error(`JUDGE_INCOMPLETE_${missing}`);
      err.fallbackReason = `JUDGE_${missing}`;
      throw err;
    }

    // ★ 추천 정규화
    const normalizedRec = normalizeRecommendation(judgeRaw.recommendation, analysis_type);
    if (!normalizedRec) {
      agentStatus.judge = { ok: false, status: 'invalid', reason: 'BAD_RECOMMENDATION' };
      const err = new Error('JUDGE_INVALID_RECOMMENDATION');
      err.fallbackReason = 'JUDGE_INVALID_RECOMMENDATION';
      throw err;
    }

    agentStatus.judge = { ok: true, status: 'success', reason: null };
    originalJudgeRec = normalizedRec;

    // ★ confidence: 범위 밖이면 무효 (클램핑 금지)
    let confidence = judgeRaw.confidence;
    if (typeof confidence !== 'number' || !Number.isFinite(confidence)
        || confidence < 0 || confidence > 1) {
      confidence = null;
    }
    judgeConfidence = confidence;

    let finalSummary = judgeRaw.overall_summary;
    let finalRecommendation = originalJudgeRec;

    // 첫 분석 runtime guard
    if (!previousRec) {
      const isStrong = finalRecommendation === '매수 추천' || finalRecommendation === '매도 추천';
      if (isStrong && (confidence == null || confidence < 0.7)) {
        if (finalRecommendation === '매수 추천') finalRecommendation = '매수 고려';
        else if (finalRecommendation === '매도 추천') finalRecommendation = '매도 고려';
        finalSummary = `[첫 분석 확신도 낮음으로 강도 하향] ${finalSummary}`;
      }
    }

    // 일관성 보정
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

    // 핵심 분석가 실패 처리
    const pvFailed = !agentStatus.price_volume.ok;
    const trendFailed = !agentStatus.trend.ok;

    if (pvFailed && trendFailed) {
      finalRecommendation = '판단 보류';
      finalSummary = `[핵심 분석 실패로 판단 보류] ${finalSummary}`;
      isFallback = true;
      fallbackReason = 'CRITICAL_AGENT_FAILURE';
    } else if (pvFailed || trendFailed) {
      if (finalRecommendation === '매수 추천') finalRecommendation = '매수 고려';
      else if (finalRecommendation === '매도 추천') finalRecommendation = '매도 고려';
      const missed = pvFailed ? '가격·거래량 분석 누락' : '추세 분석 누락';
      finalSummary = `[${missed}으로 강도 하향] ${finalSummary}`;
    }

    // 데이터 신선도 다운그레이드
    const downgradeStrong = () => {
      if (finalRecommendation === '매수 추천') return '매수 고려';
      if (finalRecommendation === '매도 추천') return '매도 고려';
      return finalRecommendation;
    };

    const ms = String(price_data?.market_status || '');
    const isConfirmedClose = price_data?.is_after_hours_quote === true
      || /마감|애프터마켓|시간외|휴장/.test(ms);

    if (dataQuality.status === 'STALE') {
      finalRecommendation = downgradeStrong();
      finalSummary = `[데이터 오래됨/이전 가격으로 강도 하향] ${finalSummary}`;
      dataQualityNote = isStale ? 'STALE_SOURCE' : 'STALE';
    } else if (dataQuality.status === 'DELAYED') {
      finalRecommendation = downgradeStrong();
      finalSummary = `[데이터 지연으로 강도 하향] ${finalSummary}`;
      dataQualityNote = 'DELAYED';
    } else if (dataQuality.quote_time_verified === false) {
      if (isConfirmedClose) {
        dataQualityNote = 'OK_CONFIRMED_CLOSE';
      } else {
        finalRecommendation = downgradeStrong();
        finalSummary = `[시세 시각 미확인으로 강도 하향] ${finalSummary}`;
        dataQualityNote = 'OK_UNVERIFIED';
      }
    }

    finalData = { recommendation: finalRecommendation, overall_summary: finalSummary };
  } catch (e) {
    console.error('[analyze] internal error:', e && e.message, e && e.stack);
    isFallback = true;
    fallbackReason = e.fallbackReason || 'AI_ERROR';
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

  let isDuplicate = false;
  if (latestRun && finalData?.recommendation && trendResult) {
    const latestType = latestRun.market_facts?.analysis_type;
    const currType = analysis_type || 'buy';

    if (latestType === currType) {
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
  }

  if (isFallback) {
    saveSkipReason = fallbackReason || 'AI_ERROR';
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
          judge_confidence: judgeConfidence,
          judge_recommendation: originalJudgeRec,
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

  // TTL 정리
  let cleanupTriggered = false;
  try {
    if (context.waitUntil && Math.random() < CLEANUP_PROBABILITY) {
      context.waitUntil(cleanupOldRuns(env, userId));
      cleanupTriggered = true;
    }
  } catch (cleanupErr) { console.warn('[analyze] cleanup trigger failed:', cleanupErr.message); }

  const recMeta = getRecommendationMeta(finalData.recommendation);
  const confInterp = interpretConfidence(judgeConfidence);
  const recommendationAdjusted = originalJudgeRec != null && finalData.recommendation !== originalJudgeRec;

  return jsonResponse({
    score: referenceScore,
    recommendation: finalData.recommendation,
    recommendation_label: recMeta.label,
    recommendation_hint: recMeta.hint,
    recommendation_adjusted: recommendationAdjusted,
    original_recommendation: recommendationAdjusted ? originalJudgeRec : undefined,
    confidence: judgeConfidence,
    confidence_interpretation: confInterp,
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
    trend_history_scope: 'global',
    saved,
    save_skip_reason: saveSkipReason,
    cleanup_triggered: cleanupTriggered,
  });
}