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
    // ★ 종목코드 패턴 완화: 6자리 숫자 또는 영문자 포함 신형 코드(예: 0158S0) 허용
    const isDirectCode = /^[0-9A-Z]{6}$/i.test(query);

    if (!isDirectCode) {
      await ensureMasterLoaded();
      const foundCode = findCodeByName(query);
      if (!foundCode) return jsonResponse({ error: `'${query}'에 해당하는 종목을 찾을 수 없습니다.` }, 404);
      ticker = foundCode;
      stock_name = masterCache.codeMap.get(ticker) || query;
    }

    const accessToken = await getKisAccessToken(env, baseUrl);
    const kisQuery = new URLSearchParams({ FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: ticker });

    let kisRes;
    let lastError;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        kisRes = await fetch(`${baseUrl}/uapi/domestic-stock/v1/quotations/inquire-price?${kisQuery}`, {
          headers: {
            'content-type': 'application/json; charset=utf-8',
            authorization: `Bearer ${accessToken}`,
            appkey: env.KIS_APP_KEY,
            appsecret: env.KIS_APP_SECRET,
            tr_id: 'FHKST01010100',
          },
        });

        if (kisRes.status === 429 || kisRes.status === 502) {
          lastError = new Error(`KIS API ${kisRes.status} Error`);
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        break;
      } catch (err) {
        lastError = err;
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      }
    }

    if (!kisRes || !kisRes.ok) {
      return jsonResponse({ error: '시세를 가져오지 못했습니다.' }, 502);
    }

    let data;
    try { data = await kisRes.json(); } catch { return jsonResponse({ error: '시세 응답을 처리하지 못했습니다.' }, 502); }
    
    if (data.rt_cd && data.rt_cd !== '0') {
      return jsonResponse({ error: `시세 조회 실패: ${data.msg1 || '알 수 없는 오류'}` }, 502);
    }

    const output = data.output || {};
    let finalName = output.hts_kor_isnm || stock_name;
    if (/^[A-Z0-9]{10,}/.test(finalName)) finalName = finalName.replace(/^[A-Z0-9]{10,}\s*/, '').trim();

    const rawPrice = Number(output.stck_prpr);
    const price = (rawPrice && rawPrice > 0) ? rawPrice : null;
    const w52Hgpr = output.w52_hgpr ? Number(output.w52_hgpr) : null;
    const w52Lwpr = output.w52_lwpr ? Number(output.w52_lwpr) : null;

    return jsonResponse({
      ticker, stock_name: finalName,
      price: price,
      change_rate: output.prdy_ctrt ? Number(output.prdy_ctrt) : null,
      volume: output.acml_vol ? Number(output.acml_vol) : null,
      w52_hgpr: w52Hgpr,
      w52_lwpr: w52Lwpr,
      market_status: getMarketStatus(),
      quote_as_of: new Date().toISOString(),
      provider: '한국투자증권 Open API',
      data_status: 'LATEST',
    });
  } catch (err) {
    return jsonResponse({ error: '시세를 가져오지 못했습니다.' }, 502);
  }
}

// ------------------------------------------------------------
// 마스터 파일 로드: 파이프(|) 구분자 우선 시도, 실패 시 고정폭 파싱
// ------------------------------------------------------------
async function ensureMasterLoaded() {
  if (masterCache.loaded && Date.now() < masterCache.expiresAt) return;
  
  const markets = [
    { key: 'kospi', url: 'https://new.real.download.dws.co.kr/common/master/kospi_code.mst.zip', tailLen: 228 },
    { key: 'kosdaq', url: 'https://new.real.download.dws.co.kr/common/master/kosdaq_code.mst.zip', tailLen: 222 },
  ];
  
  masterCache.map.clear(); masterCache.codeMap.clear();
  
  for (const market of markets) {
    try {
      const res = await fetch(market.url);
      if (!res.ok) continue;
      const buf = await res.arrayBuffer();
      const unzipped = unzipSync(new Uint8Array(buf));
      
      for (const filename in unzipped) {
        const content = new TextDecoder('euc-kr').decode(unzipped[filename]);
        
        // ★ 1차: 파이프(|) 구분자 방식 시도
        const pipeResult = parsePipeSeparated(content);
        if (pipeResult > 0) {
          console.log(`[마스터] ${market.key}: 파이프 구분자 ${pipeResult}건 파싱 성공`);
          continue;
        }
        
        // ★ 2차: 고정폭 방식 (기존)
        const fixedResult = parseFixedWidth(content, market.tailLen);
        console.log(`[마스터] ${market.key}: 고정폭 ${fixedResult}건 파싱 성공`);
      }
    } catch (e) { console.error('Master file load error:', market.key, e.message); }
  }
  
  masterCache.loaded = true;
  masterCache.expiresAt = Date.now() + CACHE_TTL;
}

// ★ 파이프(|) 구분자 파싱: "단축코드|표준코드|한글종목명|..."
function parsePipeSeparated(text) {
  let count = 0;
  const lines = text.split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    const parts = line.split('|');
    if (parts.length < 3) continue;
    
    const code = parts[0].trim();
    const name = parts[2].trim();
    
    // 코드: 6자리 숫자 또는 영문자 포함 신형 코드
    if (!/^[0-9A-Z]{6}$/i.test(code)) continue;
    if (!name) continue;
    
    masterCache.map.set(name, code);
    masterCache.codeMap.set(code, name);
    count++;
  }
  return count;
}

// 고정폭 파싱 (기존 유지)
function parseFixedWidth(text, tailLen) {
  let count = 0;
  const lines = text.split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    if (line.length <= tailLen) continue;

    const head = line.substring(0, line.length - tailLen);
    const code = head.substring(0, 9).trim();
    if (!/^[0-9A-Z]{6}$/i.test(code)) continue;
    
    let name = head.substring(21).trim();
    if (!name) continue;
    name = name.replace(/[^\uAC00-\uD7A3a-zA-Z0-9\s().&-]/g, '').trim();
    if (!name) continue;

    masterCache.map.set(name, code);
    masterCache.codeMap.set(code, name);
    count++;
  }
  return count;
}

function findCodeByName(query) {
  const normalized = query.replace(/\s+/g, '').toLowerCase();
  
  // 1) 완전 일치
  for (const [name, code] of masterCache.map.entries()) {
    if (name.replace(/\s+/g, '').toLowerCase() === normalized) return code;
  }
  // 2) 쿼리가 종목명에 포함
  for (const [name, code] of masterCache.map.entries()) {
    if (name.replace(/\s+/g, '').toLowerCase().includes(normalized)) return code;
  }
  // 3) 종목명이 쿼리에 포함
  for (const [name, code] of masterCache.map.entries()) {
    if (normalized.includes(name.replace(/\s+/g, '').toLowerCase())) return code;
  }
  return null;
}

function getMarketStatus() {
  const now = new Date();
  const kstTime = new Date(now.getTime() + (9 * 60 * 60 * 1000));
  const day = kstTime.getUTCDay();
  const timeVal = kstTime.getUTCHours() * 100 + kstTime.getUTCMinutes();
  if (day === 0 || day === 6) return '휴장 (주말)';
  if (timeVal >= 900 && timeVal < 1530) return '정규장 09:00~15:30';
  if (timeVal >= 1530 && timeVal < 1600) return '장 마감 (대기)';
  if (timeVal >= 1600 && timeVal <= 2000) return '애프터마켓 16:00~20:00';
  return '장마감';
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