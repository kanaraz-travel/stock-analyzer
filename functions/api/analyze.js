// functions/api/analyze.js
import { createClient } from '@supabase/supabase-js';

const RULESET_VERSION = 'RULESET_AI_V22_TREND_AWARE';
const MAX_BODY_BYTES = 100 * 1024;
const MAX_NEWS_ITEMS = 30;
const MAX_NEWS_FOR_AI = 20;
const MAX_URL_LENGTH = 2048;

// 판단 등급의 "강도" 매핑 (일관성 로직용, 매수/매도 관점 공통 -2 ~ +2)
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

  if (dataQuality.status === 'UNKNOWN' || dataQuality.status === 'INSUFFICIENT') {
    const ret = {
      score: null,
      recommendation: '판단 보류',
      overall_summary: '시세 기준 시각을 확인할 수 없거나 데이터가 부족하여 판단을 보류합니다.',
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
        overall_summary: ret.overall_summary,
        price_flow_summary: null, volume_summary: null, news_summary: ret.news_analysis,
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
  let analysisTrend = null;
  let newsSentiment = '중립';
  let newsTrend = null;

  const validRecs = analysis_type === 'sell'
    ? ['매도 추천', '부분 매도 고려', '보유 유지', '추가 매수 고려', '매수 추천', '판단 보류']
    : ['매수 추천', '매수 고려', '기다리기', '매도 고려', '매도 추천', '판단 보류'];

  try {
    if (!env.AI) throw new Error('AI_NOT_CONFIGURED');

    // ★ 일관성 로직용: 최근 5회 이력 조회 → 뒤집힘 카운트 + 시각 파악
    let previousRec = null;
    let previousAnalyzedAt = null;
    let recentFlipCount = 0;
    try {
      const { data: prevRuns } = await supabase
        .from('stock_analysis_runs')
        .select('recommendation, analyzed_at')
        .eq('user_id', userId).eq('ticker', ticker)
        .eq('market_facts->>analysis_type', analysis_type || 'buy')
        .neq('recommendation', '판단 보류')
        .order('analyzed_at', { ascending: false }).limit(5);

      if (prevRuns && prevRuns.length > 0) {
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

    const analysisResult = await runAnalysisAgent(env, {
      ticker, stock_name, price_data, volume_data, analysis_type, holdings_data
    });
    analysisTrend = normalizeAnalysisTrend(analysisResult.trend);

    const newsAnalysisResult = await runNewsAgent(env, { ticker, stock_name, news_items });
    newsAgentStatus = newsAnalysisResult.status || 'success';
    newsSentiment = normalizeNewsSentiment(newsAnalysisResult.news_sentiment);
    newsTrend = normalizeNewsTrend(newsAnalysisResult.news_trend);

    const judgeResult = await runJudgeAgent(env, {
      ticker, stock_name,
      analysis_result: analysisResult,
      news_analysis_result: newsAnalysisResult,
      analysis_type, holdings_data,
      previous_recommendation: previousRec,
      analysis_trend: analysisTrend,
      news_sentiment: newsSentiment,
      news_trend: newsTrend,
    });

    let confidence = judgeResult.confidence;
    if (confidence == null || !Number.isFinite(confidence)) confidence = null;
    else confidence = Math.max(0, Math.min(1, confidence));

    let finalRecommendation = judgeResult.recommendation;
    let finalSummary = judgeResult.overall_summary || '-';

    // ★ 강화된 일관성 보정
    const threshold = deriveConsistencyThreshold(previousAnalyzedAt, recentFlipCount);
    const jumpPenalty = needsHighConfidenceForLevelJump(previousRec, finalRecommendation) ? 0.9 : 0;
    const effectiveThreshold = Math.max(threshold, jumpPenalty);

    const shouldKeep =
      previousRec && previousRec !== finalRecommendation &&
      (confidence == null || confidence < effectiveThreshold);

    if (shouldKeep) {
      finalRecommendation = previousRec;
      const confStr = confidence == null ? '미제공' : `${(confidence * 100).toFixed(0)}%`;
      finalSummary = `[판단 유지] ${finalSummary} (확신도 ${confStr} < 임계 ${(effectiveThreshold * 100).toFixed(0)}%)`;
    }

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

    const newsAnalysisText = newsAnalysisResult.news_analysis || '뉴스 데이터 없음.';

    finalData = {
      recommendation: finalRecommendation,
      overall_summary: finalSummary,
      news_analysis: newsAnalysisText,
    };

    if (!finalData.recommendation) throw new Error('RECOMMENDATION_MISSING');
    const recClean = String(finalData.recommendation).replace(/\s+/g, '');
    const isValid = validRecs.some(r => r.replace(/\s+/g, '') === recClean || r.replace(/\s+/g, '').includes(recClean));
    if (!isValid) {
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
    console.error('[analyze] internal error:', e && e.message, e && e.stack);
    isFallback = true;
    fallbackReason = 'AI_ERROR';
    finalData = {
      recommendation: '판단 보류',
      overall_summary: 'AI 분석이 일시적으로 실패하여 판단을 보류합니다. 잠시 후 다시 시도해 주세요.',
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
      price_flow_summary: null,
      volume_summary: null,
      news_summary: finalData.news_analysis,
      tip: '',
      sources: news_items?.map((n) => ({ title: n.title, url: n.url })) ?? null,
    });
  } catch (saveErr) { console.error('[analyze] saveAnalysisRun failed:', saveErr.message); }

  return jsonResponse({
    score: scoreResult.totalScore,
    recommendation: finalData.recommendation,
    overall_summary: finalData.overall_summary,
    news_analysis: finalData.news_analysis,
    news_agent_status: newsAgentStatus,
    data_quality: dataQuality,
    ruleset_version: RULESET_VERSION,
    fallback: isFallback,
    fallback_reason: fallbackReason,
    // ★ 신규: 추세 정보 노출 (UI에서 활용 가능)
    analysis_trend: analysisTrend,
    news_trend: newsTrend,
    news_sentiment: newsSentiment,
  });
}

// ------------------------------------------------------------
// 데이터 품질 / 검증 (기존 유지)
// ------------------------------------------------------------
function computeDataQuality(price_data) {
  const marketStatus = price_data?.market_status || '';
  const serverTimeStr = price_data?.server_time || null;
  const quoteTimeStr = price_data?.quote_as_of || null;

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

// ------------------------------------------------------------
// 가격/거래량 분석 에이전트 (추세 필드 신규)
// ------------------------------------------------------------
async function runAnalysisAgent(env, payload) {
  const isSell = payload.analysis_type === 'sell';
  const role = isSell ? '주식 매도 분석가' : '주식 매수 분석가';
  let holdingsContext = '';
  if (isSell && payload.holdings_data) {
    const hd = payload.holdings_data;
    const rr = hd.return_rate != null ? `${hd.return_rate.toFixed(2)}%` : '미확인';
    holdingsContext = `(평균단가:${hd.avg_cost}원, 수익률:${rr}, 보유:${hd.quantity}주)`;
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

[추세 판단 지침]
- short_term: 1일 등락 + 20일선 괴리 조합 → '상승' | '횡보' | '하락' 중 하나.
- medium_term: 1개월 수익률 + 52주 위치 조합 → '상승' | '횡보' | '하락' 중 하나.
- momentum: 두 추세의 일치 여부 + 지표 강도 → '강' | '중' | '약' 중 하나.
- summary: 초보자가 이해할 수 있는 1문장 추세 요약.

[응답 JSON 스키마]
{
  "price_flow_analysis": "가격 분석 (1~2문장)",
  "volume_analysis": "거래량 분석 (1~2문장)",
  "trend": {
    "short_term": "상승|횡보|하락",
    "medium_term": "상승|횡보|하락",
    "momentum": "강|중|약",
    "summary": "추세 요약 1문장"
  }
}`;

  const response = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
    messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
    max_tokens: 1024, temperature: 0.1,
  });
  return extractJSON(response?.response || '{}');
}

// ------------------------------------------------------------
// 뉴스 분석 에이전트 (감성/추세 필드 신규)
// ------------------------------------------------------------
async function runNewsAgent(env, payload) {
  if (!payload.news_items || payload.news_items.length === 0) {
    return {
      news_analysis: '최근 확인된 관련 뉴스가 없음.',
      news_sentiment: '중립',
      news_trend: { direction: '중립', strength: '약', key_theme: '-' },
      status: 'success',
    };
  }

  const itemsForAI = payload.news_items.slice(0, MAX_NEWS_FOR_AI);
  const newsStr = itemsForAI
    .map((n, i) => {
      const dateStr = n.published_at ? n.published_at.slice(0, 10) : '날짜미상';
      return `[${i + 1}] (${dateStr}) ${String(n.title || '').slice(0, 200)}`;
    })
    .join('\n');

  try {
    const systemPrompt = `당신은 '${payload.stock_name}' 종목 뉴스 요약가입니다. 다음 뉴스 목록을 종합하여 이 종목의 주가에 영향을 줄 수 있는 요인을 1~3문장으로 정리하세요.

[핵심 원칙 - 반드시 준수]
1. 다음 뉴스 중 '${payload.stock_name}' 회사 관련, 또는 이 회사가 속한 **산업/시장/경쟁사/규제/정책** 관련 내용이 하나라도 있으면 반드시 그 내용을 1~3문장으로 요약하세요.
2. 다음 주제는 모두 포함 대상입니다:
   - 회사: 실적, 공시, 계약, 신제품, 투자, 구조조정, 배당, 자사주
   - 산업/시장: 동종업계 동향, 수요 변화, 금리/환율 영향, 원자재
   - 규제/정책: 정부 정책, 법안, 규제 변화
3. 다음만 제외: 스포츠 선수 개인사, 연예인 사생활, 정치인 개인사, 단순 홍보
4. "뉴스가 없다"고 응답할 수 있는 경우는 오직 다음뿐입니다:
   - 목록이 완전히 비었거나
   - 모든 기사가 명백히 위 제외 항목(스포츠/연예/정치 개인사)인 경우
5. 뉴스가 1건이라도 있으면, 그 뉴스에서 주가에 영향을 줄 수 있는 **가장 관련성 높은 관점**을 1~3문장으로 뽑아내세요. "관련성 약함"으로 뭉개지 마세요.
6. '~함', '~임' 체를 사용하세요.

[감성 판단 지침]
- news_sentiment: 뉴스 톤 종합 → '긍정' | '중립' | '부정' 중 하나.
- news_trend.direction: 주가 방향성 → '호재' | '악재' | '중립' 중 하나.
- news_trend.strength: 뉴스 영향력 → '강' | '중' | '약' 중 하나.
- news_trend.key_theme: 뉴스 핵심 키워드 10자 이내 (예: '실적 서프라이즈', '규제 리스크').

반드시 JSON 형식으로만 응답하세요.`;

    const userPrompt = `[종목] ${payload.stock_name} (${payload.ticker})
[수집된 뉴스 ${itemsForAI.length}건]
${newsStr}

[응답 JSON 스키마]
{
  "news_analysis": "위 뉴스에서 주가에 영향을 줄 수 있는 내용 1~3문장 요약. 정말 관련이 없을 때만 '주가에 영향을 줄 만한 뉴스가 없음'.",
  "news_sentiment": "긍정|중립|부정",
  "news_trend": {
    "direction": "호재|악재|중립",
    "strength": "강|중|약",
    "key_theme": "핵심 키워드 (10자 이내)"
  }
}`;

    const response = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      max_tokens: 600, temperature: 0.3,
    });

    const parsed = extractJSON(response?.response || '{}');
    let newsText = parsed.news_analysis || '';
    let newsSentiment = normalizeNewsSentiment(parsed.news_sentiment);
    let newsTrend = normalizeNewsTrend(parsed.news_trend);

    if (isNegativeNewsResponse(newsText)) {
      console.log(`[analyze] 뉴스 1차 응답이 "없음" → 재시도 (${itemsForAI.length}건 존재)`);
      try {
        const retryPrompt = `다음 뉴스 제목들을 보고 '${payload.stock_name}' 주가에 영향을 줄 수 있는 내용을 **1~2문장으로 반드시 요약**하세요. 관련성이 약해도 가장 그럴듯한 관점을 찾아내세요. 또한 뉴스 톤을 판단하세요. JSON으로만 응답: {"news_analysis": "...", "news_sentiment": "긍정|중립|부정"}\n\n${newsStr}`;
        const retryResponse = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
          messages: [{ role: 'user', content: retryPrompt }],
          max_tokens: 400, temperature: 0.4,
        });
        const retryParsed = extractJSON(retryResponse?.response || '{}');
        if (retryParsed.news_analysis && !isNegativeNewsResponse(retryParsed.news_analysis)) {
          newsText = retryParsed.news_analysis;
          if (retryParsed.news_sentiment) newsSentiment = normalizeNewsSentiment(retryParsed.news_sentiment);
        }
      } catch (e) { console.warn('[analyze] 뉴스 재시도 실패:', e.message); }
    }

    if (!newsText || isNegativeNewsResponse(newsText)) {
      newsText = `최근 수집된 ${itemsForAI.length}건의 관련 기사에서 뚜렷한 주가 영향 요인은 확인되지 않았음. 시장 상황 변화에 따라 재확인이 필요함.`;
    }

    return {
      news_analysis: newsText,
      news_sentiment: newsSentiment,
      news_trend: newsTrend,
      status: 'success',
    };
  } catch (e) {
    console.error('뉴스 에이전트 오류:', e.message);
    return {
      news_analysis: '뉴스 분석 중 일시적 오류가 발생했음. 잠시 후 다시 시도해 주세요.',
      news_sentiment: '중립',
      news_trend: null,
      status: 'error',
    };
  }
}

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

// ------------------------------------------------------------
// 심판 에이전트 (컨텍스트 + 추세 반영 강화)
// ------------------------------------------------------------
async function runJudgeAgent(env, payload) {
  const isSell = payload.analysis_type === 'sell';
  const prevRec = payload.previous_recommendation;

  // ★ 보유 컨텍스트 대폭 보강
  let holdingsContext = '';
  if (payload.holdings_data) {
    const hd = payload.holdings_data;
    const qty = hd.quantity ?? 0;
    const avgCost = hd.avg_cost ?? 0;
    const rr = hd.return_rate;
    const rrStr = rr != null && Number.isFinite(rr) ? `${rr.toFixed(2)}%` : '미확인';

    holdingsContext = `사용자는 현재 ${qty}주를 평균 ${avgCost.toLocaleString()}원에 보유 중이며 수익률은 ${rrStr}임.`;

    if (hd.total_cost != null && Number.isFinite(hd.total_cost)) {
      holdingsContext += ` 총 투자원금은 ${Math.round(hd.total_cost).toLocaleString()}원임.`;
    }

    if (hd.first_buy_date) {
      const firstBuy = new Date(hd.first_buy_date);
      if (!isNaN(firstBuy.getTime())) {
        const holdingDays = Math.floor((Date.now() - firstBuy.getTime()) / (1000 * 60 * 60 * 24));
        if (holdingDays >= 0 && holdingDays < 3650) {
          holdingsContext += ` 최초 매수일은 ${hd.first_buy_date} (약 ${holdingDays}일 보유 중)임.`;
        } else {
          holdingsContext += ` 최초 매수일은 ${hd.first_buy_date}임.`;
        }
      }
    }
    if (hd.last_buy_date) holdingsContext += ` 최근 추가 매수일은 ${hd.last_buy_date}임.`;
    if (hd.last_sell_date) holdingsContext += ` 최근 매도일은 ${hd.last_sell_date}임.`;

    // 수익률 구간별 힌트 (심판 판단 참고용)
    if (rr != null && Number.isFinite(rr)) {
      if (rr >= 20) holdingsContext += ` 수익률이 20%를 넘어 일부 이익실현을 고려할 만한 구간임.`;
      else if (rr >= 10) holdingsContext += ` 수익률이 두 자릿수로, 이익 보호 필요성이 있음.`;
      else if (rr <= -15) holdingsContext += ` 손실률이 -15%를 넘어 리스크 관리가 필요한 구간임.`;
      else if (rr <= -7) holdingsContext += ` 손실이 누적되는 구간으로 신중한 접근이 필요함.`;
    }
  } else {
    holdingsContext = '사용자는 해당 종목을 보유하고 있지 않음 (신규 진입 검토 관점).';
  }

  // ★ 추세 정보 컨텍스트
  const at = payload.analysis_trend || {};
  let trendContext = '';
  if (at.short_term || at.medium_term || at.momentum || at.summary) {
    trendContext = `\n[가격 추세]\n- 단기 추세: ${at.short_term || '정보 없음'}\n- 중기 추세: ${at.medium_term || '정보 없음'}\n- 추세 강도: ${at.momentum || '정보 없음'}\n- 추세 요약: ${at.summary || '-'}`;
  }

  const nt = payload.news_trend || {};
  const ns = payload.news_sentiment || '중립';
  let newsTrendContext = `\n[뉴스 심리]\n- 뉴스 톤: ${ns}\n- 방향성: ${nt.direction || '정보 없음'}\n- 영향력: ${nt.strength || '정보 없음'}\n- 핵심 테마: ${nt.key_theme || '정보 없음'}`;

  const systemPrompt = `당신은 최종 판단을 내리는 심판입니다. 반드시 JSON으로 응답하세요. '~함', '~임' 체를 사용하세요.

[overall_summary 작성 규칙 - 매우 중요]
overall_summary는 다음 5가지를 각각 1문장씩 포함한 총 5문장으로 작성하세요:
1. 가격 흐름 요약 (최근 1일/1개월/20일선/52주 위치 등을 종합, 추세 정보 활용)
2. 거래량 상태 요약 (평균 대비, 장중 여부 등)
3. 뉴스/공시 관련 내용 (또는 뉴스 부재, 뉴스 감성 활용)
4. 리스크 요인 (변동성, 데이터 신뢰도, 상충 신호, 사용자 보유 상황 관련 리스크)
5. 종합 판단 및 사용자 행동 제안 (보유 수량·평균단가·수익률·보유 기간 반영)

각 문장은 40자 이상 80자 이내로, 초보자가 이해할 수 있는 쉬운 한국어로 작성하세요.

[추세 활용 원칙]
- 가격 추세(단기/중기)와 뉴스 심리가 일치하면 판단 확신도를 높이세요.
- 두 추세가 상충하면(예: 가격 상승 + 뉴스 악재) 리스크 문장에서 명시하고, 확신도를 낮추세요.
- 추세가 약(弱)하면 강한 판단(매수 추천/매도 추천)을 지양하고 중립적 판단(매수 고려/기다리기/매도 고려)을 우선하세요.

[보유 상황 활용 원칙]
- 수익률이 이미 높은 구간(20% 이상)에서는 '매수 추천'보다는 '일부 이익실현' 관점을 고려하세요.
- 손실률이 큰 구간(-15% 이하)에서는 무리한 추가 매수보다 리스크 관리 관점을 우선하세요.
- 보유 기간이 짧으면(단기 매매 관점) 노이즈에 흔들리지 않도록 신중히 판단하세요.

[판단 일관성 규칙]
- 이전 판단과 동일한 등급을 유지하는 것은 언제나 환영합니다.
- 이전 판단을 번복하려면 명확한 근거와 함께 confidence를 0.8 이상으로 높게 책정해야 합니다.
- 확신이 부족하면 이전 판단을 유지하고 confidence를 0.7 이하로 책정하세요.`;

  const schema = isSell
    ? `{"recommendation": "매도 추천" | "부분 매도 고려" | "보유 유지" | "추가 매수 고려" | "판단 보류", "confidence": 0.0~1.0, "overall_summary": "5문장 종합 분석"}`
    : `{"recommendation": "매수 추천" | "매수 고려" | "기다리기" | "매도 고려" | "매도 추천", "confidence": 0.0~1.0, "overall_summary": "5문장 종합 분석"}`;

  const prevContext = prevRec ? `[직전 판단] ${prevRec}` : '[직전 판단] 없음 (첫 분석)';

  const userPrompt = `${prevContext}

[가격 분석가 의견]
${payload.analysis_result.price_flow_analysis || '-'}

[거래량 분석가 의견]
${payload.analysis_result.volume_analysis || '-'}
${trendContext}

[뉴스 분석가 의견]
${payload.news_analysis_result?.news_analysis || '없음'}
${newsTrendContext}

[사용자 상황]
${holdingsContext}

[요청]
위 자료를 종합해 5문장 종합 분석(overall_summary)과 최종 판단(recommendation), 확신도(confidence)를 생성하세요.

[응답 JSON 스키마]
${schema}`;

  const response = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
    messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
    max_tokens: 1024, temperature: 0.1,
  });
  return extractJSON(response?.response || '{}');
}

// ------------------------------------------------------------
// 유틸 / 정규화 / 일관성 헬퍼
// ------------------------------------------------------------
function normalizeAnalysisTrend(trend) {
  if (!trend || typeof trend !== 'object') return null;
  const result = {};
  if (['상승', '횡보', '하락'].includes(trend.short_term)) result.short_term = trend.short_term;
  if (['상승', '횡보', '하락'].includes(trend.medium_term)) result.medium_term = trend.medium_term;
  if (['강', '중', '약'].includes(trend.momentum)) result.momentum = trend.momentum;
  if (typeof trend.summary === 'string' && trend.summary.length > 0) {
    result.summary = trend.summary.slice(0, 200);
  }
  return Object.keys(result).length > 0 ? result : null;
}

function normalizeNewsSentiment(sentiment) {
  if (typeof sentiment !== 'string') return '중립';
  const s = sentiment.trim();
  if (['긍정', '중립', '부정'].includes(s)) return s;
  return '중립';
}

function normalizeNewsTrend(trend) {
  if (!trend || typeof trend !== 'object') return null;
  const result = {};
  if (['호재', '악재', '중립'].includes(trend.direction)) result.direction = trend.direction;
  if (['강', '중', '약'].includes(trend.strength)) result.strength = trend.strength;
  if (typeof trend.key_theme === 'string' && trend.key_theme.length > 0) {
    result.key_theme = trend.key_theme.slice(0, 30);
  }
  return Object.keys(result).length > 0 ? result : null;
}

// 최근 분석 시각 + 뒤집힘 횟수 기반 동적 임계값
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

// 등급 2단계 이상 점프 여부 (매수↔매도 등)
function needsHighConfidenceForLevelJump(prevRec, newRec) {
  if (!prevRec || !newRec) return false;
  const pl = REC_LEVEL[prevRec];
  const nl = REC_LEVEL[newRec];
  if (pl == null || nl == null) return false;
  return Math.abs(nl - pl) >= 2;
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