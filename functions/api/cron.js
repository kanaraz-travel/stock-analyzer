// functions/api/cron.js
import { createClient } from '@supabase/supabase-js';

export async function onRequest(context) {
  const { request, env, waitUntil } = context; // ★ waitUntil 추가

  console.log(`[Cron] Request method: ${request.method}`);

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, x-cron-secret',
      },
    });
  }

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ 
      error: `Method ${request.method} not allowed. Please use POST.`,
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }

  const cronSecret = request.headers.get('x-cron-secret');
  if (!env.CRON_SECRET || cronSecret !== env.CRON_SECRET) {
    return new Response(JSON.stringify({ error: 'Unauthorized: x-cron-secret 헤더가 일치하지 않습니다.' }), { status: 401 });
  }

  const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const baseUrl = new URL(request.url).origin;

  // 중복 실행 방지
  const { data: currentStatus } = await admin.from('app_cache').select('value').eq('key', 'auto_batch_status').maybeSingle();
  if (currentStatus?.value?.status === 'running') {
    return new Response(JSON.stringify({ message: '이미 실행 중입니다.' }), { status: 200 });
  }

  // 상태 'running'으로 즉시 업데이트
  const now = new Date();
  const initialStatus = {
    status: 'running',
    last_run_at: now.toISOString(),
    last_success_at: currentStatus?.value?.last_success_at || null,
    total: 0, succeeded: 0, failed: 0
  };
  await admin.from('app_cache').upsert({ key: 'auto_batch_status', value: initialStatus, updated_at: now.toISOString() });

  // ★ 즉시 응답을 반환하고, 백그라운드에서 배치 실행
  const backgroundTask = (async () => {
    try {
      const popularRes = await fetch(`${baseUrl}/api/popular`);
      if (!popularRes.ok) throw new Error('인기 종목 조회 실패');
      const popularData = await popularRes.json();
      const items = (popularData.items || []).slice(0, 20);

      let succeeded = 0;
      let failed = 0;

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
            analysis_type: 'buy',
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
          
          await new Promise(r => setTimeout(r, 2500)); 
        } catch (e) {
          failed++;
        }
      }

      const finalStatus = {
        status: 'idle',
        last_run_at: now.toISOString(),
        last_success_at: new Date().toISOString(),
        total: items.length, succeeded, failed
      };
      await admin.from('app_cache').upsert({ key: 'auto_batch_status', value: finalStatus, updated_at: new Date().toISOString() });
      console.log('[Cron] Batch completed:', finalStatus);

    } catch (error) {
      const failStatus = {
        status: 'failed',
        last_run_at: now.toISOString(),
        last_success_at: currentStatus?.value?.last_success_at || null,
        total: 0, succeeded: 0, failed: 0,
        error: error.message
      };
      await admin.from('app_cache').upsert({ key: 'auto_batch_status', value: failStatus, updated_at: new Date().toISOString() });
      console.error('[Cron] Batch failed:', error.message);
    }
  })();

  // ★ Cloudflare Workers의 waitUntil을 사용하여 요청 수명과 무관하게 백그라운드 실행 보장
  waitUntil(backgroundTask);

  return new Response(JSON.stringify({ 
    message: '자동 이력 쌓기가 시작되었습니다. 백그라운드에서 진행됩니다.',
    status: 'running'
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}