// functions/api/analyze.js
import { createClient } from '@supabase/supabase-js';
import {
  normalizeRecommendation, validateAnalyzeInput,
  validateNewsOutput, validateTrendOutput, computeDataQuality,
  loadRecentTrendHistory, summarizeTrendHistory, deriveConsistencyThreshold,
  needsHighConfidenceForLevelJump, saveAnalysisRun, cleanupOldRuns,
  jsonResponse, buildPriceVolumeFacts, getFallbackMessage
} from './_pipeline.js';
import { runNewsAgent, runTrendAgent, runJudgeAgent } from './_agents.js';
import { buildRuleBasedFallback } from './_fallback.js';

const RULESET_VERSION = 'RULESET_AI_V25_12_OPTIMIZED';
const MAX_BODY_BYTES = 100 * 1024;
const CLEANUP_PROBABILITY = 0.2;

export async function onRequestPost(context) {
  const { request, env } = context;

  // ─── 인증 ───
  const authHeader = request.headers.get('authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return jsonResponse({ error: '인증이 필요합니다.' }, 401);

  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return jsonResponse({ error: '서버 설정 오류입니다.' }, 500);
  }

  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  let userId;
  try {
    const { data: userData, error: authError } = await supabase.auth.getUser(token);
    if (authError || !userData?.user) return jsonResponse({ error: '인증이 유효하지 않습니다.' }, 401);
    userId = userData.user.id;
  } catch {
    return jsonResponse({ error: '인증 처리 중 오류가 발생했습니다.' }, 401);
  }

  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > MAX_BODY_BYTES) return jsonResponse({ error: '요청 본문이 너무 큽니다.' }, 413);

  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: '요청 본문이 JSON이 아닙니다.' }, 400); }

  const validation = validateAnalyzeInput(body);
  if (!validation.valid) return jsonResponse({ error: '입력 데이터가 유효하지 않습니다.', details: validation.errors }, 400);

  const { ticker, stock_name, price_data, volume_data, news_items, holdings_data } = body;
  
  // 관점(analysis_type)과 보유 데이터(holdings_data)의 정합성 서버 단 검증
  let analysis_type = body.analysis_type === 'sell' ? 'sell' : 'buy';
  if (analysis_type === 'sell' && (!holdings_data || holdings_data.quantity <= 0)) {
    console.warn(`[analyze] sell 관점 요청이지만 보유 데이터가 없음. buy로 강제 전환 (${ticker})`);
    analysis_type = 'buy';
  }

  const dataQuality = computeDataQuality(price_data);
  if (dataQuality.status === 'UNKNOWN') {
    return jsonResponse({
      recommendation: '판단 보류',
      overall_summary: '시세 기준 시각을 확인할 수 없어 판단을 보류합니다. 잠시 후 다시 시도해 주세요.',
      fallback: true,
      fallback_reason: 'DATA_INSUFFICIENT',
      fallback_message: getFallbackMessage('DATA_INSUFFICIENT'),
      saved: false,
    });
  }

  let finalData = null;
  let isFallback = false;
  let fallbackReason = null;
  let quotaExceeded = false;
  let modelDeprecated = false;
  let newsResult = null;
  let trendResult = null;
  let judgeResult = null;
  let previousRec = null;
  let trendSummary = null;

  // ★ 저장 성공 여부를 추적하는 변수
  let saved = false;
  const agentStatus = { news: { ok: false }, trend: { ok: false }, judge: { ok: false } };

  try {
    const [prevRecRes, trendHistoryRes] = await Promise.all([
      loadPreviousRecommendation(supabase, ticker, analysis_type).catch(() => null),
      loadRecentTrendHistory(env, ticker).catch(() => ({ status: 'unavailable', entries: [] })),
    ]);
    previousRec = prevRecRes;
    trendSummary = summarizeTrendHistory(trendHistoryRes?.entries || [], trendHistoryRes?.status || 'unavailable');

    const pvResult = buildPriceVolumeFacts(price_data, volume_data, analysis_type);
    agentStatus.price_volume = { ok: true, status: 'success', reason: 'RULE_BASED' };

    if (!env.AI) throw new Error('AI_NOT_CONFIGURED');

    // [2] 뉴스
    const newsRaw = await runNewsAgent(env, { ticker, stock_name, news_items });
    if (newsRaw.code === 'AI_QUOTA_EXCEEDED') quotaExceeded = true;
    else if (newsRaw.code === 'AI_MODEL_DEPRECATED') modelDeprecated = true;
    else if (newsRaw.status === 'success' && validateNewsOutput(newsRaw).valid) {
      newsResult = newsRaw; agentStatus.news = { ok: true };
    } else if (newsRaw.status === 'error') {
      agentStatus.news = { ok: false, reason: 'AGENT_ERROR' };
    } else {
      agentStatus.news = { ok: false, reason: 'INVALID_OUTPUT' };
    }

    // [3] 추세
    if (!quotaExceeded && !modelDeprecated) {
      const trendRaw = await runTrendAgent(env, {
        ticker, stock_name, analysis_type, price_data, volume_data,
        price_volume_result: pvResult,
        news_result: newsResult,
        trend_history_summary: trendSummary,
      });
      if (trendRaw.code === 'AI_QUOTA_EXCEEDED') quotaExceeded = true;
      else if (trendRaw.code === 'AI_MODEL_DEPRECATED') modelDeprecated = true;
      else if (!trendRaw.__exception) {
        const tv = validateTrendOutput(trendRaw);
        if (tv.valid) { trendResult = trendRaw; agentStatus.trend = { ok: true }; }
        else {
          agentStatus.trend = { ok: false, reason: tv.reason };
          console.warn(`[analyze] Trend validation failed (${tv.reason}):`, JSON.stringify(trendRaw));
        }
      } else {
        agentStatus.trend = { ok: false, reason: trendRaw.message || 'EXCEPTION' };
      }
    }

    // P0-3: 뉴스·추세 둘 다 결과가 없으면 심판 결과를 신뢰하지 않음
    const criticalAgentsFailed = (!newsResult && !trendResult);

    if (quotaExceeded) {
      isFallback = true; fallbackReason = 'AI_QUOTA_EXCEEDED';
      finalData = buildRuleBasedFallback({ price_data, volume_data, analysis_type, trendResult });
    } else if (modelDeprecated) {
      isFallback = true; fallbackReason = 'AI_MODEL_DEPRECATED';
      finalData = buildRuleBasedFallback({ price_data, volume_data, analysis_type, trendResult });
    } else if (criticalAgentsFailed) {
      isFallback = true; fallbackReason = 'CRITICAL_AGENT_FAILURE';
      finalData = buildRuleBasedFallback({ price_data, volume_data, analysis_type, trendResult });
    } else {
      // [4] 심판
      const judgeRaw = await runJudgeAgent(env, {
        ticker, stock_name, analysis_type, holdings_data, price_data,
        price_volume_result: pvResult,
        news_result: newsResult,
        trend_result: trendResult,
        trend_history_summary: trendSummary,
        previous_recommendation: previousRec?.recommendation || null,
      });
      if (judgeRaw.code === 'AI_QUOTA_EXCEEDED') { quotaExceeded = true; }
      else if (judgeRaw.code === 'AI_MODEL_DEPRECATED') { modelDeprecated = true; }
      else if (!judgeRaw.__exception) { judgeResult = judgeRaw; agentStatus.judge = { ok: true }; }
      else { agentStatus.judge = { ok: false, reason: judgeRaw.message || 'EXCEPTION' }; }

      if (quotaExceeded) {
        isFallback = true; fallbackReason = 'AI_QUOTA_EXCEEDED';
        finalData = buildRuleBasedFallback({ price_data, volume_data, analysis_type, trendResult });
      } else if (modelDeprecated) {
        isFallback = true; fallbackReason = 'AI_MODEL_DEPRECATED';
        finalData = buildRuleBasedFallback({ price_data, volume_data, analysis_type, trendResult });
      } else if (!judgeResult) {
        isFallback = true; fallbackReason = 'JUDGE_FAILED';
        finalData = buildRuleBasedFallback({ price_data, volume_data, analysis_type, trendResult });
      } else {
        const normalizedRec = normalizeRecommendation(judgeResult.recommendation, analysis_type);
        if (!normalizedRec) {
          isFallback = true; fallbackReason = 'JUDGE_INVALID_REC';
          finalData = buildRuleBasedFallback({ price_data, volume_data, analysis_type, trendResult });
        } else {
          let finalRec = normalizedRec;
          let judgeConfidence = Number(judgeResult.confidence);
          if (!Number.isFinite(judgeConfidence)) judgeConfidence = 0.5;

          if (trendResult?.trend_strength === '약') {
            if (finalRec === '매수 추천') finalRec = '매수 고려';
            else if (finalRec === '매도 추천') finalRec = '매도 고려';
          }

          let consistencyNote = '';
          if (previousRec?.recommendation) {
            const threshold = deriveConsistencyThreshold(previousRec.analyzed_at, trendSummary?.flips_short || 0);
            if (needsHighConfidenceForLevelJump(previousRec.recommendation, finalRec) && judgeConfidence < threshold) {
              finalRec = previousRec.recommendation;
              consistencyNote = '[판단 유지] ';
            } else if (finalRec === previousRec.recommendation) {
              consistencyNote = '[판단 유지] ';
            }
          }

          finalData = {
            recommendation: finalRec,
            overall_summary: consistencyNote + (judgeResult.overall_summary || '-'),
            confidence: judgeConfidence,
            original_judge_recommendation: normalizedRec,
          };
        }
      }
    }

    // DB 저장 (정상 결과만)
    if (!isFallback && finalData) {
      try {
        await saveAnalysisRun(supabase, {
          user_id: userId, ticker, stock_name, analysis_type,
          analyzed_at: new Date().toISOString(),
          recommendation: finalData.recommendation,
          overall_summary: finalData.overall_summary,
          ruleset_version: RULESET_VERSION,
          market_facts: {
            price_data, volume_data,
            holdings_data: holdings_data || null,
            agent_outputs: { price_volume: pvResult, news: newsResult, trend: trendResult, judge: judgeResult },
            agent_status: agentStatus,
            data_quality_note: dataQuality.status,
            judge_confidence: finalData.confidence ?? null,
            trend_history_summary: {
              count: trendSummary.count, distinct_days: trendSummary.distinct_days,
              stability: trendSummary.stability, flips_short: trendSummary.flips_short,
              flips_medium: trendSummary.flips_medium, sample_mode: trendSummary.sample_mode,
            },
          },
        });
        saved = true; // ★ DB 저장 성공 시 true로 변경 (누락되어 있던 부분)
        if (Math.random() < CLEANUP_PROBABILITY) { try { await cleanupOldRuns(env, userId); } catch {} }
      } catch (e) { 
        console.error('[analyze] save failed:', e.message); 
        saved = false;
      }
    }

  } catch (e) {
    console.error('[analyze] Unhandled exception:', e);
    isFallback = true;
    fallbackReason = e.message === 'AI_QUOTA_EXCEEDED' ? 'AI_QUOTA_EXCEEDED' : 'AI_ERROR';
    finalData = buildRuleBasedFallback({ price_data, volume_data, analysis_type, trendResult });
  }

  return jsonResponse({
    recommendation: finalData?.recommendation || '판단 보류',
    overall_summary: finalData?.overall_summary || '-',
    fallback: isFallback,
    fallback_reason: fallbackReason,
    fallback_message: isFallback ? getFallbackMessage(fallbackReason) : undefined,
    retry_hint: quotaExceeded ? '한국시간 오전 9시 이후 다시 시도해 주세요.' : undefined,
    agent_status: agentStatus,
    saved: saved, // ★ 수정된 저장 성공 여부 반환
  });
}

async function loadPreviousRecommendation(supabase, ticker, analysisType) {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('stock_analysis_runs')
    .select('recommendation, analyzed_at')
    .eq('ticker', ticker)
    .eq('analysis_type', analysisType)
    .gte('analyzed_at', since)
    .order('analyzed_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) { console.warn('[loadPreviousRec] query failed:', error.message); return null; }
  return data || null;
}