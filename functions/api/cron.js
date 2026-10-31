// functions/api/cron.js
import { createClient } from '@supabase/supabase-js';

const BATCH_SIZE = 1; 
const STALE_LOCK_MS = 5 * 60 * 1000; // 5분으로 여유 있게 설정
const TOTAL_ITEMS = 20;
const TIME_BUDGET_MS = 8000; // 8초 (안전하게 다음 배치 호출)
const CACHE_EXPIRES_AT = '2099-12-31T23:59:59Z'; 

export async function onRequest(context) {
  const { request, env, waitUntil } = context;
  if (request.method === 'OPTIONS') return corsOk();
  if (request.method !== 'POST') return jsonResponse({ error: 'POST만 허용됩니다.' }, 405);
  
  const secret = request.headers.get('x-cron-secret');
  if (!env.CRON_SECRET || secret !== env.CRON_SECRET) return jsonResponse({ error: 'Unauthorized' }, 401);

  const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const baseUrl = new URL(request.url).origin;

  try {
    const isContinue = request.headers.get('x-cron-continue') === '1';
    let progress;

    if (isContinue) {
      progress = await loadProgress(admin);
      const expectedRunId = request.headers.get('x-run-id');
      if (!progress || progress.run_id !== expectedRunId || progress.status !== 'running') {
        return jsonResponse({ status: 'ignored', reason: 'no_active_run' }, 200);
      }
    } else {
      const existing = await loadProgress(admin);
      if (existing?.status === 'running') {
        const lastActivity = new Date(existing.updated_at || existing.started_at).getTime();
        if ((Date.now() - lastActivity) < STALE_LOCK_MS) {
          return jsonResponse({ status: 'already_running', processed: existing.processed }, 200);
        }
      }
      
      const newProgress = await createNewProgress(baseUrl);
      if (!newProgress) throw new Error('인기 종목을 가져오지 못했습니다.');

      const { data: locked, error } = await admin.from('auto_batch_progress')
        .update({ status: 'running', run_id: newProgress.run_id, started_at: newProgress.started_at, updated_at: new Date().toISOString(), payload: newProgress })
        .eq('id', 1).neq('status', 'running').select();

      if (error || !locked || locked.length === 0) {
        return jsonResponse({ status: 'already_running' }, 200);
      }
      progress = newProgress;
    }

    await updateStatusBadge(admin, progress);

    waitUntil(processBatch(admin, baseUrl, env, progress).catch(async (err) => {
      console.error('[cron] processBatch fatal error:', err);
      progress.status = 'failed'; progress.error = err.message;
      await saveProgress(admin, progress); await updateStatusBadge(admin, progress);
    }));

    return jsonResponse({ status: 'running', run_id: progress.run_id }, 200);
  } catch (e) {
    console.error('[cron] onRequest error:', e);
    await admin.from('app_cache').upsert({
      key: 'auto_batch_status',
      value: { status: 'failed', error: e.message, last_run_at: new Date().toISOString() },
      updated_at: new Date().toISOString(), expires_at: CACHE_EXPIRES_AT
    });
    return jsonResponse({ error: e.message }, 500);
  }
}

async function createNewProgress(baseUrl) {
  const popRes = await fetch(`${baseUrl}/api/popular?exclude_preferred=1`);
  if (!popRes.ok) return null;
  const popData = await popRes.json();
  const items = (popData.items || []).slice(0, TOTAL_ITEMS);
  if (items.length === 0) return null;

  return {
    run_id: crypto.randomUUID(), status: 'running', started_at: new Date().toISOString(),
    items: items.map(i => ({ ticker: i.ticker, name: i.name, rank: i.rank })),
    processed: 0, succeeded: 0, failed: 0, skipped: 0, results: [],
  };
}

async function processBatch(admin, baseUrl, env, progress) {
  const startTime = Date.now();
  let batchCount = 0;

  while (progress.processed < progress.items.length && batchCount < BATCH_SIZE) {
    if (Date.now() - startTime > TIME_BUDGET_MS) break;
    
    const stock = progress.items[progress.processed];
    const result = await analyzeOne(baseUrl, env, stock);
    
    progress.results.push({ ticker: stock.ticker, name: stock.name, ...result });
    progress.processed++;

    if (result.saved) progress.succeeded++;
    else if (result.fallback_reason === 'DATA_INSUFFICIENT' || result.data_quality === 'UNKNOWN') progress.skipped++;
    else progress.failed++;

    await saveProgress(admin, progress);
    await updateStatusBadge(admin, progress); 
    
    batchCount++;
    if (progress.processed < progress.items.length) await new Promise(r => setTimeout(r, 1000));
  }

  if (progress.processed < progress.items.length) {
    // ★ await를 붙여서 다음 배치가 안전하게 시작되었는지 확인
    await triggerContinue(baseUrl, env, admin, progress);
  } else {
    const isFullFail = progress.succeeded === 0 && progress.failed > 0;
    progress.status = isFullFail ? 'failed' : 'completed';
    progress.completed_at = new Date().toISOString();
    await saveProgress(admin, progress);
    await updateStatusBadge(admin, progress);
  }
}

