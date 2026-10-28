// functions/api/_agents.js
// ... (상단 생략) ...

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

// ... (extractJSON 등 헬퍼 함수 생략) ...