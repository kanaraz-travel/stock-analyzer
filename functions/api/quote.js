// functions/api/quote.js
import { unzipSync } from 'fflate';
import { getKisAccessToken } from './_kis_token.js';

let masterCache = { loaded: false, map: new Map(), codeMap: new Map(), expiresAt: 0, retryAfter: 0 };
let masterPromise = null;
const CACHE_TTL = 24 * 60 * 60 * 1000;
const PARTIAL_RETRY_TTL = 5 * 60 * 1000;
const FAIL_RETRY_MS = 30 * 1000;

const EXCLUDE_KEYWORDS = [
  'KODEX', 'TIGER', 'KBSTAR', 'ARIRANG', 'HANARO', 'SOL', 'ACE', 'PLUS', 'RISE', 'KOSEF',
  'TIMEFOLIO', '히어로즈', '마이다스', '파워', '인버스', '레버리지', '선물', '합성', 'ETN', 'ELW',
  'UNICORN', '액티브', '밸류체인', '인덱스',
  '채권', '국채', '지방채', '특수채', '회사채', 'CP', '전단채', '수익증권',
  '리츠', '부동산투자회사', '인프라', '선박', '펀드', 'MMF'
];

function isExcluded(name) {
  const upper = String(name).toUpperCase();
  return EXCLUDE_KEYWORDS.some(k => upper.includes(k.toUpperCase()));
}

function isValidTicker(ticker) {
  return /^\d{6}$/.test(String(ticker));
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const query = (url.searchParams.get('ticker') || '').trim();

  if (!query) return jsonResponse({ error: '종목명 또는 코드를 입력해 주세요.' }, 400);
  if (query.length > 50) return jsonResponse({ error: '검색어가 너무 깁니다.' }, 400);

  const baseUrl = env.KIS_BASE_URL || 'https://openapi.koreainvestment.com:9443';
  if (!env.KIS_APP_KEY || !env.KIS_APP_SECRET) return jsonResponse({ error: 'KIS API 키가 설정되지 않았습니다.' }, 500);

  let ticker = query;
  let stock_name = query;

  try {
    const isDirectCode = isValidTicker(query);

    if (!isDirectCode) {
      await ensureMasterLoaded();
      if (masterCache.map.size === 0) {
        return jsonResponse({ error: '종목 목록을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.' }, 503);
      }
      
      const found = findCodeByName(query);
      if (!found) return jsonResponse({ error: `'${query}'에 해당하는 종목을 찾을 수 없습니다.` }, 404);
      
      if (found.candidates) {
        return jsonResponse({
          error: `'${query}'에 해당하는 종목이 여러 개입니다. 목록에서 선택해 주세요.`,
          candidates: found.candidates,
        }, 409);
      }
      
      ticker = found.code;
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
    const rawVolume = Number(output.acml_vol);
    const volume = (rawVolume && rawVolume > 0) ? rawVolume : null;

    const serverTime = new Date().toISOString();
    const marketStatus = getMarketStatus();
    const dataStatus = getDataStatus();

    const isAfterHoursQuote = dataStatus === 'AFTER_HOURS' || dataStatus === 'AFTER_MARKET' || dataStatus === 'MARKET_CLOSED';

    return jsonResponse({
      ticker, stock_name: finalName,
      price: price,
      change_rate: output.prdy_ctrt ? Number(output.prdy_ctrt) : null,
      volume: volume,
      w52_hgpr: w52Hgpr,
      w52_lwpr: w52Lwpr,
      market_status: marketStatus,
      server_time: serverTime,
      quote_as_of: null,
      quote_time_source: 'UNKNOWN',
      provider: '한국투자증권 Open API',
      data_status: dataStatus,
      is_after_hours_quote: isAfterHoursQuote,
      quote_note: isAfterHoursQuote
        ? (price != null ? '정규장 종가 기준 (시간외 시세는 별도 API 필요)' : '시간외 시세 미제공')
        : null,
    });
  } catch (err) {
    console.error('quote.js Error:', err.message);
    return jsonResponse({ error: '시세를 가져오지 못했습니다.' }, 502);
  }
}

async function ensureMasterLoaded() {
  const now = Date.now();
  if (masterCache.loaded && now < masterCache.expiresAt) return;
  if (now < masterCache.retryAfter) return;
  if (!masterPromise) masterPromise = loadMaster().finally(() => { masterPromise = null; });
  await masterPromise;
}

async function loadMaster() {
  const markets = [
    { key: 'kospi', url: 'https://new.real.download.dws.co.kr/common/master/kospi_code.mst.zip', tailLen: 228 },
    { key: 'kosdaq', url: 'https://new.real.download.dws.co.kr/common/master/kosdaq_code.mst.zip', tailLen: 222 },
  ];
  const nextMap = new Map();
  const nextCodeMap = new Map();
  let failed = false;

  for (const market of markets) {
    try {
      const res = await fetch(market.url);
      if (!res.ok) { console.error('Master file HTTP error:', market.key, res.status); failed = true; continue; }
      const buf = await res.arrayBuffer();
      const unzipped = unzipSync(new Uint8Array(buf));
      let marketCount = 0;
      for (const filename in unzipped) {
        const content = new TextDecoder('euc-kr').decode(unzipped[filename]);
        const pipeResult = parsePipeSeparated(content, nextMap, nextCodeMap);
        if (pipeResult > 0) { console.log(`[마스터] ${market.key}: 파이프 ${pipeResult}건`); marketCount += pipeResult; continue; }
        
        const fixedResult = parseFixedWidth(content, market.tailLen, nextMap, nextCodeMap);
        console.log(`[마스터] ${market.key}: 고정폭 ${fixedResult}건`);
        marketCount += fixedResult;
      }
      if (marketCount === 0) failed = true;
    } catch (e) { console.error('Master file load error:', market.key, e.message); failed = true; }
  }

  const now = Date.now();
  if (nextMap.size > 0 && (!failed || nextMap.size >= masterCache.map.size)) {
    masterCache.map = nextMap;
    masterCache.codeMap = nextCodeMap;
  }
  masterCache.loaded = masterCache.map.size > 0;
  if (!masterCache.loaded) {
    masterCache.retryAfter = now + FAIL_RETRY_MS;
    masterCache.expiresAt = 0;
  } else {
    masterCache.retryAfter = 0;
    masterCache.expiresAt = now + (failed ? PARTIAL_RETRY_TTL : CACHE_TTL);
  }
}

function parsePipeSeparated(text, map, codeMap) {
  let count = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('|');
    if (parts.length < 3) continue;
    const code = parts[0].trim();
    const name = parts[2].trim();
    
    if (!isValidTicker(code)) continue;
    if (!name || name.length > 50) continue;
    if (isExcluded(name)) continue;

    map.set(name, code);
    codeMap.set(code, name);
    count++;
  }
  return count;
}

