// functions/api/popular.js
import { getKisAccessToken } from './_kis_token.js';

const NAVER_MAIN = 'https://finance.naver.com/';
const NAVER_BASE = 'https://finance.naver.com/sise/lastsearch2.naver';
const NAVER_PAGES = 3;

// 다음 금융 조회 급등 API (price_performance)
const DAUM_BASE = 'https://finance.daum.net/api/trend/price_performance';
const DAUM_PARAMS = 'intervalType=TODAY&perPage=50&page=1';

const EXCLUDE_KEYWORDS = [
  'KODEX', 'TIGER', 'KBSTAR', 'ARIRANG', 'HANARO',
  'SOL', 'ACE', 'PLUS', 'RISE', 'KOSEF',
  'TIMEFOLIO', '히어로즈', '마이다스', '파워',
  '인버스', '레버리지', '선물', '합성', 'ETN', 'ELW'
];

function isExcluded(name) {
  const upper = String(name).toUpperCase();
  return EXCLUDE_KEYWORDS.some(k => upper.includes(k.toUpperCase()));
}

function isValidTicker(ticker) {
  return /^\d{6}$/.test(String(ticker));
}

function getHeaders(referer = '') {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
    'Sec-CH-UA': '"Chromium";v="125", "Google Chrome";v="125", "Not-A.Brand";v="99"',
    'Sec-CH-UA-Mobile': '?0',
    'Sec-CH-UA-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': referer ? 'same-origin' : 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    ...(referer ? { 'Referer': referer } : {})
  };
}

// 1차: 네이버 크롤링
async function fetchFromNaver() {
  const items = [];
  const seen = new Set();

  for (let page = 1; page <= NAVER_PAGES; page++) {
    if (items.length >= 80) break;
    const url = page === 1 ? NAVER_BASE : `${NAVER_BASE}?&page=${page}`;
    try {
      const res = await fetch(url, { headers: getHeaders(NAVER_MAIN) });
      if (!res.ok) continue;
      const buffer = await res.arrayBuffer();
      let html;
      try { html = new TextDecoder('euc-kr').decode(buffer); }
      catch { html = new TextDecoder('utf-8').decode(buffer); }

      const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
      let m;
      let pageAdded = 0;
      while ((m = rowRegex.exec(html)) !== null) {
        const rowHtml = m[1];
        const codeMatch = rowHtml.match(/code=(\d{6})/);
        if (!codeMatch) continue;
        const ticker = codeMatch[1];
        if (!isValidTicker(ticker) || seen.has(ticker)) continue;

        let name = '';
        const tltleMatch = rowHtml.match(/<a[^>]*class="tltle"[^>]*>([\s\S]*?)<\/a>/);
        if (tltleMatch) name = tltleMatch[1].replace(/<[^>]*>/g, '').trim();
        if (!name) continue;
        name = name.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
        if (isExcluded(name)) continue;

        seen.add(ticker);
        items.push({ ticker, name });
        pageAdded++;
        if (items.length >= 80) break;
      }

      if (pageAdded === 0 && page === 1) {
        console.warn('[popular] 네이버 첫 페이지에서 종목을 추출하지 못했습니다. 차단 가능성.');
        break;
      }

      await new Promise(r => setTimeout(r, 1000 + Math.random() * 1000));
    } catch (e) {
      console.warn(`[popular] 네이버 page ${page} 실패:`, e.message);
    }
  }
  return items;
}

// 2차: 다음 금융 조회 급등 (trend/price_performance)
async function fetchFromDaum() {
  const items = [];
  const seen = new Set();

  // KOSPI와 KOSDAQ 시장을 각각 조회
  const markets = ['KOSPI', 'KOSDAQ'];

  for (const market of markets) {
    if (items.length >= 50) break;
    const url = `${DAUM_BASE}?${DAUM_PARAMS}&market=${market}`;
    try {
      const res = await fetch(url, {
        headers: {
          ...getHeaders('https://finance.daum.net/'),
          'Accept': 'application/json, text/plain, */*',
        },
      });
      if (!res.ok) {
        console.warn(`[popular] 다음 금융 ${market} HTTP ${res.status}`);
        continue;
      }

      const json = await res.json();
      const list = json.data || json.ranks || json.list || (Array.isArray(json) ? json : []);
      if (!Array.isArray(list) || list.length === 0) {
        console.warn(`[popular] 다음 금융 ${market} 응답 비어있음`);
        continue;
      }

      const firstItem = list[0];
      if (!firstItem || (!firstItem.symbolCode && !firstItem.code && !firstItem.symbol)) {
        console.warn(`[popular] 다음 금융 ${market} 응답 스키마 불일치`);
        continue;
      }

      let addedInMarket = 0;
      for (const row of list) {
        const code = row.symbolCode || row.code || row.symbol || '';
        const ticker = String(code).replace(/^A/, '');
        if (!isValidTicker(ticker) || seen.has(ticker)) continue;

        const name = row.name || row.stockName || row.symbolName || '';
        if (!name || isExcluded(name)) continue;

        seen.add(ticker);
        items.push({ ticker, name });
        addedInMarket++;
        if (items.length >= 50) break;
      }
      console.log(`[popular] 다음 금융 ${market}: +${addedInMarket}건 (누적 ${items.length}건)`);

    } catch (e) {
      console.warn(`[popular] 다음 금융 ${market} 실패:`, e.message);
    }
  }
  return items;
}

