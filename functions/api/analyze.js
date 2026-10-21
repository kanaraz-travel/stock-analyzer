// functions/api/analyze.js
import { createClient } from '@supabase/supabase-js';

const RULESET_VERSION = 'RULESET_AI_V5_FIXED';

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
      recommendation: '판단 보류', overall_summary: '현재가 데이터가 부족해 분석을 진행할 수 없습니다.',
      price_flow_summary: '-', volume_summary: '-', news_summary: '-', price_tip: '-', volume_tip: '-', tip: '데이터가 부족합니다.', fallback: true,
    });
  }

  const scoreResult = computeScore(price_data, volume_data, news_items, analysis_type);
  let finalData = null;
  let isFallback = false;
  let debugInfo = null;

  try {
    if (!env.AI) throw new Error('Workers AI binding(env.AI)이 설정되지 않았습니다. Cloudflare 대시보드에서 AI 바인딩을 추가해 주세요.');

    // 에이전트 1: 분석
    const analysisResult = await runAnalysisAgent(env, {
      ticker, stock_name, price_data, volume_data, news_items, rule_based_score: scoreResult, analysis_type, holdings_data
    });

    // 에이전트 2: 심판
    finalData = await runJudgeAgent(env, {
      ticker, stock_name, analysis_result: analysisResult, rule_based_score: scoreResult, price_data, news_items, analysis_type, holdings_data
    });

    const validRecs = analysis_type === 'sell' 
      ? ['매도 추천', '부분 매도 고려', '보유 유지', '추가 매수 고려', '매수 추천', '판단 보류']
      : ['매수 추천', '매수 고려', '기다리기', '매도 고려', '매도 추천', '판단 보류'];

    if (!finalData || !validRecs.includes(finalData.recommendation)) {
      throw new Error('심판 에이전트의 응답 형식이 유효하지 않습니다. (추천 등급 누락)');
    }
  } catch (e) {
    console.error('Multi-agent analysis failed:', e.message); // Cloudflare 로그에 출력됨
    isFallback = true; 
    debugInfo = e.message;
    
    finalData = {
      recommendation: analysis_type === 'sell' ? '보유 유지' : scoreResult.recommendation,
      overall_summary: `AI 분석이 일시적으로 제한되어 기본 지표로 판단했습니다. (원인: ${e.message})`,
      price_flow_summary: '최근 가격 흐름 데이터를 바탕으로 계산된 결과입니다.',
      volume_summary: '거래량 데이터를 바탕으로 계산된 결과입니다.',
      news_summary: news_items?.length ? '최근 확인된 뉴스가 있습니다.' : '확인된 주요 뉴스가 없습니다.',
      price_tip: '이 분석은 참고용이며, 투자 결정의 책임은 본인에게 있습니다.',
      volume_tip: '이 분석은 참고용이며, 투자 결정의 책임은 본인에게 있습니다.',
      tip: '이 분석은 참고용입니다.',
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
    price_tip: finalData.price_tip || finalData.tip, volume_tip: finalData.volume_tip || finalData.tip,
    ruleset_version: RULESET_VERSION, data_status: 'LATEST', fallback: isFallback, debug: debugInfo,
  });
}

