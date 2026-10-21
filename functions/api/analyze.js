// functions/api/analyze.js
import { createClient } from '@supabase/supabase-js';

const RULESET_VERSION = 'RULESET_AI_V19_REVIEW_FIXED';
const MAX_BODY_BYTES = 100 * 1024;
const MAX_NEWS_ITEMS = 20;
const MAX_URL_LENGTH = 2048;

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

  // ★ 개선: 실제 UTF-8 바이트 수 검사
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

  // 데이터 부족 → 판단 보류 강제
  if (dataQuality.status === 'UNKNOWN' || dataQuality.status === 'INSUFFICIENT') {
    const ret = {
      score: null,
      recommendation: '판단 보류',
      overall_summary: '시세 기준 시각을 확인할 수 없거나 데이터가 부족하여 판단을 보류합니다.',
      price_flow_summary: '데이터 부족으로 분석 불가',
      volume_summary: '데이터 부족으로 분석 불가',
      news_analysis: '데이터 부족으로 분석 불가',
      news_agent_status: 'skipped',
      data_quality: dataQuality,
      fallback: true,
      fallback_reason: 'DATA_INSUFFICIENT',
      ruleset_version: RULESET_VERSION,
    };
    try {
      await saveAnalysisRun(supabase, {
        user_id: userId, ticker, stock_name,
        quote_price: price_data.current_price ?? null,
        quote_as_of: price_data.quote_as_of ?? null,
        data_status: dataQuality.status,
        score: null, recommendation: '판단 보류',
        ruleset_version: RULESET_VERSION,
        market_facts: { price_data, volume_data, news_items, analysis_type, holdings_data },
        overall_summary: ret.overall_summary, price_flow_summary: ret.price_flow_summary,
        volume_summary: ret.volume_summary, news_summary: ret.news_analysis,
        tip: '', sources: null,
      });
    } catch (e) { console.error('[analyze] saveAnalysisRun failed:', e.message); }
    return jsonResponse(ret);
  }

  const scoreResult = computeScore(price_data, volume_data, analysis_type);
  let finalData = null;
  let isFallback = false;
  let fallbackReason = null;
  let newsAgentStatus = 'unknown';

  const validRecs = analysis_type === 'sell'
    ? ['매도 추천', '부분 매도 고려', '보유 유지', '추가 매수 고려', '매수 추천', '판단 보류']
    : ['매수 추천', '매수 고려', '기다리기', '매도 고려', '매도 추천', '판단 보류'];

  try {
    if (!env.AI) throw new Error('AI_NOT_CONFIGURED');

    let previousRec = null;
    try {
      const { data: prevRuns } = await supabase
        .from('stock_analysis_runs')
        .select('recommendation, analyzed_at')
        .eq('user_id', userId).eq('ticker', ticker)
        .eq('market_facts->>analysis_type', analysis_type || 'buy') // ★ 매수/매도 분석 어휘가 섞이지 않게
        .neq('recommendation', '판단 보류')                          // ★ 실패/보류 결과가 다음 판단을 붙잡지 않게
        .order('analyzed_at', { ascending: false }).limit(1);
      if (prevRuns && prevRuns.length > 0 && validRecs.includes(prevRuns[0].recommendation)) {
        previousRec = prevRuns[0].recommendation;
      }
    } catch (dbErr) { console.warn('[analyze] prev runs query failed:', dbErr.message); }

    const analysisResult = await runAnalysisAgent(env, {
      ticker, stock_name, price_data, volume_data, analysis_type, holdings_data
    });

    const newsAnalysisResult = await runNewsAgent(env, { ticker, stock_name, news_items });
    newsAgentStatus = newsAnalysisResult.status || 'success';

    const judgeResult = await runJudgeAgent(env, {
      ticker, stock_name,
      analysis_result: analysisResult,
      news_analysis_result: newsAnalysisResult,
      analysis_type, holdings_data,
      previous_recommendation: previousRec,
    });

    let confidence = judgeResult.confidence;
    if (confidence == null || !Number.isFinite(confidence)) confidence = null;
    else confidence = Math.max(0, Math.min(1, confidence));

    let finalRecommendation = judgeResult.recommendation;
    let finalSummary = judgeResult.overall_summary || '-';

    // 히스테리시스
    const shouldKeep =
      previousRec && previousRec !== finalRecommendation &&
      (confidence == null || confidence < 0.8);
    if (shouldKeep) {
      finalRecommendation = previousRec;
      const confStr = confidence == null ? '미제공' : `${(confidence * 100).toFixed(0)}%`;
      finalSummary = `[판단 유지] ${finalSummary} (확신도 ${confStr})`;
    }

    // ★ 데이터 지연 / 시세 대체 → 강한 추천 하향
    if (dataQuality.status === 'STALE' && !isStale) {
      if (finalRecommendation === '매수 추천') { finalRecommendation = '매수 고려'; finalSummary = `[데이터 지연으로 강도 하향] ${finalSummary}`; }
      else if (finalRecommendation === '매도 추천') { finalRecommendation = '매도 고려'; finalSummary = `[데이터 지연으로 강도 하향] ${finalSummary}`; }
    }
    if (isStale) {
      if (finalRecommendation === '매수 추천') { finalRecommendation = '매수 고려'; finalSummary = `[이전 가격 사용으로 강도 하향] ${finalSummary}`; }
      else if (finalRecommendation === '매도 추천') { finalRecommendation = '매도 고려'; finalSummary = `[이전 가격 사용으로 강도 하향] ${finalSummary}`; }
      isFallback = true;
      fallbackReason = 'STALE_PRICE';
    }

    const newsAnalysisText = (newsAnalysisResult.news_analysis || '뉴스 데이터 없음.') +
      (newsAgentStatus === 'success' ? ' (정상)' : ' (비정상)');

    finalData = {
      recommendation: finalRecommendation,
      overall_summary: finalSummary,
      price_flow_summary: analysisResult.price_flow_analysis || '-',
      volume_summary: analysisResult.volume_analysis || '-',
      news_analysis: newsAnalysisText,
    };

    if (!finalData.recommendation) throw new Error('RECOMMENDATION_MISSING');
    const recClean = String(finalData.recommendation).replace(/\s+/g, '');
    const isValid = validRecs.some(r => r.replace(/\s+/g, '') === recClean || r.replace(/\s+/g, '').includes(recClean));
    if (!isValid) {
      // ★ 수정: 분석 유형에 맞는 어휘로만 보정
      if (analysis_type === 'sell') {
        if (recClean.includes('매도')) finalData.recommendation = '부분 매도 고려';
        else if (recClean.includes('매수')) finalData.recommendation = '추가 매수 고려';
        else if (recClean.includes('보유') || recClean.includes('기다리')) finalData.recommendation = '보유 유지';
        else throw new Error('RECOMMENDATION_INVALID');
      } else {
        if (recClean.includes('매수')) finalData.recommendation = '매수 고려';
        else if (recClean.includes('매도')) finalData.recommendation = '매도 고려';
        else if (recClean.includes('보유') || recClean.includes('기다리')) finalData.recommendation = '기다리기';
        else throw new Error('RECOMMENDATION_INVALID');
      }
    }
  } catch (e) {
    // ★ 상세 오류는 서버 로그에만
    console.error('[analyze] internal error:', e && e.message, e && e.stack);
    isFallback = true;
    fallbackReason = 'AI_ERROR';
    finalData = {
      recommendation: '판단 보류',
      overall_summary: 'AI 분석이 일시적으로 실패하여 판단을 보류합니다. 잠시 후 다시 시도해 주세요.',
      price_flow_summary: '분석 불가',
      volume_summary: '분석 불가',
      news_analysis: '분석 불가 (비정상)',
    };
    newsAgentStatus = 'error';
  }

  try {
    await saveAnalysisRun(supabase, {
      user_id: userId, ticker, stock_name,
      quote_price: price_data.current_price ?? null,
      quote_as_of: price_data.quote_as_of ?? null,
      data_status: dataQuality.status,
      score: scoreResult.totalScore,
      recommendation: finalData.recommendation,
      ruleset_version: RULESET_VERSION,
      market_facts: { price_data, volume_data, news_items, analysis_type, holdings_data },
      overall_summary: finalData.overall_summary,
      price_flow_summary: finalData.price_flow_summary,
      volume_summary: finalData.volume_summary,
      news_summary: finalData.news_analysis,
      tip: '',
      sources: news_items?.map((n) => ({ title: n.title, url: n.url })) ?? null,
    });
  } catch (saveErr) { console.error('[analyze] saveAnalysisRun failed:', saveErr.message); }

  return jsonResponse({
    score: scoreResult.totalScore,
    recommendation: finalData.recommendation,
    overall_summary: finalData.overall_summary,
    price_flow_summary: finalData.price_flow_summary,
    volume_summary: finalData.volume_summary,
    news_analysis: finalData.news_analysis,
    news_agent_status: newsAgentStatus,
    data_quality: dataQuality,
    ruleset_version: RULESET_VERSION,
    fallback: isFallback,
    fallback_reason: fallbackReason,
  });
}