// 3차: KIS API 거래량 순위 (필터 완화)
async function fetchFromKis(env, existingTickers) {
  const baseUrl = env.KIS_BASE_URL || 'https://openapi.koreainvestment.com:9443';
  if (!env.KIS_APP_KEY || !env.KIS_APP_SECRET) return [];

  const accessToken = await getKisAccessToken(env, baseUrl);
  const query = new URLSearchParams({
    FID_COND_MRKT_DIV_CODE: 'J',
    FID_COND_SCR_DIV_CODE: '20171',
    FID_INPUT_ISCD: '0000',
    FID_DIV_CLS_CODE: '0',
    FID_BLNG_CLS_CODE: '0',
    FID_TRGT_CLS_CODE: '111111111',
    FID_TRGT_EXLS_CLS_CODE: '000000',
    FID_INPUT_PRICE_1: '0',
    FID_INPUT_PRICE_2: '0',
    FID_VOL_CNT: '0',
    FID_INPUT_DATE_1: '0',
    FID_INPUT_CNT_1: '50',
  });

  const res = await fetch(`${baseUrl}/uapi/domestic-stock/v1/quotations/volume-rank?${query}`, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      authorization: `Bearer ${accessToken}`,
      appkey: env.KIS_APP_KEY,
      appsecret: env.KIS_APP_SECRET,
      tr_id: 'FHPST01710000',
    },
  });
  if (!res.ok) return [];

  const data = await res.json();
  if (data.rt_cd && data.rt_cd !== '0') return [];

  const items = [];
  for (const row of data.output || []) {
    const ticker = row.mksc_shrn_iscd;
    const name = row.hts_kor_isnm;
    if (!ticker || !name) continue;

    if (!isValidTicker(ticker) || existingTickers.has(ticker) || isExcluded(name)) continue;

    existingTickers.add(ticker);
    items.push({ ticker, name });
  }
  console.log(`[popular] KIS API: ${data.output?.length || 0}건 중 필터 통과 ${items.length}건`);
  return items;
}

// 메인 핸들러 (캐싱 적용)
export async function onRequestGet(context) {
  const { env, request } = context;
  const cache = caches.default;
  const cacheKey = new Request(request.url, request);
  const cachedResponse = await cache.match(cacheKey);

  if (cachedResponse) {
    const cachedData = await cachedResponse.json();
    return jsonResponse({ ...cachedData, source: `${cachedData.source} (cached)` });
  }

  let items = [];
  let source = 'none';
  const sourceStats = { naver: 0, daum: 0, kis: 0 };

  // 1차: 네이버
  try {
    items = await fetchFromNaver();
    sourceStats.naver = items.length;
    if (items.length > 0) source = 'naver_popular';
  } catch (e) {
    console.warn('[popular] 네이버 실패:', e.message);
  }

  // 2차: 다음 금융 (네이버가 20개 미만일 때)
  if (items.length < 20) {
    try {
      const existing = new Set(items.map(i => i.ticker));
      const daumItems = await fetchFromDaum();
      const newItems = daumItems.filter(i => !existing.has(i.ticker));
      sourceStats.daum = newItems.length;
      if (newItems.length > 0) {
        items = [...items, ...newItems];
        source = source === 'naver_popular' ? 'naver_plus_daum' : 'daum_rise';
      }
    } catch (e) {
      console.warn('[popular] 다음 금융 실패:', e.message);
    }
  }

  // 3차: KIS API (아직 20개 미만일 때)
  if (items.length < 20) {
    try {
      const existing = new Set(items.map(i => i.ticker));
      const kisItems = await fetchFromKis(env, existing);
      sourceStats.kis = kisItems.length;
      if (kisItems.length > 0) {
        items = [...items, ...kisItems];
        source = source === 'none' ? 'kis_volume_rank' : `${source}_plus_kis`;
      }
    } catch (e) {
      console.warn('[popular] KIS 폴백 실패:', e.message);
    }
  }

  items = items.map((item, idx) => ({ ...item, rank: idx + 1 }));

  console.log(`[popular] 최종 소스별 확보: 네이버=${sourceStats.naver}, 다음=${sourceStats.daum}, KIS=${sourceStats.kis}, 총=${items.length}`);

  if (items.length === 0) {
    return jsonResponse({ error: '모든 소스에서 종목을 확보하지 못했습니다.', error_code: 'EMPTY_RESULT' }, 502);
  }

  const responseBody = {
    items,
    total: items.length,
    source,
    source_stats: sourceStats,
    fetched_at: new Date().toISOString(),
  };

  const response = jsonResponse(responseBody);
  const cacheResponse = new Response(JSON.stringify(responseBody), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=300',
    },
  });
  context.waitUntil(cache.put(cacheKey, cacheResponse));

  return response;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}