async function analyzeOne(baseUrl, env, stock) {
  try {
    const [qRes, nRes, hRes] = await Promise.all([
      fetch(`${baseUrl}/api/quote?ticker=${encodeURIComponent(stock.ticker)}`),
      fetch(`${baseUrl}/api/news?ticker=${encodeURIComponent(stock.name)}`),
      fetch(`${baseUrl}/api/history?ticker=${encodeURIComponent(stock.ticker)}`),
    ]);
    const qData = qRes.ok ? await qRes.json() : null;
    const hData = hRes.ok ? await hRes.json() : {};
    if (!qData?.price) return { ok: false, saved: false, fallback: false, reason: 'no_price' };
    
    const historyAvailable = hData.data_available !== false;
    const nData = nRes.ok ? await nRes.json() : { items: [] };

    const payload = {
      ticker: stock.ticker, stock_name: stock.name, analysis_type: 'buy',
      price_data: {
        current_price: qData.price, change_rate: qData.change_rate, w52_hgpr: qData.w52_hgpr, w52_lwpr: qData.w52_lwpr,
        market_status: qData.market_status, quote_as_of: qData.quote_as_of, server_time: qData.server_time,
        return_1m: historyAvailable ? (hData.return_1m ?? null) : null, 
        ma20_disparity: historyAvailable ? (hData.ma20_disparity ?? null) : null, 
        price_source: 'FRESH',
      },
      volume_data: historyAvailable ? { current_volume: qData.volume, avg_volume_20: hData.avg_volume_20 ?? null } : null,
      news_items: nData.items || [], holdings_data: null,
    };

    const aRes = await fetch(`${baseUrl}/api/analyze`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-cron-secret': env.CRON_SECRET }, body: JSON.stringify(payload),
    });
    if (!aRes.ok) return { ok: false, saved: false, fallback: false, reason: `http_${aRes.status}` };

    const result = await aRes.json();
    return { ok: true, saved: !!result.saved, fallback: !!result.fallback, fallback_reason: result.fallback_reason || null, data_quality: result.data_quality };
  } catch (e) {
    return { ok: false, saved: false, fallback: false, reason: `exception_${e.message?.slice(0, 40)}` };
  }
}

async function triggerContinue(baseUrl, env, admin, progress) {
  try {
    const res = await fetch(`${baseUrl}/api/cron`, {
      method: 'POST', headers: { 'x-cron-secret': env.CRON_SECRET, 'x-cron-continue': '1', 'x-run-id': progress.run_id },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.status !== 'running' && data.status !== 'already_running') throw new Error(`Invalid response: ${data.status}`);
  } catch (e) {
    console.error('[cron] triggerContinue failed:', e.message);
    progress.status = 'interrupted'; progress.error = `이어달리기 실패: ${e.message}`;
    await saveProgress(admin, progress); await updateStatusBadge(admin, progress);
  }
}

async function loadProgress(admin) {
  const { data } = await admin.from('auto_batch_progress').select('*').eq('id', 1).maybeSingle();
  return data ? { ...data.payload, updated_at: data.updated_at } : null; 
}

async function saveProgress(admin, progress) {
  const { error } = await admin.from('auto_batch_progress').upsert({
    id: 1, run_id: progress.run_id, status: progress.status,
    started_at: progress.started_at, updated_at: new Date().toISOString(), payload: progress,
  });
  if (error) console.error('[cron] saveProgress error:', error.message);
}

async function updateStatusBadge(admin, progress) {
  try {
    const { data: existing } = await admin.from('app_cache').select('value').eq('key', 'auto_batch_status').maybeSingle();
    const prevSuccess = existing?.value?.last_success_at || null;
    
    let successAt = prevSuccess;
    if (progress.succeeded > 0) successAt = new Date().toISOString();

    await admin.from('app_cache').upsert({
      key: 'auto_batch_status',
      value: {
        status: progress.status, last_run_at: new Date().toISOString(), last_success_at: successAt,
        total: progress.items.length, succeeded: progress.succeeded, failed: progress.failed, skipped: progress.skipped,
        run_id: progress.run_id, error: progress.error || null,
      },
      updated_at: new Date().toISOString(), expires_at: CACHE_EXPIRES_AT
    });
  } catch (e) { console.error('[cron] updateStatusBadge failed:', e.message); }
}

function corsOk() { return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, x-cron-secret, x-cron-continue, x-run-id' } }); }
function jsonResponse(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } }); }