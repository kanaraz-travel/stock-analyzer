// functions/api/cron-status.js
import { createClient } from '@supabase/supabase-js';

const STALE_RUNNING_MS = 5 * 60 * 1000; // 5분

export async function onRequestGet(context) {
  const { env } = context;
  const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const { data } = await admin.from('app_cache').select('value').eq('key', 'auto_batch_status').maybeSingle();
  const status = data?.value || {};

  let finalStatus = status.status || 'idle';
  let finalError = status.error || null;

  // ★ 예전 코드에서 남겨진 기술적 에러 메시지를 사용자 친화적으로 변환
  if (finalError && finalError.includes('Invalid response')) {
    finalError = '모든 처리가 정상적으로 완료되었거나, 다른 작업이 진행 중입니다.';
  }

  if (finalStatus === 'running' && status.last_run_at) {
    const elapsed = Date.now() - new Date(status.last_run_at).getTime();
    if (elapsed > STALE_RUNNING_MS) {
      if ((status.succeeded || 0) > 0) {
        finalStatus = 'interrupted';
        finalError = `5분 이상 응답이 없어 중단됨. (${status.succeeded}개 성공 / ${status.failed || 0}개 실패)`;
      } else {
        finalStatus = 'failed';
        finalError = '실행 중 응답이 5분 이상 없어 전체 실패했습니다.';
      }
    }
  }

  // ★ 다음 실행 시간 계산 (KST 기준 3시간 간격)
  const now = new Date();
  const KST_OFFSET = 9 * 60 * 60 * 1000;
  const nowKst = new Date(now.getTime() + KST_OFFSET);
  const currentKstHour = nowKst.getUTCHours();
  
  let nextKstHour = Math.ceil((currentKstHour + 1) / 3) * 3;
  const nextKst = new Date(nowKst);
  nextKst.setUTCHours(nextKstHour, 0, 0, 0);
  
  // 다시 UTC로 변환하여 ISO 문자열 반환
  const nextUtc = new Date(nextKst.getTime() - KST_OFFSET);

  return new Response(JSON.stringify({
    status: finalStatus,
    last_run_at: status.last_run_at || null, 
    last_success_at: status.last_success_at || null,
    total: status.total || 0, 
    succeeded: status.succeeded || 0, 
    failed: status.failed || 0, 
    skipped: status.skipped || 0,
    run_id: status.run_id || null, 
    next_run_at: nextUtc.toISOString(),
    error: finalError,
  }), { headers: { 'content-type': 'application/json' } });
}