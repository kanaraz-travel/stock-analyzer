// functions/api/analyze.js
import { createClient } from '@supabase/supabase-js';

const RULESET_VERSION = 'RULESET_AI_V15_STABLE';

export async function onRequestPost(context) {
  const { request, env } = context;
  const authHeader = request.headers.get('authorization') || '';
  const token = authHeader.replace('Bearer ', '');
  if (!token) return jsonResponse({ error: '인증이 필요합니다.' }, 401);

  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData?.user) return jsonResponse({ error: '인증이 필요합니다.' }, 401);
  const userId = userData.user.id;

  let body = {};
  try { body = await request.json(); } catch { return jsonResponse({ error: '잘못된 요청입니다.' }, 400); }

  const { ticker, stock_name, price_data, volume_data, news_items, analysis_type = 'buy', holdings_data } = body;
  if (!ticker || !stock_name) return jsonResponse({ error: 'ticker와 stock_name은 필수입니다.' }, 400);

  const dataSufficient = price_data && price_data.current_price != null;
  if (!dataSufficient) {
    return jsonResponse({
      recommendation: '판단 보류', overall_summary: '데이터가 부족하여 판단을 보류함.',
      price_flow_summary: '-', volume_summary: '-', news_analysis: '-', fallback: true,
    });
  }

  const scoreResult = computeScore(price_data, volume_data, news_items, analysis_type);
  let finalData = null;
  let isFallback = false;
  let debugInfo = null;

  try {
    if (!env.AI) throw new Error('Workers AI binding(env.AI)이 설정되지 않았습니다.');

    // ★ 1. DB에서 직전 분석 결과 가져오기 (이전 판단 컨텍스트 확보)
    const { data: prevRuns } = await supabase
      .from('stock_analysis_runs')
      .select('recommendation, analyzed_at')
      .eq('user_id', userId)
      .eq('ticker', ticker)
      .order('analyzed_at', { ascending: false })
      .limit(1);

    const previousRun = prevRuns && prevRuns.length > 0 ? prevRuns[0] : null;
    const previousRec = previousRun ? previousRun.recommendation : null;

    // 2. 가격/거래량 분석 에이전트 (Temperature 0.1 적용)
    const analysisResult = await runAnalysisAgent(env, {
      ticker, stock_name, price_data, volume_data, analysis_type, holdings_data
    });

    // 3. 뉴스 분석 에이전트 (Temperature 0.1 적용)
    const newsAnalysisResult = await runNewsAgent(env, {
      ticker, stock_name, news_items
    });

    // 4. 심판 에이전트 (이전 판단 컨텍스트 및 Temperature 0.1 적용)
    const judgeResult = await runJudgeAgent(env, {
      ticker, stock_name, 
      analysis_result: analysisResult, 
      news_analysis_result: newsAnalysisResult, 
      analysis_type, 
      holdings_data,
      previous_recommendation: previousRec // ★ 직전 판단 주입
    });

    // ★ 5. 확신도(Confidence) 기반 판단 유지 (히스테리시스)
    let finalRecommendation = judgeResult.recommendation;
    let finalSummary = judgeResult.overall_summary;
    const confidence = judgeResult.confidence || 1.0;

    // 이전 판단이 존재하고, 현재 판단과 다르며, 확신도가 0.8 미만이면 판단 번복 방지
    if (previousRec && previousRec !== finalRecommendation && confidence < 0.8) {
      finalRecommendation = previousRec;
      finalSummary = `[판단 유지] ${finalSummary} (확신도 ${(confidence * 100).toFixed(0)}%로 직전 판단 유지)`;
    }

    finalData = {
      recommendation: finalRecommendation,
      overall_summary: finalSummary,
      price_flow_summary: analysisResult.price_flow_analysis || '-',
      volume_summary: analysisResult.volume_analysis || '-',
      news_analysis: newsAnalysisResult.news_analysis || '-',
    };

    const validRecs = analysis_type === 'sell' 
      ? ['매도 추천', '부분 매도 고려', '보유 유지', '추가 매수 고려', '매수 추천', '판단 보류']
      : ['매수 추천', '매수 고려', '기다리기', '매도 고려', '매도 추천', '판단 보류'];

    if (!finalData.recommendation) throw new Error('추천 등급 누락');
    const recClean = finalData.recommendation.replace(/\s+/g, '');
    const isValid = validRecs.some(r => r.replace(/\s+/g, '') === recClean || r.replace(/\s+/g, '').includes(recClean));
    if (!isValid) {
      if (recClean.includes('매수')) finalData.recommendation = '매수 고려';
      else if (recClean.includes('매도')) finalData.recommendation = '매도 고려';
      else if (recClean.includes('보유') || recClean.includes('기다리')) finalData.recommendation = '기다리기';
      else throw new Error(`알 수 없는 추천 등급: ${finalData.recommendation}`);
    }
  } catch (e) {
    console.error('Multi-agent analysis failed:', e.message);
    isFallback = true; debugInfo = e.message;
    finalData = {
      recommendation: analysis_type === 'sell' ? '보유 유지' : scoreResult.recommendation,
      overall_summary: `AI 분석이 일시적으로 제한됨. (${e.message})`,
      price_flow_summary: '가격 데이터 계산됨.',
      volume_summary: volume_data ? '거래량 데이터 계산됨.' : '데이터 부족',
      news_analysis: '뉴스 분석 실패.',
    };
  }

  await saveAnalysisRun(supabase, {
    user_id: userId, ticker, stock_name, quote_price: price_data.current_price ?? null,
    quote_as_of: price_data.quote_as_of ?? null, data_status: 'LATEST', score: scoreResult.totalScore,
    recommendation: finalData.recommendation, ruleset_version: RULESET_VERSION,
    market_facts: { price_data, volume_data, news_items, analysis_type, holdings_data },
    overall_summary: finalData.overall_summary, price_flow_summary: finalData.price_flow_summary,
    volume_summary: finalData.volume_summary, news_summary: finalData.news_analysis,
    tip: '', sources: news_items?.map((n) => ({ title: n.title, url: n.url })) ?? null,
  });

  return jsonResponse({
    score: scoreResult.totalScore, recommendation: finalData.recommendation,
    overall_summary: finalData.overall_summary, price_flow_summary: finalData.price_flow_summary,
    volume_summary: finalData.volume_summary, news_analysis: finalData.news_analysis,
    ruleset_version: RULESET_VERSION, data_status: 'LATEST', fallback: isFallback, debug: debugInfo,
  });
}

