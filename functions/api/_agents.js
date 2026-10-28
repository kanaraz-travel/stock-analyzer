// functions/api/_agents.js
import { buildNewsPrompts, buildTrendPrompts, buildJudgePrompts } from './_prompts.js';
import { MODELS } from './_constants.js';

function isQuotaError(e) {
  const msg = String(e?.message || e);
  return msg.includes('4006') || msg.includes('daily free allocation') || msg.includes('quota');
}

function isDeprecatedModelError(e) {
  const msg = String(e?.message || e);
  return msg.includes('5028') || msg.includes('410') || msg.toLowerCase().includes('deprecated');
}

async function callAiWithRetry(env, modelKey, messages, maxTokens, temperature) {
  const modelId = MODELS[modelKey] || MODELS.judge;
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await env.AI.run(modelId, { messages, max_tokens: maxTokens, temperature });
      if (response && response.error) throw new Error(response.error);
      return response;
    } catch (e) {
      lastError = e;
      console.error(`[AI Error] Model: ${modelId}, Attempt: ${attempt + 1}, Error:`, e.message, JSON.stringify(e));

      if (isQuotaError(e)) {
        const err = new Error('AI_QUOTA_EXCEEDED');
        err.code = 'AI_QUOTA_EXCEEDED';
        throw err;
      }
      if (isDeprecatedModelError(e)) {
        const err = new Error('AI_MODEL_DEPRECATED');
        err.code = 'AI_MODEL_DEPRECATED';
        throw err;
      }
      if (attempt < 1) await new Promise(r => setTimeout(r, 1000));
    }
  }
  throw lastError;
}

function extractAiText(response) {
  if (!response) return '';
  if (typeof response.response === 'string' && response.response) return response.response;
  if (Array.isArray(response.choices) && response.choices[0]?.message?.content) {
    return response.choices[0].message.content;
  }
  if (typeof response.result === 'string') return response.result;
  return '';
}

export async function runNewsAgent(env, payload) {
  const prompts = buildNewsPrompts(payload);
  if (prompts.isEmpty) return { news_analysis: '관련 뉴스 없음.', news_sentiment: '중립', news_direction: '중립', news_impact: '약', key_theme: '-', status: 'success' };

  try {
    const response = await callAiWithRetry(env, 'news', [
      { role: 'system', content: prompts.system },
      { role: 'user', content: prompts.user }
    ], 250, 0.3);

    const parsed = extractJSON(extractAiText(response));
    let newsText = typeof parsed.news_analysis === 'string' ? parsed.news_analysis : '';
    if (!newsText || isNegativeNewsResponse(newsText)) {
      newsText = `수집된 ${prompts.itemCount}건의 기사에서 뚜렷한 주가 영향 요인은 확인되지 않았음.`;
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
    return { news_analysis: '뉴스 분석 실패.', news_sentiment: '중립', news_direction: '중립', news_impact: '약', key_theme: '-', status: 'error', code: e.code };
  }
}

export async function runTrendAgent(env, payload) {
  const { system, user } = buildTrendPrompts(payload);
  try {
    const response = await callAiWithRetry(env, 'trend', [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ], 350, 0.2);
    return normalizeTrendResult(extractJSON(extractAiText(response)));
  } catch (e) {
    console.error('[trend agent error]', e.message);
    return { __exception: true, code: e.code, message: e.message };
  }
}

export async function runJudgeAgent(env, payload) {
  const { system, user } = buildJudgePrompts(payload);
  try {
    const response = await callAiWithRetry(env, 'judge', [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ], 800, 0.1); // ★ 토큰을 600에서 800으로 늘려 응답 잘림 방지

    const rawText = extractAiText(response);
    const parsed = extractJSON(rawText);
    
    if (typeof parsed.recommendation !== 'string' || typeof parsed.overall_summary !== 'string') {
      console.error('[judge agent] INVALID_JUDGE_FORMAT. Raw response:', rawText);
      return { __exception: true, message: 'INVALID_JUDGE_FORMAT' };
    }
    return parsed;
  } catch (e) {
    console.error('[judge agent error]', e.message);
    return { __exception: true, code: e.code, message: e.message };
  }
}

function extractJSON(text) {
  if (!text || typeof text !== 'string') return {};
  const trimmed = text.trim();
  try { return JSON.parse(trimmed); } catch {}

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1].trim()); } catch {}
  }

  const start = trimmed.indexOf('{');
  if (start < 0) return {};

  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\' && inString) { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(trimmed.slice(start, i + 1)); } catch { return {}; }
      }
    }
  }
  return {};
}

function isNegativeNewsResponse(text) {
  if (!text || typeof text !== 'string') return true;
  const t = text.trim();
  if (t.length < 10) return true;
  if (/^(없음|없습니다|모르겠|알 수 없|판단 불가|분석 불가)\.?$/.test(t)) return true;
  return false;
}

function normalizeNewsSentiment(v) {
  if (v === '긍정' || v === '중립' || v === '부정') return v;
  const s = String(v || '').trim();
  if (/긍정|호재|좋/.test(s)) return '긍정';
  if (/부정|악재|나쁘/.test(s)) return '부정';
  return '중립';
}

function normalizeNewsDirection(v) {
  if (v === '호재' || v === '악재' || v === '중립') return v;
  const s = String(v || '').trim();
  if (/호재|긍정/.test(s)) return '호재';
  if (/악재|부정/.test(s)) return '악재';
  return '중립';
}

function normalizeNewsImpact(v) {
  if (v === '강' || v === '중' || v === '약') return v;
  const s = String(v || '').trim();
  if (/강/.test(s)) return '강';
  if (/약/.test(s)) return '약';
  return '중';
}

function normalizeTrendResult(parsed) {
  if (!parsed || typeof parsed !== 'object') return { __exception: true, message: 'INVALID_TREND_FORMAT' };
  const shortTerm = ['상승', '횡보', '하락'].includes(parsed.short_term_trend) ? parsed.short_term_trend : null;
  const mediumTerm = ['상승', '횡보', '하락'].includes(parsed.medium_term_trend) ? parsed.medium_term_trend : null;
  const strength = ['강', '중', '약'].includes(parsed.trend_strength) ? parsed.trend_strength : null;
  let confidence = Number(parsed.trend_confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) confidence = null;

  if (!shortTerm || !mediumTerm || !strength || confidence == null) {
    return { __exception: true, message: 'INVALID_TREND_FIELDS' };
  }
  return {
    short_term_trend: shortTerm,
    medium_term_trend: mediumTerm,
    trend_strength: strength,
    trend_confidence: confidence,
    trend_reasoning: typeof parsed.trend_reasoning === 'string' ? parsed.trend_reasoning : '-',
    key_drivers: Array.isArray(parsed.key_drivers) ? parsed.key_drivers.slice(0, 5) : [],
    risk_factors: Array.isArray(parsed.risk_factors) ? parsed.risk_factors.slice(0, 3) : [],
  };
}