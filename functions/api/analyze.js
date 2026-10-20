// functions/api/analyze.js
// POST /api/analyze
// Body: { ticker, stock_name, price_data: {...}, volume_data: {...}, news_items: [...] }

import { createClient } from '@supabase/supabase-js';

const RULESET_VERSION = 'RULESET_AI_V3_MULTI_AGENT';

export async function onRequestPost(context) {
  const { request, env } = context;

  const authHeader = request.headers.get('authorization') || '';
  const token = authHeader.replace('Bearer ', '');
  if (!token) {
    return jsonResponse({ error: '인증이 필요합니다.' }, 401);
  }

  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData?.user) {
    return jsonResponse({ error: '인증이 필요합니다.' }, 401);
  }
  const userId = userData.user.id;

  let body = {};
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: '잘못된 요청입니다.' }, 400);
  }

  const { ticker, stock_name, price_data, volume_data, news_items } = body;

  if (!ticker || !stock_name) {
    return jsonResponse({ error: 'ticker와 stock_name은 필수입니다.' }, 400);
  }

  const dataSufficient = price_data && price_data.current_price != null;

  if (!dataSufficient) {
    const fallbackSummary = {
      recommendation: '판단 보류',
      overall_summary: '현재가 데이터가 부족해 분석을 진행할 수 없습니다.',
      price_flow_summary: '-',
      volume_summary: '-',
      news_summary: '-',
      tip: '데이터가 충분히 수집된 후 다시 시도해 주세요.',
      fallback: true,
    };
    await saveAnalysisRun(supabase, {
      ...fallbackSummary,
      user_id: userId,
      ticker,
      stock_name,
      ruleset_version: RULESET_VERSION,
      data_status: 'INSUFFICIENT_DATA',
    });
    return jsonResponse(fallbackSummary);
  }

  const scoreResult = computeScore(price_data, volume_data, news_items);

  let finalData = null;
  let isFallback = false;

  try {
    const analysisResult = await runAnalysisAgent(env, {
      ticker,
      stock_name,
      price_data,
      volume_data,
      news_items,
      rule_based_score: scoreResult,
    });

    finalData = await runJudgeAgent(env, {
      ticker,
      stock_name,
      analysis_result: analysisResult,
      rule_based_score: scoreResult,
      price_data,
      news_items,
    });

    const validRecommendations = ['매수 추천', '매수 고려', '기다리기', '매도 고려', '매도 추천', '판단 보류'];
    if (!finalData || !validRecommendations.includes(finalData.recommendation)) {
      throw new Error('심판 에이전트의 응답이 유효하지 않습니다.');
    }
  } catch (e) {
    console.warn('Multi-agent analysis failed, falling back to rule-based logic:', e.message);
    isFallback = true;

    finalData = {
      recommendation: scoreResult.recommendation,
      overall_summary: `현재 규칙 기반 분석 결과 "${scoreResult.recommendation}"입니다. AI 분석이 일시적으로 제한되어 기본 지표로 판단했습니다.`,
      price_flow_summary: '최근 가격 흐름 데이터를 바탕으로 계산된 결과입니다.',
      volume_summary: '거래량 데이터를 바탕으로 계산된 결과입니다.',
      news_summary: news_items?.length ? '최근 확인된 뉴스가 있습니다.' : '확인된 주요 뉴스가 없습니다.',
      tip: '이 분석은 참고용이며, 투자 결정의 책임은 본인에게 있습니다.',
    };
  }

  const saved = await saveAnalysisRun(supabase, {
    user_id: userId,
    ticker,
    stock_name,
    quote_price: price_data.current_price ?? null,
    quote_as_of: price_data.quote_as_of ?? null,
    data_status: 'LATEST',
    score: scoreResult.totalScore,
    recommendation: finalData.recommendation,
    ruleset_version: RULESET_VERSION,
    market_facts: { price_data, volume_data, news_items },
    overall_summary: finalData.overall_summary,
    price_flow_summary: finalData.price_flow_summary,
    volume_summary: finalData.volume_summary,
    news_summary: finalData.news_summary,
    tip: finalData.tip,
    sources: news_items?.map((n) => ({ title: n.title, url: n.url })) ?? null,
  });

  return jsonResponse({
    id: saved?.id,
    score: scoreResult.totalScore,
    recommendation: finalData.recommendation,
    overall_summary: finalData.overall_summary,
    price_flow_summary: finalData.price_flow_summary,
    volume_summary: finalData.volume_summary,
    news_summary: finalData.news_summary,
    tip: finalData.tip,
    ruleset_version: RULESET_VERSION,
    data_status: 'LATEST',
    fallback: isFallback,
  });
}

async function runAnalysisAgent(env, payload) {
  if (!env.AI) throw new Error('Workers AI binding not configured');

  const systemPrompt = `당신은 주식 초보자를 돕는 친절하고 신중한 주식 분석가입니다.
제공된 [데이터]를 바탕으로 현재 주식의 상태를 분석하세요.
반드시 제공된 JSON 스키마 형식으로만 응답해야 하며, 데이터에 없는 내용을 지어내면 안 됩니다.
초보자가 이해할 수 있도록 쉬운 한국어로 1~2문장씩 작성하세요.`;

  const userPrompt = `
[데이터]
- 종목명: ${payload.stock_name} (${payload.ticker})
- 현재가: ${payload.price_data.current_price}원
- 등락률: ${payload.price_data.return_1d ? (payload.price_data.return_1d * 100).toFixed(2) + '%' : '알 수 없음'}
- 거래량 비율(최근 5일 대비): ${payload.volume_data?.ratio_5d || '알 수 없음'}
- 기존 알고리즘 점수: ${payload.rule_based_score.totalScore}점 (${payload.rule_based_score.recommendation})
- 최근 뉴스: ${payload.news_items?.map((n) => n.title).join(', ') || '없음'}

[응답 JSON 스키마]
{
  "agent_opinion": "분석 에이전트의 종합 의견 (2문장)",
  "price_flow_analysis": "가격 흐름 분석 (1~2문장)",
  "volume_analysis": "거래량 분석 (1~2문장)",
  "news_impact_analysis": "뉴스/공시 영향 분석 (1~2문장)",
  "risk_factors": "주요 리스크 요인 (1문장)"
}`;

  const response = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    max_tokens: 600,
  });

  const text = response?.response || '';
  const cleaned = text.replace(/```json|```/g, '').trim();

  try {
    return JSON.parse(cleaned);
  } catch (e) {
    console.error('Analysis Agent JSON parse failed:', text);
    throw new Error('분석 에이전트 응답 파싱 실패');
  }
}

