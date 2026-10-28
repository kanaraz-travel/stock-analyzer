// functions/api/cron.js
import { createClient } from '@supabase/supabase-js';

const BATCH_SIZE = 5;
const STALE_LOCK_MS = 15 * 60 * 1000;
const TOTAL_ITEMS = 20;

export async function onRequest(context) {
  const { request, env, waitUntil } = context;
  if (request.method === 'OPTIONS') return corsOk();
  if (request.method !== 'POST') return jsonResponse({ error: 'POST만 허용됩니다.' }, 405);
  const secret = request.headers.get('x-cron-secret');
  if (!env.CRON_SECRET || secret !== env.CRON_SECRET) return jsonResponse({ error: 'Unauthorized' }, 401);

  const isContinue = request.headers.get('x-cron-continue') === '1';
  const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const baseUrl = new URL(request.url).origin;

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
      const elapsed = Date.now() - new Date(existing.started_at).getTime();
      if (elapsed < STALE_LOCK_MS) return jsonResponse({ status: 'already_running', processed: existing.processed, total: existing.items?.length || 0 }, 200);
      console.warn('[cron] stale run detected, restarting', { run_id: existing.run_id, elapsed });
    }
    progress = await startNewRun(admin, baseUrl);
    if (!progress) return jsonResponse({ error: '인기 종목을 가져오지 못했습니다.' }, 502);
  }

  waitUntil(processBatch(admin, baseUrl, env, progress));

  return jsonResponse({ status: 'running', run_id: progress.run_id, processed: progress.processed, total: progress.items.length }, 200);
}

async function startNewRun(admin, baseUrl) {
  const popRes = await fetch(`${baseUrl}/api/popular?exclude_preferred=1`);
  if (!popRes.ok) return null;
  const popData = await popRes.json();
  const items = (popData.items || []).slice(0, TOTAL_ITEMS);
  if (items.length === 0) return null;

  const progress = {
    run_id: crypto.randomUUID(),
    status: 'running',
    started_at: new Date().toISOString(),
    items: items.map(i => ({ ticker: i.ticker, name: i.name, rank: i.rank, source: i.source || null, scores: i.scores || null })),
    processed: 0, succeeded: 0, failed: 0, skipped: 0, results: [],
  };
  await saveProgress(admin, progress);
  await updateStatusBadge(admin, progress);
  return progress;
}

async function processBatch(admin, baseUrl, env, progress) {
  const startTime = Date.now();
  const TIME_BUDGET_MS = 22000;
  let batchCount = 0;

  while (progress.processed < progress.items.length && batchCount < BATCH_SIZE) {
    if (Date.now() - startTime > TIME_BUDGET_MS) break;
    const stock = progress.items[progress.processed];
    const result = await analyzeOne(baseUrl, env, stock);
    progress.results.push({ ticker: stock.ticker, name: stock.name, ...result });
    progress.processed++;

    if (result.saved && !result.fallback) progress.succeeded++;
    else if (result.fallback) progress.skipped++;
    else progress.failed++;

    await saveProgress(admin, progress);
    batchCount++;
    if (progress.processed < progress.items.length) await sleep(1500);
  }

  if (progress.processed < progress.items.length) {
    await triggerContinue(baseUrl, env, progress);
  } else {
    // skipped는 실패가 아니므로 failed > 0인 경우만 전체 실패로 판정
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
    if (!qData?.price) return { ok: false, saved: false, fallback: false, reason: 'no_price' };
    const dq = qData.data_status;
    if (dq === 'STALE' || dq === 'UNKNOWN') return { ok: true, saved: false, fallback: false, reason: `skipped_${dq}` };

    const nData = nRes.ok ? await nRes.json() : { items: [] };
    const hData = hRes.ok ? await hRes.json() : {};

    const payload = {
      ticker: stock.ticker, stock_name: stock.name, analysis_type: 'buy',
      price_data: {
        current_price: qData.price, change_rate: qData.change_rate,
        w52_hgpr: qData.w52_hgpr, w52_lwpr: qData.w52_lwpr,
        market_status: qData.market_status, quote_as_of: qData.quote_as_of,
        server_time: qData.server_time, return_1m: hData.return_1m ?? null,
        ma20_disparity: hData.ma20_disparity ?? null, price_source: 'FRESH',
      },
      volume_data: { current_volume: qData.volume, avg_volume_20: hData.avg_volume_20 ?? null },
      news_items: nData.items || [], holdings_data: null,
    };

    const aRes = await fetch(`${baseUrl}/api/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cron-secret': env.CRON_SECRET },
      body: JSON.stringify(payload),
    });
    if (!aRes.ok) return { ok: false, saved: false, fallback: false, reason: `http_${aRes.status}` };

    const result = await aRes.json();
    return { ok: true, saved: !!result.saved, fallback: !!result.fallback, reason: result.fallback_reason || null };
  } catch (e) {
    return { ok: false, saved: false, fallback: false, reason: `exception_${e.message?.slice(0, 40)}` };
  }
}

async function triggerContinue(baseUrl, env, progress) {
  try {
    await fetch(`${baseUrl}/api/cron`, {
      method: 'POST',
      headers: { 'x-cron-secret': env.CRON_SECRET, 'x-cron-continue': '1', 'x-run-id': progress.run_id },
    });
  } catch (e) {
    progress.status = 'interrupted';
    progress.interrupted_at = new Date().toISOString();
  }
}

async function loadProgress(admin) {
  const { data } = await admin.from('auto_batch_progress').select('payload').eq('id', 1).maybeSingle();
  return data?.payload || null;
}

async function saveProgress(admin, progress) {
  await admin.from('auto_batch_progress').upsert({
    id: 1, run_id: progress.run_id, status: progress.status,
    started_at: progress.started_at, updated_at: new Date().toISOString(),
    payload: progress,
  });
}

async function updateStatusBadge(admin, progress) {
  // ★ 이전 last_success_at 유지
  const { data: existing } = await admin.from('app_cache').select('value').eq('key', 'auto_batch_status').maybeSingle();
  const prevSuccess = existing?.value?.last_success_at || null;
  const successAt = progress.status === 'completed'
    ? (progress.completed_at || new Date().toISOString())
    : prevSuccess;

  await admin.from('app_cache').upsert({
    key: 'auto_batch_status',
    value: {
      status: progress.status,
      last_run_at: progress.started_at,
      last_success_at: successAt,
      total: progress.items.length,
      succeeded: progress.succeeded,
      failed: progress.failed,
      skipped: progress.skipped,
      run_id: progress.run_id,
    },
    updated_at: new Date().toISOString(),
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function corsOk() { return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, x-cron-secret, x-cron-continue, x-run-id' } }); }
function jsonResponse(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } }); }