// functions/api/_agents.js
import {
  buildPriceVolumePrompts,
  buildNewsPrompts,
  buildNewsRetryPrompts,
  buildTrendPrompts,
  buildJudgePrompts,
} from './_prompts.js';

const MODEL_ID = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

// ★ AI 호출 공통 래퍼 (재시도 로직 포함)
async function callAiWithRetry(env, messages, maxTokens, temperature) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await env.AI.run(MODEL_ID, {
        messages,
        max_tokens: maxTokens,
        temperature,
      });
      
      // Cloudflare AI 응답에 에러가 포함된 경우 감지
      if (response && response.error) {
        throw new Error(response.error);
      }
      
      return response;
    } catch (e) {
      lastError = e;
      console.warn(`[AI Retry] Attempt ${attempt + 1} failed: ${e.message}`);
      if (attempt < 2) {
        // 1초, 2초 대기 후 재시도
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
      }
    }
  }
  throw lastError;
}

// ─────────────────────────────────────────────────────────────
// [1] 가격·거래량 분석가
// ─────────────────────────────────────────────────────────────
export async function runPriceVolumeAgent(env, payload) {
  const { system, user } = buildPriceVolumePrompts(payload);
  try {
    const response = await callAiWithRetry(env, [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ], 512, 0.1);
    return extractJSON(response?.response || '');
  } catch (e) {
    console.error('[pv agent error]', e.message);
    return { __exception: true, message: e.message };
  }
}

// ─────────────────────────────────────────────────────────────
// [2] 뉴스 분석가
// ─────────────────────────────────────────────────────────────
export async function runNewsAgent(env, payload) {
  const prompts = buildNewsPrompts(payload);

  if (prompts.isEmpty) {
    return {
      news_analysis: payload.news_items && payload.news_items.length > 0
        ? '유효한 뉴스 제목이 없음.'
        : '최근 확인된 관련 뉴스가 없음.',
      news_sentiment: '중립', news_direction: '중립', news_impact: '약',
      key_theme: '-', status: 'success',
    };
  }

  try {
    const response = await callAiWithRetry(env, [
      { role: 'system', content: prompts.system },
      { role: 'user', content: prompts.user }
    ], 600, 0.3);

    const parsed = extractJSON(response?.response || '');
    let newsText = typeof parsed.news_analysis === 'string' ? parsed.news_analysis : '';

    if (isNegativeNewsResponse(newsText)) {
      console.log(`[news] 1차 응답 "없음" → 재시도`);
      try {
        const retry = buildNewsRetryPrompts({
          stock_name: payload.stock_name,
          newsJson: prompts.newsJson,
        });
        const retryResponse = await callAiWithRetry(env, [
          { role: 'system', content: retry.system },
          { role: 'user', content: retry.user }
        ], 500, 0.4);
        
        const retryParsed = extractJSON(retryResponse?.response || '');
        if (isValidNewsPayload(retryParsed)) {
          return {
            news_analysis: retryParsed.news_analysis,
            news_sentiment: normalizeNewsSentiment(retryParsed.news_sentiment),
            news_direction: normalizeNewsDirection(retryParsed.news_direction),
            news_impact: normalizeNewsImpact(retryParsed.news_impact),
            key_theme: typeof retryParsed.key_theme === 'string' ? retryParsed.key_theme.slice(0, 30) : '-',
            status: 'success',
          };
        }
      } catch (e) { console.warn('[news] retry failed:', e.message); }
    }

    if (!newsText || isNegativeNewsResponse(newsText)) {
      newsText = `최근 수집된 ${prompts.itemCount}건의 관련 기사에서 뚜렷한 주가 영향 요인은 확인되지 않았음.`;
    }

    return {
      news_analysis: newsText,
      news_sentiment: normalizeNewsSentiment(parsed.news_sentiment),
      news_direction: normalizeNewsDirection(parsed.news_direction),
      news_impact: normalizeNewsImpact(parsed.news_impact),
      key_theme: typeof parsed.key_theme === 'string' ? parsed.key_theme.slice(0, 30) : '-',
      status: 'success',
    };
  } catch (e) {
    console.error('뉴스 에이전트 오류:', e.message);
    return {
      news_analysis: '뉴스 분석 중 일시적 오류가 발생했음.',
      news_sentiment: '중립', news_direction: '중립', news_impact: '약',
      key_theme: '-', status: 'error', __exception: true, message: e.message
    };
  }
}

function isValidNewsPayload(p) {
  return p
    && typeof p.news_analysis === 'string' && p.news_analysis.trim()
    && !isNegativeNewsResponse(p.news_analysis)
    && typeof p.news_sentiment === 'string';
}

