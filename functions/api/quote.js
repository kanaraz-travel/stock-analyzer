// functions/api/quote.js
import { unzipSync } from 'fflate';

let masterCache = { loaded: false, map: new Map(), codeMap: new Map(), expiresAt: 0 };
const CACHE_TTL = 24 * 60 * 60 * 1000;
let tokenCache = { accessToken: null, expiresAt: 0 };
let tokenPromise = null;

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  let query = (url.searchParams.get('ticker') || '').trim();

  if (!query) return jsonResponse({ error: '종목명 또는 코드를 입력해 주세요.' }, 400);

  const baseUrl = env.KIS_BASE_URL || 'https://openapi.koreainvestment.com:9443';
  if (!env.KIS_APP_KEY || !env.KIS_APP_SECRET) return jsonResponse({ error: 'KIS API 키가 설정되지 않았습니다.' }, 500);

  let ticker = query;
  let stock_name = query;

  try {
    if (!/^\d{6}$/.test(query)) {
      await ensureMasterLoaded();
      const foundCode = findCodeByName(query);
      if (!foundCode) return jsonResponse({ error: `'${query}'에 해당하는 종목을 찾을 수 없습니다.` }, 404);
      ticker = foundCode;
      stock_name = masterCache.codeMap.get(ticker) || query;
    }

    const accessToken = await getKisAccessToken(env, baseUrl);
    const kisQuery = new URLSearchParams({ FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: ticker });

    let kisRes = await fetch(`${baseUrl}/uapi/domestic-stock/v1/quotations/inquire-price?${kisQuery}`, {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        authorization: `Bearer ${accessToken}`,
        appkey: env.KIS_APP_KEY,
        appsecret: env.KIS_APP_SECRET,
        tr_id: 'FHKST01010100',
      },
    });

    // 429(Too Many Requests) 발생 시 1회 재시도
    if (kisRes.status === 429) {
      console.warn('KIS API Rate Limit (429), retrying after 1s...');
      await new Promise(r => setTimeout(r, 1000));
      kisRes = await fetch(`${baseUrl}/uapi/domestic-stock/v1/quotations/inquire-price?${kisQuery}`, {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          authorization: `Bearer ${accessToken}`,
          appkey: env.KIS_APP_KEY,
          appsecret: env.KIS_APP_SECRET,
          tr_id: 'FHKST01010100',
        },
      });
    }

    if (!kisRes.ok) {
      console.error('KIS API Error:', kisRes.status, await kisRes.text());
      return jsonResponse({ error: '시세를 가져오지 못했습니다. 잠시 후 다시 확인해 주세요.' }, 502);
    }

    let data;
    try { data = await kisRes.json(); } catch { return jsonResponse({ error: '시세 응답을 처리하지 못했습니다.' }, 502); }
    const output = data.output || {};

    let finalName = output.hts_kor_isnm || stock_name;
    if (/^[A-Z0-9]{10,}/.test(finalName)) finalName = finalName.replace(/^[A-Z0-9]{10,}\s*/, '').trim();

    // 데이터 지연 여부 판단 (응답 시각과 현재 시각 차이가 60초 이상이면 지연)
    const now = new Date();
    const quoteTime = new Date(); // 실제 응답 시각 (KIS 응답 필드가 있으면 해당 값 사용)
    const diffSeconds = (now - quoteTime) / 1000;
    const dataStatus = diffSeconds > 60 ? 'DELAYED' : 'LATEST';

    return jsonResponse({
      ticker, stock_name: finalName,
      price: output.stck_prpr ? Number(output.stck_prpr) : null,
      change_rate: output.prdy_ctrt ? Number(output.prdy_ctrt) : null,
      volume: output.acml_vol ? Number(output.acml_vol) : null,
      market_status: getMarketStatus(),
      quote_as_of: now.toISOString(),
      provider: '한국투자증권 Open API',
      data_status: dataStatus,
    });
  } catch (err) {
    console.error('quote.js Error:', err.message);
    return jsonResponse({ error: '시세를 가져오지 못했습니다. 잠시 후 다시 확인해 주세요.' }, 502);
  }
}

async function ensureMasterLoaded() {
  if (masterCache.loaded && Date.now() < masterCache.expiresAt) return;
  const urls = ['https://new.real.download.dws.co.kr/common/master/kospi_code.mst.zip', 'https://new.real.download.dws.co.kr/common/master/kosdaq_code.mst.zip'];
  masterCache.map.clear(); masterCache.codeMap.clear();
  for (const url of urls) {
    try {
      const res = await fetch(url); if (!res.ok) continue;
      const buf = await res.arrayBuffer(); const unzipped = unzipSync(new Uint8Array(buf));
      for (const filename in unzipped) { parseMasterFile(new TextDecoder('euc-kr').decode(unzipped[filename])); }
    } catch (e) { console.error('Master file load error:', e.message); }
  }
  masterCache.loaded = true; masterCache.expiresAt = Date.now() + CACHE_TTL;
}

function parseMasterFile(text) {
  const lines = text.split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    const code = line.substring(0, 6).trim();
    if (!/^\d{6}$/.test(code)) continue;
    let name = '';
    for (let start = 9; start < 30; start++) {
      const candidate = line.substring(start, start + 20).trim();
      if (/[가-힣]/.test(candidate)) { name = candidate.split(/\s{2,}/)[0].trim(); break; }
    }
    if (name) { masterCache.map.set(name, code); masterCache.codeMap.set(code, name); }
  }
}

function findCodeByName(query) {
  const normalized = query.replace(/\s+/g, '').toLowerCase();
  for (const [name, code] of masterCache.map.entries()) {
    if (name.replace(/\s+/g, '').toLowerCase() === normalized) return code;
  }
  for (const [name, code] of masterCache.map.entries()) {
    if (name.replace(/\s+/g, '').toLowerCase().includes(normalized)) return code;
  }
  return null;
}

// 한국 시간(KST) 기준 시장 상태 계산 (UTC+9)
function getMarketStatus() {
  const now = new Date();
  const kstTime = new Date(now.getTime() + (9 * 60 * 60 * 1000)); // UTC + 9시간
  const day = kstTime.getUTCDay();
  const hours = kstTime.getUTCHours();
  const minutes = kstTime.getUTCMinutes();
  const timeVal = hours * 100 + minutes;

  if (day === 0 || day === 6) return '휴장 (주말)';
  if (timeVal >= 900 && timeVal <= 1530) return '장중';
  if (timeVal > 1530 && timeVal <= 1800) return '시간외 단일가';
  if (timeVal > 1800) return '장마감';
  return '장 개시 전';
}

async function getKisAccessToken(env, baseUrl) {
  const now = Date.now();
  if (tokenCache.accessToken && now < tokenCache.expiresAt) return tokenCache.accessToken;
  if (tokenPromise) return tokenPromise;

  tokenPromise = (async () => {
    try {
      const res = await fetch(`${baseUrl}/oauth2/tokenP`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ grant_type: 'client_credentials', appkey: env.KIS_APP_KEY, appsecret: env.KIS_APP_SECRET }),
      });
      if (!res.ok) throw new Error(`KIS Token Error (${res.status})`);
      const data = await res.json();
      tokenCache = { accessToken: data.access_token, expiresAt: now + ((Number(data.expires_in) || 86400) - 60) * 1000 };
      return data.access_token;
    } finally {
      tokenPromise = null;
    }
  })();
  return tokenPromise;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}