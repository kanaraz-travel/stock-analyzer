import { createClient } from '@supabase/supabase-js';
import { verifyPassword } from './_auth.js';
const ALLOWED_USERS = { '박필립': 'philip@kanaraz-travel.test', '윤혜영': 'hyeyoung@kanaraz-travel.test' };
export async function onRequestPost(context) {
  const { request, env } = context;
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: '잘못된 요청입니다.' }, 400); }
  const name = String(body.name || '').trim();
  const password = String(body.password || '');
  if (!name) return jsonResponse({ error: '이름을 선택해 주세요.' }, 400);
  if (!password) return jsonResponse({ error: '비밀번호를 입력해 주세요.' }, 400);
  const email = ALLOWED_USERS[name];
  if (!email) return jsonResponse({ error: '등록된 사용자가 아닙니다.' }, 400);
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return jsonResponse({ error: '서버 설정 오류입니다.' }, 500);
  const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  const userId = await findUserIdByEmail(admin, email);
  if (!userId) return jsonResponse({ error: '등록된 사용자가 아닙니다.' }, 400);
  const { data: cred, error: credErr } = await admin.from('user_credentials').select('password_hash').eq('user_id', userId).maybeSingle();
  if (credErr) return jsonResponse({ error: '서버 오류가 발생했습니다.' }, 500);
  if (!cred) return jsonResponse({ error: '비밀번호가 설정되지 않았습니다. 관리자에게 문의하세요.' }, 403);
  const ok = await verifyPassword(password, cred.password_hash);
  if (!ok) { await new Promise(r => setTimeout(r, 400)); return jsonResponse({ error: '비밀번호가 일치하지 않습니다.' }, 401); }
  const { data, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
  if (error || !data?.properties?.hashed_token) return jsonResponse({ error: '로그인 세션을 생성하지 못했습니다.' }, 500);
  return jsonResponse({ email, token_hash: data.properties.hashed_token, verification_type: 'magiclink' });
}
async function findUserIdByEmail(admin, email) {
  const target = email.toLowerCase();
  for (let page = 1; page < 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const u = data.users.find(x => x.email?.toLowerCase() === target);
    if (u) return u.id;
    if (data.users.length < 1000) return null;
  }
  return null;
}
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}