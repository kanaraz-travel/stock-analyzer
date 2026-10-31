// functions/api/cron-status.js
import { createClient } from '@supabase/supabase-js';

const STALE_RUNNING_MS = 5 * 60 * 1000; // 5분으로 연장

export async function onRequestGet(context) {
  const { env } = context;
  const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const { data } = await admin.from('app_cache').select('value').eq('key', 'auto_batch_status').maybeSingle();
  const status = data?.value || {};

  let finalStatus = status.status || 'idle';
  let finalError = status.error || null;

  if (finalStatus === 'running' && status.last_run_at) {
    const elapsed = Date.now() - new Date(status.last_run_at).getTime();
    if (elapsed > STALE_RUNNING_MS) {
      finalStatus = 'failed';
      finalError = '실행 중 응답이 5분 이상 없어 중단되었습니다. (시간 초과)';
    }
  }

  const now = new Date();
  const utcHour = now.getUTCHours();
  const nextHour = Math.ceil((utcHour + 1) / 3) * 3;
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), nextHour % 24, 0, 0));
  if (nextHour >= 24) next.setUTCDate(next.getUTCDate() + Math.floor(nextHour / 24));

  return new Response(JSON.stringify({
    status: finalStatus,
    last_run_at: status.last_run_at || null, last_success_at: status.last_success_at || null,
    total: status.total || 0, succeeded: status.succeeded || 0, failed: status.failed || 0, skipped: status.skipped || 0,
    run_id: status.run_id || null, next_run_at: next.toISOString(),
    error: finalError,
  }), { headers: { 'content-type': 'application/json' } });
}