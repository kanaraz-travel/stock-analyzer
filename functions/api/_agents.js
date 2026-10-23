// functions/api/_agents.js
import { buildNewsPrompts, buildNewsRetryPrompts, buildTrendPrompts, buildJudgePrompts } from './_prompts.js';
import { MODELS } from './_constants.js';

function isQuotaError(e) {
  const msg = String(e?.message || e);
  return msg.includes('4006') || msg.includes('daily free allocation');
}

async function callAiWithRetry(env, modelKey, messages, maxTokens, temperature) {
  const modelId = MODELS[modelKey] || MODELS.judge;
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) { // 재시도 횟수 2회로 축소
    try {
      const response = await env.AI.run(modelId, { messages, max_tokens: maxTokens, temperature });
      if (response && response.error) throw new Error(response.error);
      return response;
    } catch (e) {
      lastError = e;
      if (isQuotaError(e)) {
        const err = new Error('AI_QUOTA_EXCEEDED');
        err.code = 'AI_QUOTA_EXCEEDED';
        throw err;
      }
      if (attempt < 1) await new Promise(r => setTimeout(r, 1000));
    }
  }
  throw lastError;
}

// [1] 가격/거래량은 _pipeline.js의 buildPriceVolumeFacts로 대체되었으므로 여기서 삭제

// [2] 뉴스 분석가
export async function runNewsAgent(env, payload) {
  const prompts = buildNewsPrompts(payload);
  if (prompts.isEmpty) return { news_analysis: '관련 뉴스 없음.', news_sentiment: '중립', news_direction: '중립', news_impact: '약', key_theme: '-', status: 'success' };

  try {
    const response = await callAiWithRetry(env, 'news', [
      { role: 'system', content: prompts.system },
      { role: 'user', content: prompts.user }
    ], 250, 0.3); // T7: 토큰 축소

    const parsed = extractJSON(response?.response || '');
    let newsText = typeof parsed.news_analysis === 'string' ? parsed.news_analysis : '';
    
    // 뉴런 낭비 방지를 위해 재시도 로직 제거 (Claude T1)
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

// [3] 추세 분석가
export async function runTrendAgent(env, payload) {
  const { system, user } = buildTrendPrompts(payload);
  try {
    const response = await callAiWithRetry(env, 'trend', [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ], 350, 0.2); // T7: 토큰 축소
    return normalizeTrendResult(extractJSON(response?.response || ''));
  } catch (e) {
    console.error('[trend agent error]', e.message);
    return { __exception: true, code: e.code, message: e.message };
  }
}

// [4] 심판 에이전트
export async function runJudgeAgent(env, payload) {
  const { system, user } = buildJudgePrompts(payload);
  try {
    const response = await callAiWithRetry(env, 'judge', [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ], 600, 0.1); // T7: 토큰 축소

    const parsed = extractJSON(response?.response || '');
    if (typeof parsed.recommendation !== 'string' || typeof parsed.overall_summary !== 'string') {
      return { __exception: true, message: 'INVALID_JUDGE_FORMAT' };
    }
    return parsed;
  } catch (e) {
    console.error('[judge agent error]', e.message);
    return { __exception: true, code: e.code, message: e.message };
  }
}

// ... (헬퍼 함수 동일)