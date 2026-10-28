// functions/api/cron.js
import { createClient } from '@supabase/supabase-js';

export async function onRequest(context) {
  const { request, env } = context;

  // ★ 디버깅용: 어떤 메서드로 들어왔는지 로그 출력
  console.log(`[Cron] Request method: ${request.method}`);

  // CORS 및 OPTIONS 요청 처리 (브라우저/크론 서비스 대응)
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, x-cron-secret',
      },
    });
  }

  // ★ GET 요청으로 테스트가 오더라도 405를 띄우지 않고 안내 메시지 반환
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ 
      error: `Method ${request.method} not allowed. Please use POST.`,
      hint: 'cron-job.org의 Test run이 GET으로 보낼 수 있습니다. 실제 스케줄러는 POST로 보냅니다.'
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }

  // 크론 서비스 인증 (보안)
  const cronSecret = request.headers.get('x-cron-secret');
  if (!env.CRON_SECRET || cronSecret !== env.CRON_SECRET) {
    return new Response(JSON.stringify({ error: 'Unauthorized: x-cron-secret 헤더가 일치하지 않습니다.' }), { status: 401 });
  }

  const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const baseUrl = new URL(request.url).origin;

  // 1. 중복 실행 방지
  const { data: currentStatus } = await admin.from('app_cache').select('value').eq('key', 'auto_batch_status').maybeSingle();
  if (currentStatus?.value?.status === 'running') {
    return new Response(JSON.stringify({ message: '이미 실행 중입니다.' }), { status: 200 });
  }

  // 2. 상태 'running'으로 업데이트
  const now = new Date();
  const initialStatus = {
    status: 'running',
    last_run_at: now.toISOString(),
    last_success_at: currentStatus?.value?.last_success_at || null,
    total: 0, succeeded: 0, failed: 0
  };
  await admin.from('app_cache').upsert({ key: 'auto_batch_status', value: initialStatus, updated_at: now.toISOString() });

  try {
    // 3. 인기 종목 조회
    const popularRes = await fetch(`${baseUrl}/api/popular`);
    if (!popularRes.ok) throw new Error('인기 종목 조회 실패');
    const popularData = await popularRes.json();
    const items = (popularData.items || []).slice(0, 20); // 20개 제한

    let succeeded = 0;
    let failed = 0;

    // 4. 순차 분석
    for (const stock of items) {
      try {
        const [qRes, nRes, hRes] = await Promise.all([
          fetch(`${baseUrl}/api/quote?ticker=${encodeURIComponent(stock.ticker)}`),
          fetch(`${baseUrl}/api/news?ticker=${encodeURIComponent(stock.name)}`),
          fetch(`${baseUrl}/api/history?ticker=${encodeURIComponent(stock.ticker)}`)
        ]);
        
        const qData = qRes.ok ? await qRes.json() : null;
        const nData = nRes.ok ? await nRes.json() : { items: [] };
        const hData = hRes.ok ? await hRes.json() : {};

        if (!qData || !qData.price) { failed++; continue; }

        const payload = {
          ticker: stock.ticker,
          stock_name: stock.name,
          analysis_type: 'buy', // 자동화는 무조건 매수 관점
          price_data: { 
            current_price: qData.price, 
            change_rate: qData.change_rate,
            w52_hgpr: qData.w52_hgpr, w52_lwpr: qData.w52_lwpr,
            market_status: qData.market_status, quote_as_of: qData.quote_as_of,
            return_1m: hData.return_1m, ma20_disparity: hData.ma20_disparity
          },
          volume_data: { current_volume: qData.volume, avg_volume_20: hData.avg_volume_20 },
          news_items: nData.items,
          holdings_data: null
        };

        const analyzeRes = await fetch(`${baseUrl}/api/analyze`, {
          method: 'POST',
          headers: { 
            'content-type': 'application/json',
            'x-cron-secret': env.CRON_SECRET
          },
          body: JSON.stringify(payload)
        });

        if (analyzeRes.ok) succeeded++;
        else failed++;
        
        await new Promise(r => setTimeout(r, 2500)); // Rate Limit 방지
      } catch (e) {
        failed++;
      }
    }

    // 5. 성공 상태로 업데이트
    const finalStatus = {
      status: 'idle',
      last_run_at: now.toISOString(),
      last_success_at: new Date().toISOString(),
      total: items.length, succeeded, failed
    };
    await admin.from('app_cache').upsert({ key: 'auto_batch_status', value: finalStatus, updated_at: new Date().toISOString() });

    return new Response(JSON.stringify(finalStatus), { status: 200 });

  } catch (error) {
    // 6. 실패 상태로 업데이트
    const failStatus = {
      status: 'failed',
      last_run_at: now.toISOString(),
      last_success_at: currentStatus?.value?.last_success_at || null,
      total: 0, succeeded: 0, failed: 0,
      error: error.message
    };
    await admin.from('app_cache').upsert({ key: 'auto_batch_status', value: failStatus, updated_at: new Date().toISOString() });
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
}