// ★ 핵심 수정: substring 위치 기반 + 유연한 fallback 파싱
function parseFixedWidth(text, tailLen, map, codeMap) {
  let count = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    
    // 1. 앞부분에서 코드 추출 (KIS 마스터 파일은 앞 9자리에 코드가 위치)
    const code = line.substring(0, 9).trim();
    if (!isValidTicker(code)) continue; // 6자리 숫자가 아니면 스킵

    // 2. 종목명 추출 시도
    let name = '';
    
    // Case A: tailLen을 제외한 앞부분에서 21번째 문자부터 추출 (일반적인 경우)
    if (line.length > tailLen) {
      const head = line.substring(0, line.length - tailLen);
      if (head.length > 21) {
        name = head.substring(21).trim();
      }
    }
    
    // Case B: Case A가 실패했거나 비어있다면, 코드(9자리)와 ISIN(12자리)을 제외한 나머지에서 추출
    if (!name && line.length > 21) {
      name = line.substring(21).trim();
      // 만약 뒤에 부가정보가 붙어있다면, 첫 번째 공백 전까지만 취함
      const firstSpace = name.indexOf(' ');
      if (firstSpace > 0) name = name.substring(0, firstSpace);
    }

    if (!name || name.length > 50) continue;
    
    // 특수문자 제거
    name = name.replace(/[^\uAC00-\uD7A3a-zA-Z0-9\s().&-]/g, '').trim();
    if (!name) continue;
    if (isExcluded(name)) continue;

    map.set(name, code);
    codeMap.set(code, name);
    count++;
  }
  return count;
}

function findCodeByName(query) {
  const norm = (s) => String(s).replace(/\s+/g, '').toLowerCase();
  const q = norm(query);
  if (!q) return null;
  
  const partial = [];
  let exactMatch = null;

  for (const [name, code] of masterCache.map.entries()) {
    const n = norm(name);
    if (n === q) {
      exactMatch = { name, code };
      break;
    }
    if (n.includes(q)) partial.push({ name, code });
  }
  
  if (exactMatch) return { code: exactMatch.code };
  
  if (partial.length === 1) return { code: partial[0].code };
  
  if (partial.length > 1) {
    partial.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    const validCandidates = partial.filter(p => isValidTicker(p.code));
    if (validCandidates.length === 0) return null;
    if (validCandidates.length === 1) return { code: validCandidates[0].code };
    
    return { candidates: validCandidates.map((p) => `${p.name}(${p.code})`) };
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

function getDataStatus() {
  const now = new Date();
  const kstTime = new Date(now.getTime() + (9 * 60 * 60 * 1000));
  const day = kstTime.getUTCDay();
  const timeVal = kstTime.getUTCHours() * 100 + kstTime.getUTCMinutes();
  if (day === 0 || day === 6) return 'MARKET_CLOSED';
  if (timeVal >= 900 && timeVal < 1530) return 'MARKET_OPEN';
  if (timeVal >= 1530 && timeVal < 1600) return 'AFTER_HOURS';
  if (timeVal >= 1600 && timeVal <= 2000) return 'AFTER_MARKET';
  return 'MARKET_CLOSED';
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}