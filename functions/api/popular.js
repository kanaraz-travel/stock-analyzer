// functions/api/popular.js
import { getKisAccessToken } from './_kis_token.js';

const NAVER_MAIN = 'https://finance.naver.com/';
const NAVER_BASE = 'https://finance.naver.com/sise/lastsearch2.naver';
const NAVER_PAGES = 4;

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

// 실제 크롬 브라우저의 Client Hints 및 보안 헤더 모방
function getHeaders(cookie = '') {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
    'Referer': NAVER_MAIN,
    'Sec-CH-UA': '"Chromium";v="125", "Google Chrome";v="125", "Not-A.Brand";v="99"',
    'Sec-CH-UA-Mobile': '?0',
    'Sec-CH-UA-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    'Cache-Control': 'max-age=0',
    'Connection': 'keep-alive',
  };
  if (cookie) headers['Cookie'] = cookie;
  return headers;
}

// 네이버 메인 방문 후 쿠키 획득
async function getNaverCookies() {
  try {
    const res = await fetch(NAVER_MAIN, { headers: getHeaders() });
    const setCookie = res.headers.get('set-cookie');
    if (!setCookie) return '';
    // set-cookie 헤더에서 이름=값 형태만 추출
    return setCookie.split(',').map(c => c.split(';')[0].trim()).join('; ');
  } catch (e) {
    console.warn('[popular] 네이버 쿠키 획득 실패:', e.message);
    return '';
  }
}

// 네이버 금융 크롤링
async function fetchFromNaver(cookie) {
  const items = [];
  const seen = new Set();

  for (let page = 1; page <= NAVER_PAGES; page++) {
    if (items.length >= 100) break;

    const url = page === 1 ? NAVER_BASE : `${NAVER_BASE}?&page=${page}`;
    try {
      const res = await fetch(url, { headers: getHeaders(cookie) });

      if (!res.ok) {
        console.warn(`[popular] 네이버 page ${page} HTTP ${res.status}`);
        continue;
      }

      const buffer = await res.arrayBuffer();
      let html;
      try { html = new TextDecoder('euc-kr').decode(buffer); }
      catch { html = new TextDecoder('utf-8').decode(buffer); }

      const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
      let m;
      while ((m = rowRegex.exec(html)) !== null) {
        const rowHtml = m[1];
        const codeMatch = rowHtml.match(/code=(\d{6})/);
        if (!codeMatch) continue;

        const ticker = codeMatch[1];
        if (!isValidTicker(ticker)) continue;
        if (seen.has(ticker)) continue;

        let name = '';
        const tltleMatch = rowHtml.match(/<a[^>]*class="tltle"[^>]*>([\s\S]*?)<\/a>/);
        if (tltleMatch) name = tltleMatch[1].replace(/<[^>]*>/g, '').trim();
        else {
          const aMatch = rowHtml.match(/<a[^>]*href="[^"]*code=\d{6}"[^>]*>([\s\S]*?)<\/a>/);
          if (aMatch) name = aMatch[1].replace(/<[^>]*>/g, '').trim();
        }

        if (!name) continue;
        name = name.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

        if (isExcluded(name)) continue;

        seen.add(ticker);
        items.push({ rank: items.length + 1, ticker, name });
        if (items.length >= 100) break;
      }

      // 봇 탐지 회피를 위한 페이지 간 랜덤 지연 (1~3초)
      await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000));
    } catch (e) {
      console.warn(`[popular] 네이버 page ${page} 실패:`, e.message);
    }
  }

  return items;
}

// KIS API 거래량 순위 폴백 (기존과 동일)
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
    const prdtType = row.prdt_type_cd;
    const marketName = row.rprs_mrkt_kor_name || row.bstp_kor_isnm || '';

    if (!ticker || !name) continue;
    if (!isValidTicker(ticker)) continue;
    if (existingTickers.has(ticker)) continue;
    if (isExcluded(name)) continue;
    if (prdtType && prdtType !== '300') continue;

    const mName = String(marketName).toUpperCase();
    if (marketName && !mName.includes('유가증권') && !mName.includes('코스피') && !mName.includes('코스닥') && !mName.includes('KOSPI') && !mName.includes('KOSDAQ')) continue;

    existingTickers.add(ticker);
    items.push({ ticker, name });
  }

  return items;
}

export async function onRequestGet(context) {
  const { env } = context;
  let items = [];
  let source = 'naver_popular';

  // 1차: 네이버 크롤링 시도 (쿠키 획득 후)
  try {
    const cookie = await getNaverCookies();
    items = await fetchFromNaver(cookie);
    if (items.length === 0) throw new Error('네이버에서 종목을 추출하지 못했습니다.');
  } catch (e) {
    console.warn('[popular] 네이버 실패 → KIS 폴백:', e.message);
    items = [];
  }

  // 2차: KIS API 폴백 (종목 부족 시)
  if (items.length < 20) {
    try {
      const existing = new Set(items.map(i => i.ticker));
      const kisItems = await fetchFromKis(env, existing);
      if (kisItems.length > 0) {
        items = [...items, ...kisItems.map(i => ({ rank: 0, ticker: i.ticker, name: i.name }))];
        source = items.length > 0 ? 'naver_plus_kis' : 'kis_volume_rank_fallback';
      }
    } catch (kisErr) {
      console.error('[popular] KIS 폴백 실패:', kisErr.message);
    }
  }

  items = items.map((item, idx) => ({ ...item, rank: idx + 1 }));

  // 최종 확보된 종목이 없을 때만 에러 반환
  if (items.length === 0) {
    return jsonResponse({
      error: '인기 종목을 전혀 확보하지 못했습니다.',
      error_code: 'EMPTY_RESULT',
    }, 502);
  }

  return jsonResponse({
    items,
    total: items.length,
    source,
    fetched_at: new Date().toISOString(),
  });
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}