// 데이터 품질: quote_time_verified 필드 명시
function computeDataQuality(price_data) {
  const marketStatus = price_data?.market_status || '';
  const serverTimeStr = price_data?.server_time || null;
  const quoteTimeStr = price_data?.quote_as_of || null;

  // ★ 수정: 시세 재조회 실패(이전 가격 사용) → UNKNOWN(판단 보류)로 빠지지 않고 STALE 경로로
  if (price_data?.price_source === 'STALE') {
    return { status: 'STALE', label: '시세 재조회 실패 (이전 가격 사용)', quote_time_verified: false };
  }

  if (quoteTimeStr) {
    const qt = new Date(quoteTimeStr);
    if (!isNaN(qt.getTime())) {
      const ageMin = (Date.now() - qt.getTime()) / 60000;
      if (ageMin > 60) return { status: 'STALE', label: '오래된 데이터', age_min: Math.round(ageMin), quote_time_verified: true };
      if (ageMin > 10) return { status: 'DELAYED', label: '지연된 데이터', age_min: Math.round(ageMin), quote_time_verified: true };
      return { status: 'OK', label: '정상', quote_time_verified: true };
    }
  }

  if (serverTimeStr) {
    const st = new Date(serverTimeStr);
    if (!isNaN(st.getTime())) {
      const ageMin = (Date.now() - st.getTime()) / 60000;
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

function validateAnalyzeInput(body) {
  const errors = [];
  if (!body || typeof body !== 'object') return { valid: false, errors: ['본문이 객체가 아닙니다.'] };
  const { ticker, stock_name, price_data, volume_data, news_items, analysis_type, holdings_data } = body;

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
    if (w52_hgpr != null && (!Number.isFinite(w52_hgpr) || w52_hgpr < 0)) errors.push('w52_hgpr은 0 이상 유한한 숫자여야 합니다.');
    if (w52_lwpr != null && (!Number.isFinite(w52_lwpr) || w52_lwpr < 0)) errors.push('w52_lwpr은 0 이상 유한한 숫자여야 합니다.');
    if (quote_as_of != null && isNaN(new Date(quote_as_of).getTime())) errors.push('quote_as_of는 유효한 시간이어야 합니다.');
    if (server_time != null && isNaN(new Date(server_time).getTime())) errors.push('server_time은 유효한 시간이어야 합니다.');
    if (price_source != null && !['FRESH', 'STALE'].includes(price_source)) errors.push("price_source는 'FRESH' 또는 'STALE'이어야 합니다.");
  }

  if (volume_data != null) {
    if (typeof volume_data !== 'object') errors.push('volume_data 형식이 올바르지 않습니다.');
    else {
      const { current_volume, avg_volume_20 } = volume_data;
      if (current_volume != null && (!Number.isFinite(current_volume) || current_volume < 0)) errors.push('current_volume은 0 이상 유한한 숫자여야 합니다.');
      if (avg_volume_20 != null && (!Number.isFinite(avg_volume_20) || avg_volume_20 < 0)) errors.push('avg_volume_20은 0 이상 유한한 숫자여야 합니다.');
    }
  }

  if (news_items != null) {
    if (!Array.isArray(news_items)) errors.push('news_items는 배열이어야 합니다.');
    else if (news_items.length > MAX_NEWS_ITEMS) errors.push(`news_items는 최대 ${MAX_NEWS_ITEMS}개까지만 허용됩니다.`);
    else news_items.forEach((n, i) => {
      if (!n || typeof n !== 'object') { errors.push(`news_items[${i}]가 객체가 아닙니다.`); return; }
      if (typeof n.title !== 'string' || n.title.length === 0 || n.title.length > 500) errors.push(`news_items[${i}].title은 1~500자 문자열이어야 합니다.`);
      if (n.url != null && (typeof n.url !== 'string' || n.url.length > MAX_URL_LENGTH || !/^https?:\/\//i.test(n.url))) errors.push(`news_items[${i}].url은 유효한 http(s) URL이어야 합니다.`);
    });
  }

  if (holdings_data != null) {
    if (typeof holdings_data !== 'object') errors.push('holdings_data 형식이 올바르지 않습니다.');
    else {
      const { quantity, avg_cost } = holdings_data;
      if (quantity != null && (!Number.isFinite(quantity) || quantity < 0)) errors.push('holdings_data.quantity는 0 이상 유한한 숫자여야 합니다.');
      if (avg_cost != null && (!Number.isFinite(avg_cost) || avg_cost < 0)) errors.push('holdings_data.avg_cost는 0 이상 유한한 숫자여야 합니다.');
    }
  }

  return { valid: errors.length === 0, errors };
}

async function runAnalysisAgent(env, payload) {
  const isSell = payload.analysis_type === 'sell';
  const role = isSell ? '주식 매도 분석가' : '주식 매수 분석가';
  let holdingsContext = '';
  if (isSell && payload.holdings_data) {
    const hd = payload.holdings_data;
    holdingsContext = `(평균단가:${hd.avg_cost}원, 수익률:${hd.return_rate.toFixed(2)}%, 보유:${hd.quantity}주)`;
  }
  const pd = payload.price_data, vd = payload.volume_data;
  const changeRateStr = pd.change_rate != null ? `${pd.change_rate > 0 ? '+' : ''}${pd.change_rate.toFixed(2)}%` : '없음';
  const return1MStr = pd.return_1m != null ? `${pd.return_1m > 0 ? '+' : ''}${pd.return_1m.toFixed(2)}%` : '없음';
  const ma20DispStr = pd.ma20_disparity != null ? `${pd.ma20_disparity > 0 ? '+' : ''}${pd.ma20_disparity.toFixed(2)}%` : '없음';
  let w52PosStr = '없음';
  if (pd.w52_hgpr != null && pd.w52_lwpr != null && pd.current_price != null && pd.w52_hgpr > pd.w52_lwpr) {
    w52PosStr = `${(((pd.current_price - pd.w52_lwpr) / (pd.w52_hgpr - pd.w52_lwpr)) * 100).toFixed(1)}%`;
  }
  let volumeStr = '데이터 없음';
  if (vd) {
    const cur = vd.current_volume, avg = vd.avg_volume_20;
    const intraday = String(pd.market_status || '').includes('정규장');
    if (cur != null && avg != null && avg > 0) {
      // ★ 수정: 장중 누적 거래량은 하루치 평균과 직접 비교하지 않음
      volumeStr = intraday
        ? `장중 누적 ${cur.toLocaleString()}주 (직전 20거래일 평균 ${avg.toLocaleString()}주, 장중이라 하루 거래량과 직접 비교 불가)`
        : `평균대비 ${(cur / avg).toFixed(2)}배`;
    }
    else if (cur != null) volumeStr = `오늘 ${cur.toLocaleString()}주 (평균 미확보)`;
    else if (avg != null) volumeStr = `20일 평균 ${avg.toLocaleString()}주 (오늘 미확보)`;
  }
  const systemPrompt = `당신은 ${role}입니다. 20영업일 데이터를 기반으로 분석하여 반드시 JSON으로 응답하세요. '~함', '~임' 체를 사용하세요. 장중 누적 거래량은 하루 평균과 직접 비교해 많다/적다고 단정하지 마세요.`;
  const userPrompt = `[데이터] ${payload.stock_name}(${payload.ticker}) 현재가:${pd.current_price}원 ${holdingsContext}
[지표] 1일등락:${changeRateStr} 1개월:${return1MStr} 20일선괴리:${ma20DispStr} 52주위치:${w52PosStr} 거래량:${volumeStr}

[응답 JSON 스키마]
{"price_flow_analysis": "가격 분석 (1~2문장)", "volume_analysis": "거래량 분석 (1~2문장)"}`;
  const response = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
    messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
    max_tokens: 1024, temperature: 0.1,
  });
  return extractJSON(response?.response || '{}');
}

async function runNewsAgent(env, payload) {
  if (!payload.news_items || payload.news_items.length === 0) {
    return { news_analysis: '최근 5일 이내 확인된 관련 뉴스가 없음.', status: 'success' };
  }
  try {
    const newsStr = payload.news_items.slice(0, MAX_NEWS_ITEMS)
      .map((n, i) => `[${i+1}] ${String(n.title || '').slice(0, 200)}`).join('\n');
    const systemPrompt = `당신은 주식 뉴스 분석가입니다. 다음 뉴스 목록에서 '${payload.stock_name}'의 주가에 실질적으로 영향을 줄 수 있는 뉴스만 선별하세요.
[규칙]
1. 목록에 있는 뉴스만 참고하세요.
2. 스포츠, 연예, 정치 뉴스는 제외하세요.
3. 실적, 공시, 계약 등 주가 직결 뉴스는 반드시 포함하세요.
4. 관련 뉴스가 있으면 1~2문장으로 요약하세요.
반드시 JSON으로 응답하세요.`;
    const userPrompt = `[종목] ${payload.stock_name} (${payload.ticker})\n[최근 5일 뉴스]\n${newsStr}\n\n[응답 JSON 스키마]\n{"news_analysis": "주가 영향 뉴스 요약 또는 '주가에 영향을 줄 만한 뉴스가 없음'"}`;
    const response = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      max_tokens: 512, temperature: 0.1,
    });
    const parsed = extractJSON(response?.response || '{}');
    if (!parsed.news_analysis) return { news_analysis: 'AI가 뉴스 분석 결과를 반환하지 않음.', status: 'error' };
    return { news_analysis: parsed.news_analysis, status: 'success' };
  } catch (e) {
    console.error('뉴스 에이전트 오류:', e.message);
    return { news_analysis: '뉴스 분석 실패.', status: 'error' };
  }
}

