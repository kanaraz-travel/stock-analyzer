// functions/api/analyze.js
import { createClient } from '@supabase/supabase-js';

const RULESET_VERSION = 'RULESET_AI_V9_SHORT';

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
      recommendation: '판단 보류', overall_summary: '데이터가 부족합니다.',
      price_flow_summary: '-', volume_summary: '-', news_summary: '-', tip: '-', fallback: true,
    });
  }

  const scoreResult = computeScore(price_data, volume_data, news_items, analysis_type);
  let finalData = null;
  let isFallback = false;
  let debugInfo = null;

  try {
    if (!env.AI) throw new Error('Workers AI binding(env.AI)이 설정되지 않았습니다.');

    const analysisResult = await runAnalysisAgent(env, {
      ticker, stock_name, price_data, volume_data, news_items, rule_based_score: scoreResult, analysis_type, holdings_data
    });

    finalData = await runJudgeAgent(env, {
      ticker, stock_name, analysis_result: analysisResult, rule_based_score: scoreResult, price_data, volume_data, news_items, analysis_type, holdings_data
    });

    const validRecs = analysis_type === 'sell' 
      ? ['매도 추천', '부분 매도 고려', '보유 유지', '추가 매수 고려', '매수 추천', '판단 보류']
      : ['매수 추천', '매수 고려', '기다리기', '매도 고려', '매도 추천', '판단 보류'];

    if (!finalData || !validRecs.includes(finalData.recommendation)) {
      throw new Error('심판 에이전트의 응답 형식이 유효하지 않습니다.');
    }
  } catch (e) {
    console.error('Multi-agent analysis failed:', e.message);
    isFallback = true; debugInfo = e.message;
    
    finalData = {
      recommendation: analysis_type === 'sell' ? '보유 유지' : scoreResult.recommendation,
      overall_summary: `AI 분석이 일시적으로 제한되었습니다. (${e.message})`,
      price_flow_summary: '가격 데이터를 바탕으로 계산되었습니다.',
      volume_summary: volume_data ? '거래량 데이터를 바탕으로 계산되었습니다.' : '데이터 부족',
      news_summary: news_items?.length ? '관련 뉴스가 있습니다.' : '데이터 부족',
      tip: '참고용입니다.',
    };
  }

  await saveAnalysisRun(supabase, {
    user_id: userId, ticker, stock_name, quote_price: price_data.current_price ?? null,
    quote_as_of: price_data.quote_as_of ?? null, data_status: 'LATEST', score: scoreResult.totalScore,
    recommendation: finalData.recommendation, ruleset_version: RULESET_VERSION,
    market_facts: { price_data, volume_data, news_items, analysis_type, holdings_data },
    overall_summary: finalData.overall_summary, price_flow_summary: finalData.price_flow_summary,
    volume_summary: finalData.volume_summary, news_summary: finalData.news_summary,
    tip: finalData.tip, sources: news_items?.map((n) => ({ title: n.title, url: n.url })) ?? null,
  });

  return jsonResponse({
    score: scoreResult.totalScore, recommendation: finalData.recommendation,
    overall_summary: finalData.overall_summary, price_flow_summary: finalData.price_flow_summary,
    volume_summary: finalData.volume_summary, news_summary: finalData.news_summary,
    tip: finalData.tip, ruleset_version: RULESET_VERSION, data_status: 'LATEST', fallback: isFallback, debug: debugInfo,
  });
}

async function runAnalysisAgent(env, payload) {
  const isSell = payload.analysis_type === 'sell';
  const role = isSell ? '주식 매도 분석가' : '주식 매수 분석가';
  
  let holdingsContext = '';
  if (isSell && payload.holdings_data) {
    holdingsContext = `(내 평균단가:${payload.holdings_data.avg_cost}원, 수익률:${payload.holdings_data.return_rate.toFixed(2)}%)`;
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
    volumeStr = `평균 대비 ${(vd.current_volume / vd.avg_volume_20).toFixed(2)}배`;
  }

  const newsStr = payload.news_items?.length > 0 ? '있음' : '없음';

  const systemPrompt = `당신은 ${role}입니다. 반드시 JSON 형식으로만 짧게 응답하세요.`;
  const userPrompt = `
[데이터] ${payload.stock_name}(${payload.ticker}) 현재가:${pd.current_price}원 ${holdingsContext}
[지표] 1일등락:${changeRateStr} 1개월:${return1MStr} 20일선괴리:${ma20DispStr} 52주위치:${w52PosStr} 거래량:${volumeStr} 뉴스:${newsStr}

[응답 JSON 스키마 - 모든 문장은 아주 간결하게 1문장으로 작성]
{
  "agent_opinion": "종합 의견 (1문장)",
  "price_flow_analysis": "가격 분석 (1문장)",
  "volume_analysis": "거래량 분석 (1문장)",
  "news_impact_analysis": "뉴스 영향 (1문장)",
  "risk_factors": "리스크 (1문장)"
}`;
  
  const response = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
    messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }], max_tokens: 512, // ★ 토큰 절반으로 축소
  });
  
  return extractJSON(response?.response || '');
}

async function runJudgeAgent(env, payload) {
  const isSell = payload.analysis_type === 'sell';
  
  let systemPrompt = `당신은 최종 판단을 내리는 심판입니다. 반드시 JSON 형식으로 아주 짧게 응답하세요.`;
  let schema = '';

  if (isSell) {
    schema = `{
  "recommendation": "매도 추천" | "부분 매도 고려" | "보유 유지" | "추가 매수 고려" | "판단 보류",
  "overall_summary": "판단 이유 (1문장)",
  "price_flow_summary": "가격 흐름 (1문장)",
  "volume_summary": "거래량 (1문장)",
  "news_summary": "뉴스 (1문장)"
}`;
  } else {
    schema = `{
  "recommendation": "매수 추천" | "매수 고려" | "기다리기" | "매도 고려" | "매도 추천",
  "overall_summary": "판단 이유 (1문장)",
  "price_flow_summary": "가격 흐름 (1문장)",
  "volume_summary": "거래량 (1문장)",
  "news_summary": "뉴스 (1문장)"
}`;
  }

  const userPrompt = `
[1차 의견] ${payload.analysis_result.agent_opinion}
[응답 JSON 스키마]
${schema}`;

  const response = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
    messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }], max_tokens: 512,
  });
  return extractJSON(response?.response || '');
}

function extractJSON(data) {
  if (data == null) throw new Error('AI 응답이 비어있습니다.');
  if (typeof data === 'object') return data;
  const text = String(data);
  const jsonStart = text.indexOf('{');
  const jsonEnd = text.lastIndexOf('}');
  if (jsonStart === -1 || jsonEnd === -1) throw new Error('JSON 없음');
  try { return JSON.parse(text.substring(jsonStart, jsonEnd + 1)); } catch (e) { throw new Error('JSON 파싱 실패'); }
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