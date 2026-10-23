// functions/api/popular.js
import { getKisAccessToken } from './_kis_token.js';

const NAVER_BASE = 'https://finance.naver.com/sise/lastsearch2.naver';
const NAVER_PAGES = 4; // 1~4페이지 순회 (최대 약 120개)
const MIN_REQUIRED = 20; // 최소 확보 종목 수

// ETF/ETN/ELW 제외 키워드
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

// 종목 코드가 6자리 숫자인지 확인 (ETN/ELW 차단)
function isValidTicker(ticker) {
  return /^\d{6}$/.test(String(ticker));
}

// ─────────────────────────────────────────────────────────────
// 1차: 네이버 금융 크롤링 (페이지네이션)
// ─────────────────────────────────────────────────────────────
async function fetchFromNaver() {
  const items = [];
  const seen = new Set();

  for (let page = 1; page <= NAVER_PAGES; page++) {
    if (items.length >= 100) break;

    const url = page === 1 ? NAVER_BASE : `${NAVER_BASE}?&page=${page}`;
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'ko-KR,ko;q=0.9',
          'Referer': 'https://finance.naver.com/',
        },
      });

      if (!res.ok) continue;

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
    } catch (e) {
      console.warn(`[popular] 네이버 page ${page} 실패:`, e.message);
    }
  }

  return items;
}

// ─────────────────────────────────────────────────────────────
// 2차 폴백: KIS API 거래량 순위 (부족분 보충)
// ─────────────────────────────────────────────────────────────
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
    FID_INPUT_CNT_1: '30',
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
    if (items.length >= 30) break;
  }

  return items;
}

// ─────────────────────────────────────────────────────────────
// 메인 핸들러
// ─────────────────────────────────────────────────────────────
export async function onRequestGet(context) {
  const { env } = context;
  let items = [];
  let source = 'naver_popular';

  // 1차: 네이버 크롤링
  try {
    items = await fetchFromNaver();
    if (items.length === 0) throw new Error('네이버에서 종목을 추출하지 못했습니다.');
  } catch (e) {
    console.warn('[popular] 네이버 실패 → KIS 폴백:', e.message);
    items = [];
  }

  // 2차: 20개 미만이면 KIS API로 보충
  if (items.length < MIN_REQUIRED) {
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

  // 최종 순위 재정렬
  items = items.map((item, idx) => ({ ...item, rank: idx + 1 }));

  if (items.length < MIN_REQUIRED) {
    return jsonResponse({
      error: `종목을 충분히 확보하지 못했습니다. (${items.length}개 / 최소 ${MIN_REQUIRED}개)`,
      error_code: 'INSUFFICIENT_ITEMS',
      items,
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