async function runAnalysisAgent(env, payload) {
  const isSell = payload.analysis_type === 'sell';
  const role = isSell ? '주식 매도 분석가' : '주식 매수 분석가';
  
  let holdingsContext = '';
  if (isSell && payload.holdings_data) {
    const hd = payload.holdings_data;
    holdingsContext = `(평균단가:${hd.avg_cost}원, 수익률:${hd.return_rate.toFixed(2)}%, 보유:${hd.quantity}주`;
    if (hd.first_buy_date) holdingsContext += `, 최초매수:${hd.first_buy_date}`;
    if (hd.last_sell_date) holdingsContext += `, 최근매도:${hd.last_sell_date}`;
    holdingsContext += ')';
  }

  const pd = payload.price_data;
  const vd = payload.volume_data;
  const changeRateStr = pd.change_rate != null ? `${pd.change_rate > 0 ? '+' : ''}${pd.change_rate.toFixed(2)}%` : '없음';
  const return1MStr = pd.return_1m != null ? `${pd.return_1m > 0 ? '+' : ''}${pd.return_1m.toFixed(2)}%` : '없음';
  const ma20DispStr = pd.ma20_disparity != null ? `${pd.ma20_disparity > 0 ? '+' : ''}${pd.ma20_disparity.toFixed(2)}%` : '없음';
  
  let w52PosStr = '없음';
  if (pd.w52_hgpr != null && pd.w52_lwpr != null && pd.current_price != null) {
    const pos = ((pd.current_price - pd.w52_lwpr) / (pd.w52_hgpr - pd.w52_lwpr)) * 100;
    w52PosStr = `${pos.toFixed(1)}%`;
  }

  let volumeStr = '없음';
  if (vd && vd.current_volume != null && vd.avg_volume_20 != null) {
    volumeStr = `평균대비 ${(vd.current_volume / vd.avg_volume_20).toFixed(2)}배`;
  }

  const systemPrompt = `당신은 ${role}입니다. 20영업일 데이터를 기반으로 분석하여 반드시 JSON으로 응답하세요. '~함', '~임' 체를 사용하세요.`;
  const userPrompt = `
[데이터] ${payload.stock_name}(${payload.ticker}) 현재가:${pd.current_price}원 ${holdingsContext}
[지표] 1일등락:${changeRateStr} 1개월:${return1MStr} 20일선괴리:${ma20DispStr} 52주위치:${w52PosStr} 거래량:${volumeStr}

[응답 JSON 스키마]
{
  "price_flow_analysis": "가격 분석 (1~2문장)",
  "volume_analysis": "거래량 분석 (1~2문장)"
}`;
  
  const response = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
    messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }], 
    max_tokens: 1024,
    temperature: 0.1, // ★ Temperature 0.1 적용 (일관성 향상)
  });
  return extractJSON(response?.response || '{}');
}