async function runJudgeAgent(env, payload) {
  const isSell = payload.analysis_type === 'sell';
  const prevRec = payload.previous_recommendation;
  let holdingsContext = '';
  if (payload.holdings_data) {
    const hd = payload.holdings_data;
    holdingsContext = `사용자는 현재 ${hd.quantity}주를 평균 ${hd.avg_cost}원에 보유 중이며 수익률은 ${hd.return_rate.toFixed(2)}%임.`;
  } else { holdingsContext = '사용자는 해당 종목을 보유하고 있지 않음.'; }
  const systemPrompt = `당신은 최종 판단을 내리는 심판입니다. 반드시 JSON으로 응답하세요. '~함', '~임' 체를 사용하세요.
[판단 일관성 규칙]
- 이전 판단과 동일한 등급을 유지하는 것은 언제나 환영합니다.
- 이전 판단을 번복하려면 명확한 근거와 함께 confidence를 0.8 이상으로 높게 책정해야 합니다.
- 확신이 부족하면 이전 판단을 유지하고 confidence를 0.7 이하로 책정하세요.`;
  const schema = isSell
    ? `{"recommendation": "매도 추천" | "부분 매도 고려" | "보유 유지" | "추가 매수 고려" | "판단 보류", "confidence": 0.0~1.0, "overall_summary": "판단 이유 (1~2문장)"}`
    : `{"recommendation": "매수 추천" | "매수 고려" | "기다리기" | "매도 고려" | "매도 추천", "confidence": 0.0~1.0, "overall_summary": "판단 이유 (1~2문장)"}`;
  const prevContext = prevRec ? `[직전 판단] ${prevRec}` : '[직전 판단] 없음 (첫 분석)';
  const userPrompt = `${prevContext}
[가격/거래량 분석] ${payload.analysis_result.price_flow_analysis || '-'} ${payload.analysis_result.volume_analysis || '-'}
[뉴스 분석] ${payload.news_analysis_result?.news_analysis || '없음'}
[사용자 상황] ${holdingsContext}

[응답 JSON 스키마]
${schema}`;
  const response = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
    messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
    max_tokens: 512, temperature: 0.1,
  });
  return extractJSON(response?.response || '{}');
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

function computeScore(price, volume, analysisType) {
  let score = 0;
  const rate = price.change_rate || 0;
  if (rate > 2) score += 1; else if (rate < -2) score -= 1;
  return { totalScore: score, recommendation: score > 0 ? '매수 고려' : '기다리기' };
}

async function saveAnalysisRun(supabase, payload) {
  const { error } = await supabase.from('stock_analysis_runs').insert(payload).select('id').single();
  if (error) throw error;
  return true;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}