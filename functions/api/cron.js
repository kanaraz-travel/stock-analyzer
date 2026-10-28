// functions/api/cron.js
import { createClient } from '@supabase/supabase-js';

export async function onRequest(context) {
  const { request, env, waitUntil } = context;

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
    return new Response(JSON.stringify({ error: `Method ${request.method} not allowed.` }), { status: 200, headers: { 'content-type': 'application/json' } });
  }

  const cronSecret = request.headers.get('x-cron-secret');
  if (!env.CRON_SECRET || cronSecret !== env.CRON_SECRET) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  }

  const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const baseUrl = new URL(request.url).origin;

  // 중복 실행 방지
  const { data: currentStatus } = await admin.from('app_cache').select('value').eq('key', 'auto_batch_status').maybeSingle();
  if (currentStatus?.value?.status === 'running') {
    return new Response(JSON.stringify({ message: '이미 실행 중입니다.' }), { status: 200 });
  }

  const now = new Date();
  const initialStatus = {
    status: 'running',
    last_run_at: now.toISOString(),
    last_success_at: currentStatus?.value?.last_success_at || null,
    total: 0, succeeded: 0, failed: 0, skipped: 0 // ★ skipped 추가
  };
  await admin.from('app_cache').upsert({ key: 'auto_batch_status', value: initialStatus, updated_at: now.toISOString() });

  const backgroundTask = (async () => {
    try {
      // 인기 종목 수집 (popular.js가 5단계 폴백 및 필터링을 거쳐 최대 20개 반환)
      const popularRes = await fetch(`${baseUrl}/api/popular`);
      if (!popularRes.ok) throw new Error('인기 종목 조회 실패');
      const popularData = await popularRes.json();
      
      const items = (popularData.items || []).slice(0, 20); // 최대 20개
      
      // 수집된 아이템이 20개 미만이라면 부족한 만큼은 '스킵'된 것으로 간주
      const totalRequested = 20;
      const skippedCount = Math.max(0, totalRequested - items.length);

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
        total: items.length, 
        succeeded, 
        failed, 
        skipped: skippedCount // ★ 계산된 스킵 카운트 반영
      };
      await admin.from('app_cache').upsert({ key: 'auto_batch_status', value: finalStatus, updated_at: new Date().toISOString() });
      console.log('[Cron] Batch completed:', finalStatus);

    } catch (error) {
      const failStatus = {
        status: 'failed',
        last_run_at: now.toISOString(),
        last_success_at: currentStatus?.value?.last_success_at || null,
        total: 0, succeeded: 0, failed: 0, skipped: 0,
        error: error.message
      };
      await admin.from('app_cache').upsert({ key: 'auto_batch_status', value: failStatus, updated_at: new Date().toISOString() });
      console.error('[Cron] Batch failed:', error.message);
    }
  })();

  waitUntil(backgroundTask);

  return new Response(JSON.stringify({ 
    message: '자동 이력 쌓기가 시작되었습니다. 백그라운드에서 진행됩니다.',
    status: 'running'
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}