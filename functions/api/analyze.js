// functions/api/analyze.js
// POST /api/analyze
// Body: { ticker, stock_name, price_data: {...}, volume_data: {...}, news_items: [...] }

import { createClient } from '@supabase/supabase-js';

const RULESET_VERSION = 'RULESET_AI_V2';

export async function onRequestPost(context) {
  const { request, env } = context;

  // 1) 인증 확인 (Supabase JWT)
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

  // 2) AI 판단을 위한 기본 데이터 정리 (데이터 부족 시 판단 보류)
  const dataSufficient = price_data && price_data.current_price != null;
  
  if (!dataSufficient) {
    const fallbackSummary = {
      recommendation: '판단 보류',
      overall_summary: '현재가 데이터가 부족해 분석을 진행할 수 없습니다.',
      price_flow_summary: '-',
      volume_summary: '-',
      news_summary: '-',
      tip: '데이터가 충분히 수집된 후 다시 시도해 주세요.',
      fallback: true
    };
    await saveAnalysisRun(supabase, { ...fallbackSummary, user_id: userId, ticker, stock_name, ruleset_version: RULESET_VERSION, data_status: 'INSUFFICIENT_DATA' });
    return jsonResponse(fallbackSummary);
  }

  // 3) 기존 규칙 기반 점수 계산 (AI가 참고할 수치 및 비상시 Fallback용)
  const scoreResult = computeScore(price_data, volume_data, news_items);

  // 4) AI 판단 시도 (Cloudflare Workers AI)
  let aiResult = null;
  try {
    aiResult = await callWorkersAIAnalyze(env, {
      ticker,
      stock_name,
      price_data,
      volume_data,
      news_items,
      rule_based_score: scoreResult // AI가 참고할 수 있도록 기존 점수 전달
    });
  } catch (e) {
    console.warn('AI Analysis failed, falling back to rule-based logic:', e.message);
  }

  // 5) 최종 결과 확정 (AI 성공 시 AI 결과, 실패 시 규칙 기반 결과)
  let finalData = {};
  let isFallback = false;

  if (aiResult && aiResult.recommendation && aiResult.overall_summary) {
    // AI가 5단계 중 유효한 값을 반환했는지 검증
    const validRecommendations = ['매수 추천', '매수 고려', '기다리기', '매도 고려', '매도 추천', '판단 보류'];
    if (validRecommendations.includes(aiResult.recommendation)) {
      finalData = aiResult;
    } else {
      aiResult.recommendation = scoreResult.recommendation;
      finalData = aiResult;
    }
  } else {
    // AI 실패 시 Fallback
    isFallback = true;
    finalData = {
      recommendation: scoreResult.recommendation,
      overall_summary: `현재 규칙 기반 분석 결과 "${scoreResult.recommendation}"입니다. AI 분석이 일시적으로 제한되어 기본 지표로 판단했습니다.`,
      price_flow_summary: `최근 5일/20일 가격 흐름을 바탕으로 계산된 결과입니다.`,
      volume_summary: `거래량 비율을 바탕으로 계산된 결과입니다.`,
      news_summary: news_items?.length ? '최근 확인된 뉴스가 있습니다.' : '확인된 주요 뉴스가 없습니다.',
      tip: '이 분석은 참고용이며, 투자 결정의 책임은 본인에게 있습니다.',
    };
  }

  // 6) 분석 결과 DB 저장
  const saved = await saveAnalysisRun(supabase, {
    user_id: userId,
    ticker,
    stock_name,
    quote_price: price_data.current_price ?? null,
    quote_as_of: price_data.quote_as_of ?? null,
    data_status: 'LATEST',
    score: scoreResult.totalScore, // AI가 판단했더라도 참고용 점수는 저장
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

// ------------------------------------------------------------
// Cloudflare Workers AI 호출 및 프롬프트 (핵심 AI 판단 로직)
// ------------------------------------------------------------
async function callWorkersAIAnalyze(env, payload) {
  if (!env.AI) throw new Error('Workers AI binding not configured');

  // AI에게 전달할 프롬프트 구성
  const systemPrompt = `당신은 주식 초보자를 돕는 친절하고 신중한 주식 분석가입니다.
제공된 [데이터]를 바탕으로 현재 주식의 상태를 분석하고, 아래 5단계 중 하나를 결정하세요.
- 매수 추천: 매우 강력한 매수 신호
- 매수 고려: 긍정적이나 신중한 접근 필요
- 기다리기: 관망이 필요하거나 혼조세
- 매도 고려: 부정적 신호가 나타남
- 매도 추천: 강력한 매도/회피 신호

반드시 제공된 JSON 스키마 형식으로만 응답해야 하며, 데이터에 없는 내용을 지어내면 안 됩니다. 초보자가 이해할 수 있도록 쉬운 한국어로 1~2문장씩 작성하세요.`;

  const userPrompt = `
[데이터]
- 종목명: ${payload.stock_name} (${payload.ticker})
- 현재가: ${payload.price_data.current_price}원
- 등락률: ${payload.price_data.return_1d ? (payload.price_data.return_1d * 100).toFixed(2) + '%' : '알 수 없음'}
- 거래량 비율(최근 5일 대비): ${payload.volume_data?.ratio_5d || '알 수 없음'}
- 기존 알고리즘 점수: ${payload.rule_based_score.totalScore}점 (${payload.rule_based_score.recommendation})
- 최근 뉴스: ${payload.news_items?.map(n => n.title).join(', ') || '없음'}

[응답 JSON 스키마]
{
  "recommendation": "매수 추천" | "매수 고려" | "기다리기" | "매도 고려" | "매도 추천",
  "overall_summary": "전체적인 판단 이유 요약 (초보자용, 2문장)",
  "price_flow_summary": "가격 흐름에 대한 분석 (1~2문장)",
  "volume_summary": "거래량에 대한 분석 (1~2문장)",
  "news_summary": "뉴스/공시가 주가에 미칠 영향 분석 (1~2문장)",
  "tip": "이 상황에서 초보자가 명심해야 할 투자 TIP (1~2문장)"
}`;

  const response = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    max_tokens: 1024,
  });

  const text = response?.response || '';
  const cleaned = text.replace(/```json|```/g, '').trim();
  
  try {
    const parsed = JSON.parse(cleaned);
    return {
      recommendation: parsed.recommendation,
      overall_summary: parsed.overall_summary,
      price_flow_summary: parsed.price_flow_summary,
      volume_summary: parsed.volume_summary,
      news_summary: parsed.news_summary,
      tip: parsed.tip
    };
  } catch (e) {
    console.error('Failed to parse AI JSON:', text);
    throw new Error('AI 응답 파싱 실패');
  }
}

// ------------------------------------------------------------
// 기존 규칙 기반 스코어 (AI 실패 시 Fallback 및 참고용)
// ------------------------------------------------------------
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
    const important = news.filter((n) => n.impact_label === '긍정적 영향 가능성' || n.impact_label === '부정적 영향 가능성');
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
  const { data, error } = await supabase.from('stock_analysis_runs').insert(payload).select('id').single();
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