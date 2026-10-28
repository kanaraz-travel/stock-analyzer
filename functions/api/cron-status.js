import { createClient } from '@supabase/supabase-js';
const STALE_RUNNING_MS = 15 * 60 * 1000;
export async function onRequestGet(context) {
  const { env } = context;
  const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const { data } = await admin.from('app_cache').select('value, updated_at').eq('key', 'auto_batch_status').maybeSingle();
  const status = data?.value || {};
  let isStale = false;
  if (status.status === 'running' && status.last_run_at) {
    if ((Date.now() - new Date(status.last_run_at).getTime()) > STALE_RUNNING_MS) isStale = true;
  }
  const now = new Date();
  const utcHour = now.getUTCHours();
  const nextHour = Math.ceil((utcHour + 1) / 3) * 3;
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), nextHour % 24, 0, 0));
  if (nextHour >= 24) next.setUTCDate(next.getUTCDate() + Math.floor(nextHour / 24));
  return new Response(JSON.stringify({
    status: isStale ? 'stale' : (status.status || 'idle'),
    last_run_at: status.last_run_at || null, last_success_at: status.last_success_at || null,
    total: status.total || 0, succeeded: status.succeeded || 0, failed: status.failed || 0, skipped: status.skipped || 0,
    run_id: status.run_id || null, next_run_at: next.toISOString(),
  }), { headers: { 'content-type': 'application/json' } });
}