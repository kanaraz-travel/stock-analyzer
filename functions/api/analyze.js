// functions/api/analyze.js
import { createClient } from '@supabase/supabase-js';
import {
  VALID_RECS_BUY, VALID_RECS_SELL, normalizeRecommendation, validateAnalyzeInput,
  validateNewsOutput, validateTrendOutput, computeDataQuality,
  loadRecentTrendHistory, summarizeTrendHistory, deriveConsistencyThreshold,
  needsHighConfidenceForLevelJump, computeReferenceScore, saveAnalysisRun, cleanupOldRuns,
  getRecommendationMeta, interpretConfidence, jsonResponse, buildPriceVolumeFacts
} from './_pipeline.js';
import { runNewsAgent, runTrendAgent, runJudgeAgent } from './_agents.js';
import { buildRuleBasedFallback } from './_fallback.js';

const RULESET_VERSION = 'RULESET_AI_V25_12_OPTIMIZED';
const MAX_BODY_BYTES = 100 * 1024;
const CLEANUP_PROBABILITY = 0.2;

export async function onRequestPost(context) {
  // ... (인증 및 검증 로직 기존과 동일) ...

  const dataQuality = computeDataQuality(price_data);
  const isStale = price_data?.price_source === 'STALE';

  if (dataQuality.status === 'UNKNOWN' || dataQuality.status === 'INSUFFICIENT') {
    return jsonResponse({ recommendation: '판단 보류', overall_summary: '시세 기준 시각 확인 불가로 판단을 보류합니다.', fallback: true, fallback_reason: 'DATA_INSUFFICIENT' });
  }

  const referenceScore = computeReferenceScore(price_data);
  let finalData = null;
  let isFallback = false;
  let fallbackReason = null;
  let quotaExceeded = false;

  const agentStatus = { news: { ok: false }, trend: { ok: false }, judge: { ok: false } };
  
  // T6: PV 에이전트는 코드로 즉시 생성
  const pvResult = buildPriceVolumeFacts(price_data, volume_data, analysis_type);
  agentStatus.price_volume = { ok: true, status: 'success', reason: 'RULE_BASED' };

  try {
    if (!env.AI) throw new Error('AI_NOT_CONFIGURED');

    // ... (이전 판단 조회 및 추세 이력 조회 로직 기존과 동일) ...
    const previousRec = null; // 임시
    const trendSummary = null; // 임시

    // T4: 병렬 처리 (뉴스만 호출)
    const newsRaw = await runNewsAgent(env, { ticker, stock_name, news_items });
    if (newsRaw.code === 'AI_QUOTA_EXCEEDED') quotaExceeded = true;
    else if (newsRaw.status === 'success') { newsResult = newsRaw; agentStatus.news = { ok: true }; }

    let trendResult = null;
    if (!quotaExceeded) {
      const trendRaw = await runTrendAgent(env, { ticker, stock_name, analysis_type, price_data, volume_data, price_volume_result: pvResult, news_result: newsResult, trend_history_summary: trendSummary });
      if (trendRaw.code === 'AI_QUOTA_EXCEEDED') quotaExceeded = true;
      else if (!trendRaw.__exception) { trendResult = trendRaw; agentStatus.trend = { ok: true }; }
    }

    let judgeResult = null;
    if (!quotaExceeded) {
      const judgeRaw = await runJudgeAgent(env, { ticker, stock_name, analysis_type, holdings_data, price_data, price_volume_result: pvResult, news_result: newsResult, trend_result: trendResult, trend_history_summary: trendSummary, previous_recommendation: previousRec });
      if (judgeRaw.code === 'AI_QUOTA_EXCEEDED') quotaExceeded = true;
      else if (!judgeRaw.__exception) { judgeResult = judgeRaw; agentStatus.judge = { ok: true }; }
    }

    // ★ 폴백 분기
    if (quotaExceeded) {
      isFallback = true;
      fallbackReason = 'AI_QUOTA_EXCEEDED';
      finalData = buildRuleBasedFallback({ price_data, volume_data, analysis_type, trendResult });
    } else if (!judgeResult) {
      isFallback = true;
      fallbackReason = 'JUDGE_FAILED';
      finalData = buildRuleBasedFallback({ price_data, volume_data, analysis_type, trendResult });
    } else {
      // 정상 처리
      originalJudgeRec = normalizeRecommendation(judgeResult.recommendation, analysis_type);
      judgeConfidence = judgeResult.confidence;
      finalData = { recommendation: originalJudgeRec, overall_summary: judgeResult.overall_summary };
      // ... (일관성 보정 및 강도 하향 로직 기존과 동일) ...
    }

  } catch (e) {
    isFallback = true;
    fallbackReason = e.message === 'AI_QUOTA_EXCEEDED' ? 'AI_QUOTA_EXCEEDED' : 'AI_ERROR';
    finalData = buildRuleBasedFallback({ price_data, volume_data, analysis_type });
  }

  // 저장 로직: isFallback이면 저장 스킵
  let saved = false;
  if (!isFallback) {
    // ... DB 저장 ...
    saved = true;
  }

  return jsonResponse({
    recommendation: finalData.recommendation,
    overall_summary: finalData.overall_summary,
    fallback: isFallback,
    fallback_reason: fallbackReason,
    retry_hint: quotaExceeded ? '한국시간 오전 9시 이후 다시 시도해 주세요.' : undefined,
    agent_status: agentStatus,
    saved,
  });
}