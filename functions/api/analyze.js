// functions/api/analyze.js
// POST /api/analyze
// Body: { ticker, stock_name, price_data: {...}, volume_data: {...}, news_items: [...] }

import { createClient } from '@supabase/supabase-js';

const RULESET_VERSION = 'RULESET_V1';

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

  // 2) 데이터 부족 여부 확인
  const dataSufficient =
    price_data &&
    typeof price_data.return_1d === 'number' &&
    typeof price_data.return_5d === 'number' &&
    typeof price_data.return_20d === 'number';

  if (!dataSufficient) {
    // 판단 보류 저장
    await saveAnalysisRun(supabase, {
      user_id: userId,
      ticker,
      stock_name,
      score: null,
      recommendation: '판단 보류',
      ruleset_version: RULESET_VERSION,
      data_status: 'INSUFFICIENT_DATA',
      overall_summary: '가격 데이터가 부족해 판단을 보류합니다.',
      price_flow_summary: null,
      volume_summary: null,
      news_summary: null,
      tip: null,
      sources: null,
      market_facts: { price_data, volume_data, news_items },
    });

    return jsonResponse({
      recommendation: '판단 보류',
      overall_summary: '가격 데이터가 부족해 판단을 보류합니다.',
      data_status: 'INSUFFICIENT_DATA',
      ruleset_version: RULESET_VERSION,
    });
  }

  // 3) 규칙 기반 스코어 계산 (서버 로직)
  const scoreResult = computeScore(price_data, volume_data, news_items);

  // 4) AI 요약 시도 (실패하면 규칙 기반 기본 문장으로 대체)
  let aiSummary = null;
  try {
    aiSummary = await callWorkersAI(env, {
      ...scoreResult,
      ticker,
      stock_name,
      price_data,
      volume_data,
      news_items,
    });
  } catch (e) {
    // AI 실패 시 로그만 남기고 fallback
    console.warn('Workers AI failed:', e.message);
  }

  const finalSummary = aiSummary || buildFallbackSummary(scoreResult);

  // 5) 분석 결과 저장
  const saved = await saveAnalysisRun(supabase, {
    user_id: userId,
    ticker,
    stock_name,
    quote_price: price_data.current_price ?? null,
    quote_as_of: price_data.quote_as_of ?? null,
    data_status: 'LATEST',
    score: scoreResult.totalScore,
    recommendation: scoreResult.recommendation,
    ruleset_version: RULESET_VERSION,
    market_facts: { price_data, volume_data, news_items },
    overall_summary: finalSummary.overall_summary,
    price_flow_summary: finalSummary.price_flow_summary,
    volume_summary: finalSummary.volume_summary,
    news_summary: finalSummary.news_summary,
    tip: finalSummary.tip,
    sources: news_items?.map((n) => ({ title: n.title, url: n.url })) ?? null,
  });

  return jsonResponse({
    id: saved?.id,
    score: scoreResult.totalScore,
    recommendation: scoreResult.recommendation,
    overall_summary: finalSummary.overall_summary,
    price_flow_summary: finalSummary.price_flow_summary,
    volume_summary: finalSummary.volume_summary,
    news_summary: finalSummary.news_summary,
    tip: finalSummary.tip,
    ruleset_version: RULESET_VERSION,
    data_status: 'LATEST',
    fallback: !aiSummary,
  });
}

// ------------------------------------------------------------
// 규칙 기반 스코어 (명세서 7.2)
// ------------------------------------------------------------
function computeScore(price, volume, news) {
  let priceScore = 0;

  // 가격 흐름 (-2 ~ +2)
  if (price.return_5d > 0.02) priceScore += 2;
  else if (price.return_5d > 0) priceScore += 1;
  else if (price.return_5d < -0.02) priceScore -= 2;
  else if (price.return_5d < 0) priceScore -= 1;

  if (price.return_20d > 0.05) priceScore += 1;
  else if (price.return_20d < -0.05) priceScore -= 1;

  priceScore = clamp(priceScore, -2, 2);

  // 거래량 (-1 ~ +1)
  let volumeScore = 0;
  if (volume && typeof volume.ratio_5d === 'number') {
    if (volume.ratio_5d > 1.2) volumeScore = 1;
    else if (volume.ratio_5d < 0.8) volumeScore = -1;
  }

  // 뉴스/공시 (-2 ~ +2)
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

  // 위험 감점 (0 ~ -2)
  let riskPenalty = 0;
  if (price.volatility_20d > 0.08) riskPenalty -= 1; // 높은 변동성
  if (price.quote_is_stale) riskPenalty -= 1; // 오래된 시세
  riskPenalty = clamp(riskPenalty, -2, 0);

  const totalScore = priceScore + volumeScore + newsScore + riskPenalty;

  let recommendation;
  if (totalScore >= 4) recommendation = '매수 추천';
  else if (totalScore >= 2) recommendation = '매수 고려';
  else if (totalScore >= -1) recommendation = '기다리기';
  else if (totalScore >= -3) recommendation = '매도 고려';
  else recommendation = '매도 추천';

  return { totalScore, recommendation, priceScore, volumeScore, newsScore, riskPenalty };
}

// ------------------------------------------------------------
// Cloudflare Workers AI 호출
// ------------------------------------------------------------
async function callWorkersAI(env, payload) {
  if (env.AI) {
    const response = await env.AI.run('@cf/meta/llama-3.2-1b-instruct', {
      messages: [
        {
          role: 'system',
          content:
            '당신은 주식 초보자에게 쉬운 한국어로 설명하는 도우미입니다. 제공된 계산 결과와 뉴스 사실만 사용하고, 새로운 숫자나 사실을 만들지 마세요. 반드시 지정된 JSON 스키마로만 응답하세요.',
        },
        {
          role: 'user',
          content: JSON.stringify({
            instruction:
              '다음 데이터를 바탕으로 overall_summary, price_flow_summary, volume_summary, news_summary, tip 필드를 가진 JSON을 생성하세요. 모든 문장은 1~2문장으로 짧게 작성하세요.',
            data: payload,
            required_schema: {
              overall_summary: 'string (1-2문장)',
              price_flow_summary: 'string (1-2문장)',
              volume_summary: 'string (1-2문장)',
              news_summary: 'string (1-2문장)',
              tip: 'string (1-3문장)',
            },
          }),
        },
      ],
      max_tokens: 512,
    });

    const text = response?.response || '';
    return parseAIJson(text);
  }

  throw new Error('Workers AI binding not configured');
}

function parseAIJson(text) {
  const cleaned = text.replace(/```json|```/g, '').trim();
  return JSON.parse(cleaned);
}

// ------------------------------------------------------------
// AI 실패 시 규칙 기반 기본 문장
// ------------------------------------------------------------
function buildFallbackSummary(score) {
  const rec = score.recommendation;
  return {
    overall_summary: `현재 규칙 기반 판단은 "${rec}"입니다. 이는 검증 전 실험적 기준이며 투자 결정을 보장하지 않습니다.`,
    price_flow_summary: '최근 가격 흐름 데이터를 바탕으로 계산된 결과입니다.',
    volume_summary: '거래량 데이터를 바탕으로 계산된 결과입니다.',
    news_summary: '확인된 뉴스/공시가 없거나 요약을 생성하지 못했습니다.',
    tip: '이 분석은 참고용이며, 투자 결정은 본인의 판단과 책임 하에 이루어져야 합니다.',
  };
}

// ------------------------------------------------------------
// 분석 로그 저장
// ------------------------------------------------------------
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