async function runNewsAgent(env, payload) {
  if (!payload.news_items || payload.news_items.length === 0) {
    return { news_analysis: '최근 5일 이내 확인된 관련 뉴스가 없음.' };
  }

  const newsStr = payload.news_items.map((n, i) => `[${i+1}] ${n.title} (${n.published_at ? n.published_at.slice(0,10) : '날짜미상'})`).join('\n');

  const systemPrompt = `당신은 주식 뉴스 분석가입니다. 다음 뉴스 목록에서 '${payload.stock_name}'의 주가에 실질적으로 영향을 줄 수 있는 뉴스만 선별하세요.
[규칙]
1. 목록에 있는 뉴스만 참고하세요.
2. 스포츠, 연예, 정치 뉴스는 제외하세요.
3. 실적, 공시, 계약 등 주가 직결 뉴스는 반드시 포함하세요.
4. 관련 뉴스가 있으면 1~2문장으로 요약하세요.
반드시 JSON으로 응답하세요.`;

  const userPrompt = `
[종목] ${payload.stock_name} (${payload.ticker})
[최근 5일 뉴스]
${newsStr}

[응답 JSON 스키마]
{
  "news_analysis": "주가 영향 뉴스 1~2문장 요약 또는 '주가에 영향을 줄 만한 뉴스가 없음'"
}`;

  const response = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
    messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }], 
    max_tokens: 512,
    temperature: 0.1, // ★ Temperature 0.1 적용
  });
  return extractJSON(response?.response || '{}');
}

// ★ 심판 에이전트: 이전 판단 컨텍스트 및 히스테리시스 프롬프트 적용
async function runJudgeAgent(env, payload) {
  const isSell = payload.analysis_type === 'sell';
  const prevRec = payload.previous_recommendation;
  
  let holdingsContext = '';
  if (payload.holdings_data) {
    const hd = payload.holdings_data;
    holdingsContext = `사용자는 현재 ${hd.quantity}주를 평균 ${hd.avg_cost}원에 보유 중이며 수익률은 ${hd.return_rate.toFixed(2)}%임.`;
  } else {
    holdingsContext = '사용자는 해당 종목을 보유하고 있지 않음.';
  }

  const systemPrompt = `당신은 최종 판단을 내리는 심판입니다. 분석 결과와 사용자 보유 상황을 종합하여 반드시 JSON으로 응답하세요. '~함', '~임' 체를 사용하세요.
[판단 일관성 규칙]
- 이전 판단과 동일한 등급을 유지하는 것은 언제나 환영합니다.
- 이전 판단을 번복(변경)하려면, 현재 지표와 뉴스에서 명확한 근거가 있어야 하며, 이때 confidence를 0.8 이상으로 높게 책정해야 합니다.
- 확신이 부족하다면 이전 판단을 유지하고 confidence를 낮게(0.7 이하) 책정하세요.`;

  let schema = isSell
    ? `{"recommendation": "매도 추천" | "부분 매도 고려" | "보유 유지" | "추가 매수 고려" | "판단 보류", "confidence": 0.0~1.0, "overall_summary": "판단 이유 (1~2문장)"}`
    : `{"recommendation": "매수 추천" | "매수 고려" | "기다리기" | "매도 고려" | "매도 추천", "confidence": 0.0~1.0, "overall_summary": "판단 이유 (1~2문장)"}`;

  const prevContext = prevRec ? `[직전 판단] ${prevRec}` : '[직전 판단] 없음 (첫 분석)';

  const userPrompt = `
${prevContext}
[가격/거래량 분석] ${payload.analysis_result.price_flow_analysis} ${payload.analysis_result.volume_analysis}
[뉴스 분석] ${payload.news_analysis_result?.news_analysis || '없음'}
[사용자 상황] ${holdingsContext}

[응답 JSON 스키마]
${schema}`;

  const response = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
    messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }], 
    max_tokens: 512,
    temperature: 0.1, // ★ Temperature 0.1 적용
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

function computeScore(price, volume, news, type) {
  let score = 0;
  const rate = price.change_rate || 0;
  if (rate > 2) score += 1; else if (rate < -2) score -= 1;
  return { totalScore: score, recommendation: score > 0 ? '매수 고려' : '기다리기' };
}

async function saveAnalysisRun(supabase, payload) {
  const { error } = await supabase.from('stock_analysis_runs').insert(payload).select('id').single();
  if (error) console.error('saveAnalysisRun error:', error.message);
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}