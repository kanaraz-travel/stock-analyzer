// functions/api/cron-status.js
import { createClient } from '@supabase/supabase-js';

export async function onRequestGet(context) {
  const { env } = context;
  const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

  // 다음 실행 시간 계산 (3시간 간격, 00:00 UTC = 09:00 KST 기준)
  const now = new Date();
  const utcHours = now.getUTCHours();
  const nextRunHour = Math.ceil((utcHours + 1) / 3) * 3; 
  const nextRun = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), nextRunHour % 24, 0, 0));
  if (nextRunHour >= 24) nextRun.setUTCDate(nextRun.getUTCDate() + Math.floor(nextRunHour / 24));

  // 상태 조회
  const { data } = await admin.from('app_cache').select('value, updated_at').eq('key', 'auto_batch_status').maybeSingle();
  
  return new Response(JSON.stringify({
    status: data?.value?.status || 'idle',
    last_run_at: data?.value?.last_run_at || null,
    last_success_at: data?.value?.last_success_at || null,
    total: data?.value?.total || 0,
    succeeded: data?.value?.succeeded || 0,
    failed: data?.value?.failed || 0,
    skipped: data?.value?.skipped || 0, // ★ 스킵 카운트 반환
    next_run_at: nextRun.toISOString()
  }), { headers: { 'content-type': 'application/json' } });
}