async function runJudgeAgent(env, payload) {
  if (!env.AI) throw new Error('Workers AI binding not configured');

  const systemPrompt = `당신은 최종 투자 판단을 내리는 심판 에이전트입니다.
분석 에이전트의 의견과 규칙 기반 점수를 종합하여, 아래 5단계 중 하나를 최종 결정하세요.
- 매수 추천: 매우 강력한 매수 신호
- 매수 고려: 긍정적이나 신중한 접근 필요
- 기다리기: 관망이 필요하거나 혼조세
- 매도 고려: 부정적 신호가 나타남
- 매도 추천: 강력한 매도/회피 신호

반드시 제공된 JSON 스키마 형식으로만 응답해야 하며, 데이터에 없는 내용을 지어내면 안 됩니다.
초보자가 이해할 수 있도록 쉬운 한국어로 1~2문장씩 작성하세요.`;

  const userPrompt = `
[분석 에이전트의 1차 의견]
- 종합 의견: ${payload.analysis_result.agent_opinion}
- 가격 흐름 분석: ${payload.analysis_result.price_flow_analysis}
- 거래량 분석: ${payload.analysis_result.volume_analysis}
- 뉴스 영향 분석: ${payload.analysis_result.news_impact_analysis}
- 리스크 요인: ${payload.analysis_result.risk_factors}

[규칙 기반 점수]
- 총점: ${payload.rule_based_score.totalScore}점
- 규칙 기반 판단: ${payload.rule_based_score.recommendation}

[현재 시세]
- 현재가: ${payload.price_data.current_price}원

[응답 JSON 스키마]
{
  "recommendation": "매수 추천" | "매수 고려" | "기다리기" | "매도 고려" | "매도 추천",
  "overall_summary": "최종 판단 이유 요약 (초보자용, 2문장)",
  "price_flow_summary": "가격 흐름에 대한 최종 분석 (1~2문장)",
  "volume_summary": "거래량에 대한 최종 분석 (1~2문장)",
  "news_summary": "뉴스/공시가 주가에 미칠 영향에 대한 최종 분석 (1~2문장)",
  "tip": "이 상황에서 초보자가 명심해야 할 투자 TIP (1~2문장)"
}`;

  const response = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    max_tokens: 800,
  });

  const text = response?.response || '';
  const cleaned = text.replace(/```json|```/g, '').trim();

  try {
    return JSON.parse(cleaned);
  } catch (e) {
    console.error('Judge Agent JSON parse failed:', text);
    throw new Error('심판 에이전트 응답 파싱 실패');
  }
}

function computeScore(price, volume, news) {
  let priceScore = 0;
  if (price.return_5d > 0.02) priceScore += 2;
  else if (price.return_5d > 0) priceScore += 1;
  else if (price.return_5d < -0.02) priceScore -= 2;
  else if (price.return_5d < 0) priceScore -= 1;

  if (price.return_20d > 0.05) priceScore += 1;
  else if (price.return_20d < -0.05) priceScore -= 1;
  priceScore = clamp(priceScore, -2, 2);

  let volumeScore = 0;
  if (volume && typeof volume.ratio_5d === 'number') {
    if (volume.ratio_5d > 1.2) volumeScore = 1;
    else if (volume.ratio_5d < 0.8) volumeScore = -1;
  }

  let newsScore = 0;
  if (Array.isArray(news)) {
    const important = news.filter(
      (n) => n.impact_label === '긍정적 영향 가능성' || n.impact_label === '부정적 영향 가능성'
    );
    if (important.length > 0) {
      const pos = important.filter((n) => n.impact_label === '긍정적 영향 가능성').length;
      const neg = important.filter((n) => n.impact_label === '부정적 영향 가능성').length;
      if (pos > neg) newsScore = Math.min(2, pos);
      else if (neg > pos) newsScore = -Math.min(2, neg);
    }
  }

  let riskPenalty = 0;
  if (price.volatility_20d > 0.08) riskPenalty -= 1;
  if (price.quote_is_stale) riskPenalty -= 1;
  riskPenalty = clamp(riskPenalty, -2, 0);

  const totalScore = priceScore + volumeScore + newsScore + riskPenalty;
  let recommendation = '기다리기';
  if (totalScore >= 4) recommendation = '매수 추천';
  else if (totalScore >= 2) recommendation = '매수 고려';
  else if (totalScore >= -1) recommendation = '기다리기';
  else if (totalScore >= -3) recommendation = '매도 고려';
  else recommendation = '매도 추천';

  return { totalScore, recommendation, priceScore, volumeScore, newsScore, riskPenalty };
}

async function saveAnalysisRun(supabase, payload) {
  const { data, error } = await supabase
    .from('stock_analysis_runs')
    .insert(payload)
    .select('id')
    .single();

  if (error) {
    console.error('saveAnalysisRun error:', error.message);
    return null;
  }
  return data;
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}