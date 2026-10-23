// functions/api/popular.js
import { getKisAccessToken } from './_kis_token.js';

const NAVER_URL = 'https://finance.naver.com/sise/lastsearch2.naver';
const MAX_ITEMS = 100;

// ETF 브랜드 필터 (KIS API 폴백 시 사용)
const ETF_BRANDS = [
  'KODEX', 'TIGER', 'KBSTAR', 'ARIRANG', 'HANARO',
  'SOL', 'ACE', 'PLUS', 'RISE', 'KOSEF',
  'TIMEFOLIO', '히어로즈', '마이다스', '파워',
];

function isEtf(name) {
  const upper = String(name).toUpperCase();
  return ETF_BRANDS.some(b => upper.includes(b.toUpperCase()));
}

// ─────────────────────────────────────────────────────────────
// 1차: 네이버 금융 인기 검색 종목 크롤링
// ─────────────────────────────────────────────────────────────
async function fetchFromNaver() {
  const res = await fetch(NAVER_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'ko-KR,ko;q=0.9',
      'Referer': 'https://finance.naver.com/',
    },
  });

  if (!res.ok) {
    throw new Error(`Naver HTTP ${res.status}`);
  }

  const buffer = await res.arrayBuffer();
  // 네이버 금융은 EUC-KR 인코딩
  let html;
  try {
    html = new TextDecoder('euc-kr').decode(buffer);
  } catch (e) {
    html = new TextDecoder('utf-8').decode(buffer);
  }

  const items = [];
  const seen = new Set();

  // <tr> 단위로 파싱
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = rowRegex.exec(html)) !== null) {
    const rowHtml = m[1];

    // 종목 코드 추출 (code=숫자 6자리)
    const codeMatch = rowHtml.match(/code=(\d{6})/);
    if (!codeMatch) continue;

    const ticker = codeMatch[1];
    if (seen.has(ticker)) continue;

    // 종목명 추출 (a.tltle 또는 a 태그 내부 텍스트)
    let name = '';
    const tltleMatch = rowHtml.match(/<a[^>]*class="tltle"[^>]*>([\s\S]*?)<\/a>/);
    if (tltleMatch) {
      name = tltleMatch[1].replace(/<[^>]*>/g, '').trim();
    } else {
      // class가 없는 경우 a 태그 전체에서 추출
      const aMatch = rowHtml.match(/<a[^>]*href="[^"]*code=\d{6}"[^>]*>([\s\S]*?)<\/a>/);
      if (aMatch) name = aMatch[1].replace(/<[^>]*>/g, '').trim();
    }

    if (!name) continue;

    // 특수문자 및 HTML 엔티티 정리
    name = name.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

    // ETF 제외 (네이버 페이지에서도 ETF가 섞여 있을 수 있음)
    if (isEtf(name)) continue;

    seen.add(ticker);
    items.push({ rank: items.length + 1, ticker, name });
    if (items.length >= MAX_ITEMS) break;
  }

  if (items.length === 0) {
    throw new Error('네이버 페이지에서 종목을 추출하지 못했습니다.');
  }

  return items;
}

// ─────────────────────────────────────────────────────────────
// 2차 폴백: KIS API 거래량 순위 조회
// ─────────────────────────────────────────────────────────────
async function fetchFromKis(env) {
  const baseUrl = env.KIS_BASE_URL || 'https://openapi.koreainvestment.com:9443';
  if (!env.KIS_APP_KEY || !env.KIS_APP_SECRET) {
    throw new Error('KIS API 키가 설정되지 않았습니다.');
  }

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

  if (!res.ok) {
    throw new Error(`KIS API HTTP ${res.status}`);
  }

  const data = await res.json();
  if (data.rt_cd && data.rt_cd !== '0') {
    throw new Error(`KIS API Error: ${data.msg1}`);
  }

  const items = [];
  for (const row of data.output || []) {
    const ticker = row.mksc_shrn_iscd;
    const name = row.hts_kor_isnm;
    const prdtType = row.prdt_type_cd;
    const marketName = row.rprs_mrkt_kor_name || row.bstp_kor_isnm || '';

    if (!ticker || !name) continue;
    if (isEtf(name)) continue;
    if (prdtType && prdtType !== '300') continue;

    const mName = String(marketName).toUpperCase();
    if (marketName && !mName.includes('유가증권') && !mName.includes('코스피') && !mName.includes('코스닥') && !mName.includes('KOSPI') && !mName.includes('KOSDAQ')) continue;

    items.push({ rank: items.length + 1, ticker, name });
    if (items.length >= MAX_ITEMS) break;
  }

  return items;
}

// ─────────────────────────────────────────────────────────────
// 메인 핸들러 (네이버 우선, 실패 시 KIS 폴백)
// ─────────────────────────────────────────────────────────────
export async function onRequestGet(context) {
  const { env } = context;

  // 1차: 네이버 금융 인기 검색 종목
  try {
    const items = await fetchFromNaver();
    return jsonResponse({
      items,
      total: items.length,
      source: 'naver_popular',
      fetched_at: new Date().toISOString(),
    });
  } catch (naverErr) {
    console.warn('[popular] 네이버 크롤링 실패 → KIS API 폴백:', naverErr.message);
  }

  // 2차: KIS API 거래량 순위 폴백
  try {
    const items = await fetchFromKis(env);
    if (items.length === 0) {
      return jsonResponse({ error: '조회된 인기 종목이 없습니다.', error_code: 'EMPTY_RESULT' }, 404);
    }
    return jsonResponse({
      items,
      total: items.length,
      source: 'kis_volume_rank_fallback',
      fetched_at: new Date().toISOString(),
    });
  } catch (kisErr) {
    console.error('[popular] KIS API 폴백도 실패:', kisErr.message);
    return jsonResponse({
      error: '인기 종목을 불러오지 못했습니다. (네이버 및 KIS API 모두 실패)',
      error_code: 'ALL_SOURCES_FAILED',
    }, 502);
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}