// ─────────────────────────────────────────────────────────────
// [3] 추세 분석가
// ─────────────────────────────────────────────────────────────
export async function runTrendAgent(env, payload) {
  const { system, user } = buildTrendPrompts(payload);
  try {
    const response = await callAiWithRetry(env, [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ], 700, 0.2);
    return normalizeTrendResult(extractJSON(response?.response || ''));
  } catch (e) {
    console.error('[trend agent error]', e.message);
    return { __exception: true, message: e.message };
  }
}

// ─────────────────────────────────────────────────────────────
// [4] 심판 에이전트
// ─────────────────────────────────────────────────────────────
export async function runJudgeAgent(env, payload) {
  const { system, user } = buildJudgePrompts(payload);

  let parsed = {};
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await callAiWithRetry(env, [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ], 1024, 0.1);

      parsed = extractJSON(response?.response || '');
      const hasRec = typeof parsed.recommendation === 'string' && parsed.recommendation.trim();
      const hasSummary = typeof parsed.overall_summary === 'string' && parsed.overall_summary.trim();
      
      if (hasRec && hasSummary) return parsed;
      console.warn(`[judge] attempt ${attempt + 1} missing fields`);
    } catch (e) {
      console.warn(`[judge] attempt ${attempt + 1} error:`, e.message);
      if (attempt === 1) return { __exception: true, message: e.message };
    }
    if (attempt === 0) await new Promise(r => setTimeout(r, 1000));
  }
  return { __exception: true, message: 'EMPTY_RESPONSE' };
}

// ─────────────────────────────────────────────────────────────
// 응답 파싱 / 정규화 헬퍼
// ─────────────────────────────────────────────────────────────
function isNegativeNewsResponse(text) {
  if (!text) return true;
  const t = String(text);
  if (t.includes('주가에 영향을 줄 만한 뉴스가 없')) return true;
  if (t.includes('관련 뉴스가 없')) return true;
  if (t.includes('확인된 뉴스가 없')) return true;
  if (t.includes('관련된 뉴스가 없')) return true;
  if (t.trim().length < 20 && /없/.test(t)) return true;
  return false;
}

function normalizeNewsSentiment(s) {
  if (typeof s !== 'string') return '중립';
  const v = s.trim();
  return ['긍정', '중립', '부정'].includes(v) ? v : '중립';
}
function normalizeNewsDirection(d) {
  if (typeof d !== 'string') return '중립';
  const v = d.trim();
  return ['호재', '악재', '중립'].includes(v) ? v : '중립';
}
function normalizeNewsImpact(i) {
  if (typeof i !== 'string') return '약';
  const v = i.trim();
  return ['강', '중', '약'].includes(v) ? v : '약';
}

function normalizeTrendResult(t) {
  if (!t || typeof t !== 'object') return null;
  const result = {};
  if (['상승', '횡보', '하락'].includes(t.short_term_trend)) result.short_term_trend = t.short_term_trend;
  if (['상승', '횡보', '하락'].includes(t.medium_term_trend)) result.medium_term_trend = t.medium_term_trend;
  if (['강', '중', '약'].includes(t.trend_strength)) result.trend_strength = t.trend_strength;
  if (typeof t.trend_confidence === 'number' && Number.isFinite(t.trend_confidence)
      && t.trend_confidence >= 0 && t.trend_confidence <= 1) {
    result.trend_confidence = t.trend_confidence;
  }
  if (typeof t.trend_reasoning === 'string' && t.trend_reasoning.length > 0) {
    result.trend_reasoning = t.trend_reasoning.slice(0, 500);
  }
  if (Array.isArray(t.key_drivers)) {
    result.key_drivers = t.key_drivers.filter(d => typeof d === 'string' && d.length > 0).slice(0, 5);
  }
  if (Array.isArray(t.risk_factors)) {
    result.risk_factors = t.risk_factors.filter(d => typeof d === 'string' && d.length > 0).slice(0, 5);
  }
  return Object.keys(result).length > 0 ? result : { __exception: true, message: 'INVALID_TREND_RESULT' };
}

function extractJSON(data) {
  if (data == null) return {};
  if (typeof data === 'object') return data;
  const text = String(data);
  const jsonStart = text.indexOf('{');
  const jsonEnd = text.lastIndexOf('}');
  if (jsonStart === -1 || jsonEnd === -1) return {};
  try { return JSON.parse(text.substring(jsonStart, jsonEnd + 1)); } catch { return {}; }
}