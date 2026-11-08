// functions/api/cron.js
import { createClient } from '@supabase/supabase-js';

const BATCH_SIZE = 1; 
const STALE_LOCK_MS = 10 * 60 * 1000; // ★ 락 대기 시간 5분 -> 10분으로 연장
const TOTAL_ITEMS = 20;
const TIME_BUDGET_MS = 5000; 
const CACHE_EXPIRES_AT = '2099-12-31T23:59:59Z'; 

const FALLBACK_ITEMS = [
  { ticker: '000660', name: 'SK하이닉스' }, { ticker: '005930', name: '삼성전자' },
  { ticker: '180640', name: '한진칼' }, { ticker: '009150', name: '삼성전기' },
  { ticker: '028300', name: 'HLB' }, { ticker: '222800', name: '심텍' },
  { ticker: '402340', name: 'SK스퀘어' }, { ticker: '007810', name: '코리아써키트' },
  { ticker: '006400', name: '삼성SDI' }, { ticker: '046890', name: '서울반도체' },
  { ticker: '298040', name: '효성중공업' }, { ticker: '010060', name: 'OCI홀딩스' },
  { ticker: '053800', name: '안랩' }, { ticker: '042660', name: '한화오션' },
  { ticker: '047920', name: 'HLB제약' }, { ticker: '034020', name: '두산에너빌리티' },
  { ticker: '356860', name: '티엘비' }, { ticker: '002320', name: '한진' },
  { ticker: '196170', name: '알테오젠' }, { ticker: '000990', name: 'DB하이텍' },
  { ticker: '007660', name: '이수페타시스' }, { ticker: '042700', name: '한미반도체' },
  { ticker: '010140', name: '삼성중공업' }, { ticker: '328130', name: '루닛' },
  { ticker: '066570', name: 'LG전자' }
];

async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return response;
  } catch (e) {
    clearTimeout(id);
    if (e.name === 'AbortError') throw new Error('요청 시간 초과');
    throw new Error(`네트워크 오류: ${e.message}`);
  }
}

export async function onRequest(context) {
  const { request, env, waitUntil } = context;
  if (request.method === 'OPTIONS') return corsOk();
  
  if (request.method !== 'POST' && request.method !== 'GET') {
    return jsonResponse({ error: 'POST 또는 GET만 허용됩니다.' }, 405);
  }
  
  const secret = request.headers.get('x-cron-secret');
  if (!env.CRON_SECRET || secret !== env.CRON_SECRET) return jsonResponse({ error: 'Unauthorized (비밀키 불일치)' }, 401);

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
      
      let newProgress = await createNewProgress(baseUrl);
      if (!newProgress) {
        console.warn('[cron] 인기 종목 수집 실패. 최신 거래대금 상위 종목(Fallback)으로 대체합니다.');
        newProgress = getFallbackProgress();
      }

      const staleTime = new Date(Date.now() - STALE_LOCK_MS).toISOString();
      const { data: locked, error } = await admin.from('auto_batch_progress')
        .update({ status: 'running', run_id: newProgress.run_id, started_at: newProgress.started_at, updated_at: new Date().toISOString(), payload: newProgress })
        .eq('id', 1)
        .or(`status.neq.running,updated_at.lt.${staleTime}`)
        .select();

      if (error || !locked || locked.length === 0) {
        return jsonResponse({ status: 'already_running' }, 200);
      }
      progress = newProgress;
    }

    await updateStatusBadge(admin, progress);

    waitUntil(processBatch(admin, baseUrl, env, progress).catch(async (err) => {
      console.error('[cron] processBatch fatal error:', err);
      progress.status = 'failed'; 
      progress.error = `배치 처리 중 오류: ${err.message.slice(0, 60)}`;
      await saveProgress(admin, progress); 
      await updateStatusBadge(admin, progress);
    }));

    return jsonResponse({ status: 'running', run_id: progress.run_id }, 200);
  } catch (e) {
    console.error('[cron] onRequest error:', e);
    try {
      const { data: existing } = await admin.from('app_cache').select('value').eq('key', 'auto_batch_status').maybeSingle();
      const prevSuccess = existing?.value?.last_success_at || null;
      
      await admin.from('app_cache').upsert({
        key: 'auto_batch_status',
        value: { status: 'failed', error: `시작 오류: ${e.message.slice(0, 60)}`, last_run_at: new Date().toISOString(), last_success_at: prevSuccess },
        updated_at: new Date().toISOString(), expires_at: CACHE_EXPIRES_AT
      });
    } catch (dbError) { 
      console.error('[cron] Failed to save error status:', dbError); 
    }
    return jsonResponse({ error: e.message }, 200); 
  }
}

