// functions/api/login.js
// POST /api/login
// Body: { name: '박필립' | '윤혜영' }

import { createClient } from '@supabase/supabase-js';

const ALLOWED_USERS = {
  '박필립': 'philip@kanaraz-travel.test',
  '윤혜영': 'hyeyoung@kanaraz-travel.test',
};

export async function onRequestPost(context) {
  const { request, env } = context;

  let body = {};
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: '잘못된 요청입니다.' }, 400);
  }

  const name = String(body.name || '').trim();
  if (!name) {
    return jsonResponse({ error: '이름을 선택해 주세요.' }, 400);
  }

  const email = ALLOWED_USERS[name];
  if (!email) {
    return jsonResponse({ error: '등록된 사용자가 아닙니다.' }, 400);
  }

  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('login: missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    return jsonResponse({ error: '서버 설정 오류입니다. 관리자에게 문의하세요.' }, 500);
  }

  try {
    const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
    });

    const { data, error } = await admin.auth.admin.generateLink({
      type: 'magiclink',
      email,
    });

    if (error) {
      console.error('generateLink error:', error.message);
      return jsonResponse(
        { error: '로그인 세션을 생성하지 못했습니다. 관리자에게 문의하세요.' },
        500
      );
    }

    const tokenHash = data?.properties?.hashed_token;
    if (!tokenHash) {
      console.error('generateLink: missing hashed_token', data);
      return jsonResponse({ error: '로그인 세션 생성에 실패했습니다.' }, 500);
    }

    return jsonResponse({
      email,
      token_hash: tokenHash,
      verification_type: 'magiclink',
    });
  } catch (err) {
    console.error('login unexpected error:', err?.message);
    return jsonResponse({ error: '로그인 처리 중 오류가 발생했습니다.' }, 500);
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}