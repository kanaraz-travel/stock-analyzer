import { createClient } from '@supabase/supabase-js';
import { hashPassword, verifyPassword } from './_auth.js';
export async function onRequestPost(context) {
  const { request, env } = context;
  const authHeader = request.headers.get('authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return jsonResponse({ error: '인증이 필요합니다.' }, 401);
  const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  const { data: userData, error: authError } = await admin.auth.getUser(token);
  if (authError || !userData?.user) return jsonResponse({ error: '인증이 유효하지 않습니다.' }, 401);
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: '잘못된 요청입니다.' }, 400); }
  const currentPassword = String(body.current_password || '');
  const newPassword = String(body.new_password || '');
  if (!currentPassword || !newPassword) return jsonResponse({ error: '모든 필드를 입력해 주세요.' }, 400);
  if (newPassword.length < 6) return jsonResponse({ error: '새 비밀번호는 6자 이상이어야 합니다.' }, 400);
  if (currentPassword === newPassword) return jsonResponse({ error: '새 비밀번호가 현재와 같습니다.' }, 400);
  const userId = userData.user.id;
  const { data: cred, error: credErr } = await admin.from('user_credentials').select('password_hash').eq('user_id', userId).maybeSingle();
  if (credErr) return jsonResponse({ error: '서버 오류가 발생했습니다.' }, 500);
  if (!cred) return jsonResponse({ error: '비밀번호가 설정되지 않았습니다.' }, 403);
  const ok = await verifyPassword(currentPassword, cred.password_hash);
  if (!ok) { await new Promise(r => setTimeout(r, 400)); return jsonResponse({ error: '현재 비밀번호가 일치하지 않습니다.' }, 401); }
  const newHash = await hashPassword(newPassword);
  const { error: upErr } = await admin.from('user_credentials').update({ password_hash: newHash, updated_at: new Date().toISOString() }).eq('user_id', userId);
  if (upErr) return jsonResponse({ error: '비밀번호 변경에 실패했습니다.' }, 500);
  return jsonResponse({ ok: true });
}
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}