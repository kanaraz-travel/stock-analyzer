// functions/api/_kis_token.js
// KIS 접근 토큰의 통합 발급/캐시 모듈.
// 메모리 캐시(isolate 로컬) + Supabase 캐시(전역) 2단계로 동작.
// KIS는 24시간 유효한 토큰을 1분에 1회만 발급 가능하므로, 전역 캐시가 필수.

import { createClient } from '@supabase/supabase-js';

const CACHE_KEY = 'kis_access_token';
const SAFETY_MARGIN_MS = 5 * 60 * 1000;   // 만료 5분 전부터 갱신
const MIN_REFRESH_INTERVAL_MS = 60 * 1000; // KIS 1분 제한 준수

// ─── 메모리 캐시 (같은 isolate 내 재사용) ───
let memCache = { accessToken: null, expiresAt: 0 };
let inflightPromise = null;
let lastFetchAttemptAt = 0;

export async function getKisAccessToken(env, baseUrl) {
  const now = Date.now();

  // 1) 메모리 캐시 유효 → 즉시 반환
  if (memCache.accessToken && now < memCache.expiresAt - SAFETY_MARGIN_MS) {
    return memCache.accessToken;
  }

  // 2) 같은 isolate에서 이미 발급 중이면 대기
  if (inflightPromise) return inflightPromise;

  // 3) KIS 1분 제한 방어 (연속 발급 시도 방지)
  if (now - lastFetchAttemptAt < MIN_REFRESH_INTERVAL_MS && memCache.accessToken) {
    // 1분 안 지났지만 기존 토큰이 있으면 재사용 (만료 임박해도)
    return memCache.accessToken;
  }

  inflightPromise = (async () => {
    try {
      // 4) Supabase 전역 캐시 조회
      const globalToken = await readGlobalCache(env);
      if (globalToken && now < globalToken.expiresAt - SAFETY_MARGIN_MS) {
        memCache = globalToken;   // 메모리 캐시 승격
        return globalToken.accessToken;
      }

      // 5) KIS에서 신규 발급
      lastFetchAttemptAt = Date.now();
      const fresh = await fetchNewToken(env, baseUrl);
      memCache = fresh;

      // 6) Supabase에 저장 (다른 isolate가 재사용)
      await writeGlobalCache(env, fresh);

      return fresh.accessToken;
    } finally {
      inflightPromise = null;
    }
  })();

  return inflightPromise;
}

async function readGlobalCache(env) {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return null;
  try {
    const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { data, error } = await admin
      .from('app_cache')
      .select('value, expires_at')
      .eq('key', CACHE_KEY)
      .maybeSingle();

    if (error || !data) return null;
    const expiresAt = new Date(data.expires_at).getTime();
    if (isNaN(expiresAt)) return null;

    const value = data.value || {};
    if (!value.access_token) return null;
    return { accessToken: value.access_token, expiresAt };
  } catch (e) {
    console.warn('[kis_token] readGlobalCache failed:', e.message);
    return null;
  }
}

async function writeGlobalCache(env, tokenInfo) {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return;
  try {
    const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    await admin
      .from('app_cache')
      .upsert({
        key: CACHE_KEY,
        value: { access_token: tokenInfo.accessToken },
        expires_at: new Date(tokenInfo.expiresAt).toISOString(),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'key' });
  } catch (e) {
    console.warn('[kis_token] writeGlobalCache failed:', e.message);
  }
}

async function fetchNewToken(env, baseUrl) {
  const res = await fetch(`${baseUrl}/oauth2/tokenP`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      appkey: env.KIS_APP_KEY,
      appsecret: env.KIS_APP_SECRET,
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`KIS Token Error (${res.status}): ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  const expiresInSec = Number(data.expires_in) || 86400;
  return {
    accessToken: data.access_token,
    expiresAt: Date.now() + expiresInSec * 1000,
  };
}