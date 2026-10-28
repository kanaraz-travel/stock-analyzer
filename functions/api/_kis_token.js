// functions/api/_kis_token.js
import { createClient } from '@supabase/supabase-js';

const CACHE_KEY = 'kis_access_token';
const SAFETY_MARGIN_MS = 5 * 60 * 1000;
const MIN_REFRESH_INTERVAL_MS = 60 * 1000;

let memCache = { accessToken: null, expiresAt: 0 };
let inflightPromise = null;
let lastFetchAttemptAt = 0;

export async function getKisAccessToken(env, baseUrl) {
  const now = Date.now();

  if (memCache.accessToken && now < memCache.expiresAt - SAFETY_MARGIN_MS) {
    return memCache.accessToken;
  }

  if (inflightPromise) return inflightPromise;

  if (now - lastFetchAttemptAt < MIN_REFRESH_INTERVAL_MS) {
    if (memCache.accessToken && now < memCache.expiresAt - SAFETY_MARGIN_MS) {
      return memCache.accessToken;
    }
    throw new Error('KIS 토큰 만료 임박: 잠시 후 재시도 필요');
  }

  inflightPromise = (async () => {
    try {
      const globalToken = await readGlobalCache(env);
      if (globalToken && now < globalToken.expiresAt - SAFETY_MARGIN_MS) {
        memCache = globalToken;
        return globalToken.accessToken;
      }

      lastFetchAttemptAt = Date.now();
      const fresh = await fetchNewToken(env, baseUrl);
      memCache = fresh;

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