async function runAnalysisAgent(env, payload) {
  const isSell = payload.analysis_type === 'sell';
  const role = isSell ? '현재 주식을 보유 중인 투자자를 돕는 매도 분석가' : '새로운 매수를 고려하는 주식 초보자를 돕는 매수 분석가';
  
  let holdingsContext = '';
  if (isSell && payload.holdings_data) {
    holdingsContext = `
- 사용자 평균 매수가: ${payload.holdings_data.avg_cost}원
- 사용자 현재 수익률: ${payload.holdings_data.return_rate.toFixed(2)}%
- 보유 수량: ${payload.holdings_data.quantity}주`;
  }

  const systemPrompt = `당신은 ${role}입니다. 제공된 [데이터]를 바탕으로 현재 주식의 상태를 분석하세요. 반드시 제공된 JSON 스키마 형식으로만 응답해야 합니다.`;
  const userPrompt = `
[데이터]
- 종목명: ${payload.stock_name} (${payload.ticker})
- 현재가: ${payload.price_data.current_price}원
- 등락률: ${payload.price_data.return_1d ? (payload.price_data.return_1d * 100).toFixed(2) + '%' : '알 수 없음'}${holdingsContext}
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
    messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }], max_tokens: 1024,
  });
  
  return extractJSON(response?.response || '');
}

async function runJudgeAgent(env, payload) {
  const isSell = payload.analysis_type === 'sell';
  
  let systemPrompt = '';
  let schema = '';

  if (isSell) {
    systemPrompt = `당신은 최종 매도 판단을 내리는 심판 에이전트입니다. 분석 에이전트의 의견과 사용자의 수익률을 종합하여 최종 결정을 내리세요. 반드시 JSON 형식으로만 응답하세요.
- 매도 추천: 즉시 매도 고려
- 부분 매도 고려: 일부 이익 실현 고려
- 보유 유지: 계속 보유
- 추가 매수 고려: 저가 매수 기회
- 판단 보류: 데이터 부족`;
    schema = `{
  "recommendation": "매도 추천" | "부분 매도 고려" | "보유 유지" | "추가 매수 고려" | "판단 보류",
  "overall_summary": "최종 판단 이유 요약 (초보자용, 2문장)",
  "price_flow_summary": "가격 흐름에 대한 최종 분석 (1~2문장)",
  "volume_summary": "거래량에 대한 최종 분석 (1~2문장)",
  "news_summary": "뉴스/공시 영향 (1~2문장)",
  "price_tip": "가격 상황에서의 TIP (1문장)",
  "volume_tip": "거래량 상황에서의 TIP (1문장)"
}`;
  } else {
    systemPrompt = `당신은 최종 매수 판단을 내리는 심판 에이전트입니다. 분석 에이전트의 의견을 종합하여 아래 5단계 중 하나를 결정하세요. 반드시 JSON 형식으로만 응답하세요.`;
    schema = `{
  "recommendation": "매수 추천" | "매수 고려" | "기다리기" | "매도 고려" | "매도 추천",
  "overall_summary": "최종 판단 이유 요약 (초보자용, 2문장)",
  "price_flow_summary": "가격 흐름에 대한 최종 분석 (1~2문장)",
  "volume_summary": "거래량에 대한 최종 분석 (1~2문장)",
  "news_summary": "뉴스/공시 영향 (1~2문장)",
  "price_tip": "가격 상황에서의 TIP (1문장)",
  "volume_tip": "거래량 상황에서의 TIP (1문장)"
}`;
  }

  const userPrompt = `
[분석 에이전트의 1차 의견]
- 종합 의견: ${payload.analysis_result.agent_opinion}
- 가격 흐름 분석: ${payload.analysis_result.price_flow_analysis}
- 거래량 분석: ${payload.analysis_result.volume_analysis}
- 뉴스 영향 분석: ${payload.analysis_result.news_impact_analysis}
- 리스크 요인: ${payload.analysis_result.risk_factors}

[응답 JSON 스키마]
${schema}`;

  const response = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
    messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }], max_tokens: 1024,
  });
  return extractJSON(response?.response || '');
}

// ★ 수정된 extractJSON: 문자열과 객체를 모두 처리
function extractJSON(data) {
  if (data == null) throw new Error('AI 응답이 비어있습니다.');
  
  // 이미 객체인 경우 (Cloudflare Workers AI가 JSON을 파싱해서 반환한 경우)
  if (typeof data === 'object') {
    return data;
  }
  
  // 문자열인 경우 JSON 추출
  const text = String(data);
  const jsonStart = text.indexOf('{');
  const jsonEnd = text.lastIndexOf('}');
  if (jsonStart === -1 || jsonEnd === -1) {
    throw new Error('AI 응답에서 JSON을 찾을 수 없습니다. 원본: ' + text.slice(0, 100));
  }
  
  const jsonStr = text.substring(jsonStart, jsonEnd + 1);
  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    throw new Error('AI 응답 JSON 파싱 실패: ' + e.message + ' (원본: ' + jsonStr.slice(0, 100) + ')');
  }
}

function computeScore(price, volume, news, type) {
  let score = 0;
  if (price.return_1d > 0.02) score += 1; else if (price.return_1d < -0.02) score -= 1;
  return { totalScore: score, recommendation: score > 0 ? '매수 고려' : '기다리기' };
}

async function saveAnalysisRun(supabase, payload) {
  const { error } = await supabase.from('stock_analysis_runs').insert(payload).select('id').single();
  if (error) console.error('saveAnalysisRun error:', error.message);
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}