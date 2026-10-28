// functions/api/analyze.js
// ... (상단 생략) ...

    // [2] 뉴스
    const newsRaw = await runNewsAgent(env, { ticker, stock_name, news_items });
    if (newsRaw.code === 'AI_QUOTA_EXCEEDED') quotaExceeded = true;
    else if (newsRaw.code === 'AI_MODEL_DEPRECATED') modelDeprecated = true;
    else if (newsRaw.status === 'success' && validateNewsOutput(newsRaw).valid) {
      newsResult = newsRaw; agentStatus.news = { ok: true };
    } // ... (이하 동일)

    // [3] 추세
    // ... (동일) ...

    // ★ 판단 근거 부재 확인 (뉴스 0건 + 과거 데이터 없음)
    const hasNoNews = !news_items || news_items.length === 0;
    const hasNoHistory = !price_data.return_1m && !price_data.ma20_disparity; // 과거 데이터가 아예 없음
    const criticalAgentsFailed = (!newsResult && !trendResult) || (hasNoNews && hasNoHistory);

    if (quotaExceeded) {
      // ...
    } else if (modelDeprecated) {
      // ...
    } else if (criticalAgentsFailed) {
      // ★ 판단 근거가 없으면 심판 호출 없이 즉시 폴백
      isFallback = true; fallbackReason = 'CRITICAL_AGENT_FAILURE';
      finalData = buildRuleBasedFallback({ price_data, volume_data, analysis_type, trendResult });
    } else {
      // [4] 심판
      // ... (동일) ...
    }

// ... (이하 생략) ...