async function createNewProgress(baseUrl) {
  try {
    const popRes = await fetchWithTimeout(`${baseUrl}/api/popular?exclude_preferred=1`, {}, 25000);
    if (!popRes.ok) return null;
    const popData = await popRes.json();
    const items = (popData.items || []).slice(0, TOTAL_ITEMS);
    if (items.length === 0) return null;

    return {
      run_id: crypto.randomUUID(), status: 'running', started_at: new Date().toISOString(),
      items: items.map(i => ({ ticker: i.ticker, name: i.name, rank: i.rank })),
      processed: 0, succeeded: 0, failed: 0, skipped: 0, results: [],
    };
  } catch (e) {
    console.error('[cron] createNewProgress failed:', e.message);
    return null;
  }
}

function getFallbackProgress() {
  const shuffled = [...FALLBACK_ITEMS].sort(() => Math.random() - 0.5).slice(0, TOTAL_ITEMS);
  return {
    run_id: crypto.randomUUID(), status: 'running', started_at: new Date().toISOString(),
    items: shuffled.map((item, idx) => ({ ...item, rank: idx + 1 })),
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
    else {
      progress.failed++;
      progress.error = `${stock.name} 분석 실패 (사유: ${result.reason || '알 수 없음'})`;
    }

    await saveProgress(admin, progress);
    await updateStatusBadge(admin, progress); 
    
    batchCount++;
    if (progress.processed < progress.items.length) await new Promise(r => setTimeout(r, 1000));
  }

  if (progress.processed < progress.items.length) {
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
      fetchWithTimeout(`${baseUrl}/api/quote?ticker=${encodeURIComponent(stock.ticker)}`, {}, 10000),
      fetchWithTimeout(`${baseUrl}/api/news?ticker=${encodeURIComponent(stock.name)}`, {}, 10000),
      fetchWithTimeout(`${baseUrl}/api/history?ticker=${encodeURIComponent(stock.ticker)}`, {}, 10000),
    ]);
    
    const qData = qRes.ok ? await qRes.json() : null;
    const hData = hRes.ok ? await hRes.json() : {};
    const nData = nRes.ok ? await nRes.json() : { items: [] };

    if (!qData?.price) return { ok: false, saved: false, fallback: false, reason: '시세 없음' };
    
    const historyAvailable = hData.data_available !== false;

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

    // ★ AI 분석 타임아웃 25초 -> 15초로 단축 (Cloudflare 30초 제한 회피)
    const aRes = await fetchWithTimeout(`${baseUrl}/api/analyze`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-cron-secret': env.CRON_SECRET }, body: JSON.stringify(payload),
    }, 15000);

    if (!aRes.ok) return { ok: false, saved: false, fallback: false, reason: `HTTP ${aRes.status}` };

    const result = await aRes.json();
    
    let reason = '정상 처리됨';
    if (!result.saved) {
      if (result.fallback) reason = result.fallback_reason || '폴백 판단';
      else reason = 'DB 저장 실패';
    }

    return { 
      ok: true, saved: !!result.saved, fallback: !!result.fallback, 
      fallback_reason: result.fallback_reason || null, data_quality: result.data_quality,
      reason
    };
  } catch (e) {
    const errMsg = e?.message || String(e);
    return { ok: false, saved: false, fallback: false, reason: errMsg.includes('초과') ? '시간 초과' : errMsg.slice(0, 30) };
  }
}

async function triggerContinue(baseUrl, env, admin, progress) {
  try {
    // 다음 배치 요청
    const res = await fetchWithTimeout(`${baseUrl}/api/cron`, {
      method: 'POST', headers: { 'x-cron-secret': env.CRON_SECRET, 'x-cron-continue': '1', 'x-run-id': progress.run_id },
    }, 15000);
    
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.status === 'ignored') return; 
    if (data.status === 'already_running' || data.status === 'running') return;
    throw new Error(`예상치 못한 응답 (${data.status})`);
  } catch (e) {
    console.warn('[cron] triggerContinue failed:', e.message);
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

function corsOk() { 
  return new Response(null, { 
    headers: { 
      'Access-Control-Allow-Origin': '*', 
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 
      'Access-Control-Allow-Headers': 'Content-Type, x-cron-secret, x-cron-continue, x-run-id' 
    } 
  }); 
}

function jsonResponse(body, status = 200) { 
  return new Response(JSON.stringify(body), { 
    status, 
    headers: { 'content-type': 'application/json; charset=utf-8' } 
  }); 
}