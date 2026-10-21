// functions/api/analyze.js
import { createClient } from '@supabase/supabase-js';

const RULESET_VERSION = 'RULESET_AI_V11_NEWS_AGENT';

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

    // 1. 가격/거래량 분석 에이전트
    const analysisResult = await runAnalysisAgent(env, {
      ticker, stock_name, price_data, volume_data, news_items, analysis_type, holdings_data
    });

    // 2. 뉴스 분석 에이전트 (최근 5일치 뉴스 종합)
    const newsAnalysisResult = await runNewsAgent(env, {
      ticker, stock_name, news_items
    });

    // 3. 최종 심판 에이전트
    finalData = await runJudgeAgent(env, {
      ticker, stock_name, analysis_result: analysisResult, news_analysis_result: newsAnalysisResult, analysis_type, holdings_data
    });

    const validRecs = analysis_type === 'sell' 
      ? ['매도 추천', '부분 매도 고려', '보유 유지', '추가 매수 고려', '매수 추천', '판단 보류']
      : ['매수 추천', '매수 고려', '기다리기', '매도 고려', '매도 추천', '판단 보류'];

    if (!finalData || !finalData.recommendation) {
      throw new Error('추천 등급 누락');
    }
    
    const recClean = finalData.recommendation.replace(/\s+/g, '');
    const isValid = validRecs.some(r => r.replace(/\s+/g, '') === recClean || r.replace(/\s+/g, '').includes(recClean));
    
    if (!isValid) {
      if (recClean.includes('매수')) finalData.recommendation = '매수 고려';
      else if (recClean.includes('매도')) finalData.recommendation = '매도 고려';
      else if (recClean.includes('보유') || recClean.includes('기다리')) finalData.recommendation = '기다리기';
      else throw new Error(`알 수 없는 추천 등급: ${finalData.recommendation}`);
    }
    
    // 뉴스 분석 결과 병합
    finalData.news_analysis = newsAnalysisResult.news_analysis || '최근 5일 이내 주가에 유의미한 영향을 줄 만한 뉴스가 확인되지 않음.';

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
    volume_summary: finalData.volume_summary, news_summary: finalData.news_analysis, // 스키마 호환
    tip: finalData.tip || '', sources: news_items?.map((n) => ({ title: n.title, url: n.url })) ?? null,
  });

  return jsonResponse({
    score: scoreResult.totalScore, recommendation: finalData.recommendation,
    overall_summary: finalData.overall_summary, price_flow_summary: finalData.price_flow_summary,
    volume_summary: finalData.volume_summary, news_analysis: finalData.news_analysis,
    ruleset_version: RULESET_VERSION, data_status: 'LATEST', fallback: isFallback, debug: debugInfo,
    sources: news_items?.map((n) => ({ title: n.title, url: n.url })) ?? []
  });
}

async function runAnalysisAgent(env, payload) {
  const isSell = payload.analysis_type === 'sell';
  const role = isSell ? '주식 매도 분석가' : '주식 매수 분석가';
  
  let holdingsContext = '';
  if (isSell && payload.holdings_data) {
    holdingsContext = `(평균단가:${payload.holdings_data.avg_cost}원, 수익률:${payload.holdings_data.return_rate.toFixed(2)}%)`;
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

  const systemPrompt = `당신은 ${role}입니다. 제공된 최근 20영업일 데이터를 기반으로 분석하여 반드시 JSON 형식으로 응답하세요. 모든 문장은 '~함', '~임'으로 끝나는 명사형 어미를 사용하세요.`;
  const userPrompt = `
[데이터] ${payload.stock_name}(${payload.ticker}) 현재가:${pd.current_price}원 ${holdingsContext}
[최근 20영업일 지표] 1일등락:${changeRateStr} 1개월:${return1MStr} 20일선괴리:${ma20DispStr} 52주위치:${w52PosStr} 거래량:${volumeStr}

[응답 JSON 스키마 - 각 1~2문장으로 이전 분량의 70% 수준 유지]
{
  "agent_opinion": "종합 의견 (1~2문장)",
  "price_flow_analysis": "가격 분석 (1~2문장)",
  "volume_analysis": "거래량 분석 (1~2문장)"
}`;
  
  const response = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
    messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }], max_tokens: 1024, // 70% 분량 복원
  });
  
  return extractJSON(response?.response || '');
}

// ★ 신규: 뉴스 분석 에이전트
async function runNewsAgent(env, payload) {
  if (!payload.news_items || payload.news_items.length === 0) {
    return { news_analysis: '최근 5일 이내 주가에 영향을 줄 뉴스가 없음.' };
  }

  const newsStr = payload.news_items.map((n, i) => `[${i+1}] ${n.title} (${n.published_at})`).join('\n');

  const systemPrompt = `당신은 주식 뉴스 분석가입니다. 최근 5일 이내의 뉴스 중 주가에 영향을 줄 만한 핵심 내용만 선별하여 분석하고 반드시 JSON으로 응답하세요. '~함', '~임' 체를 사용하세요.`;
  const userPrompt = `
[종목] ${payload.stock_name} (${payload.ticker})
[최근 5일 뉴스 목록]
${newsStr}

[응답 JSON 스키마 - 아주 간결하게 1~2문장]
{
  "news_analysis": "주가에 영향을 줄 핵심 뉴스 내용을 선별하여 종합 분석한 결과 (1~2문장)"
}`;

  const response = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
    messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }], max_tokens: 512,
  });
  
  return extractJSON(response?.response || '{}');
}

async function runJudgeAgent(env, payload) {
  const isSell = payload.analysis_type === 'sell';
  
  let systemPrompt = `당신은 최종 판단을 내리는 심판입니다. 분석 결과를 종합하여 반드시 JSON 형식으로 응답하세요. '~함', '~임' 체를 사용하세요.`;
  let schema = '';

  if (isSell) {
    schema = `{
  "recommendation": "매도 추천" | "부분 매도 고려" | "보유 유지" | "추가 매수 고려" | "판단 보류",
  "overall_summary": "판단 이유 (1~2문장)"
}`;
  } else {
    schema = `{
  "recommendation": "매수 추천" | "매수 고려" | "기다리기" | "매도 고려" | "매도 추천",
  "overall_summary": "판단 이유 (1~2문장)"
}`;
  }

  const userPrompt = `
[가격/거래량 분석 의견] ${payload.analysis_result.agent_opinion}
[뉴스 분석 의견] ${payload.news_analysis_result?.news_analysis || '없음'}

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