// functions/api/popular.js
// GET /api/popular — 네이버 금융 인기 검색 종목 상위 100위 (코스피/코스닥, ETF 제외)

const NAVER_BASE = 'https://finance.naver.com/sise/lastsearch2.naver';
const NAVER_PAGES = 4;       // 약 30개 × 4 = 최대 120개 수집 → 100개로 컷
const MAX_ITEMS = 100;

// ETF 브랜드 키워드 (종목명 앞에 붙음). 포함 시 ETF로 판정
const ETF_BRANDS = [
  'KODEX', 'TIGER', 'KBSTAR', 'ARIRANG', 'HANARO',
  'SOL', 'ACE', 'PLUS', 'RISE', 'KOSEF',
  'TIMEFOLIO', '히어로즈', '마이다스', '파워',
];

function isEtf(name) {
  const upper = name.toUpperCase();
  return ETF_BRANDS.some(b => upper.includes(b.toUpperCase()));
}

function cleanName(raw) {
  return String(raw || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function parseRows(html, out, seen) {
  // <tr> 블록 단위로 파싱. code=숫자 6자리 링크가 있는 행만 유효.
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = rowRegex.exec(html)) !== null) {
    const rowHtml = m[1];
    const codeMatch = rowHtml.match(/code=(\d{6})/);
    if (!codeMatch) continue;

    const ticker = codeMatch[1];
    if (seen.has(ticker)) continue;

    const nameMatch = rowHtml.match(/<a[^>]*href="[^"]*code=\d{6}"[^>]*>([\s\S]*?)<\/a>/);
    if (!nameMatch) continue;

    const name = cleanName(nameMatch[1]);
    if (!name) continue;
    if (isEtf(name)) continue;

    seen.add(ticker);
    out.push({ rank: out.length + 1, ticker, name });
    if (out.length >= MAX_ITEMS) return;
  }
}

export async function onRequestGet(context) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml',
    'Accept-Language': 'ko-KR,ko;q=0.9',
    'Referer': 'https://finance.naver.com/',
  };

  const items = [];
  const seen = new Set();
  let etfExcluded = 0;
  let pagesFetched = 0;

  for (let page = 1; page <= NAVER_PAGES; page++) {
    if (items.length >= MAX_ITEMS) break;

    const url = page === 1 ? NAVER_BASE : `${NAVER_BASE}?&page=${page}`;
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) {
        console.warn(`[popular] page ${page} HTTP ${res.status}`);
        continue;
      }
      const buffer = await res.arrayBuffer();
      let html;
      try {
        html = new TextDecoder('euc-kr').decode(buffer);
      } catch (e) {
        // EUC-KR 미지원 환경 폴백 (드묾)
        html = new TextDecoder('utf-8').decode(buffer);
      }

      const before = items.length;
      parseRows(html, items, seen);
      // ETF 제외 카운트 (개략): 이번 페이지에서 code 있는데 items에 안 들어간 수
      const foundCodes = (html.match(/code=\d{6}/g) || []).length;
      const added = items.length - before;
      if (foundCodes > 0 && added < foundCodes) {
        etfExcluded += Math.max(0, foundCodes - added);
      }
      pagesFetched++;
    } catch (e) {
      console.warn(`[popular] page ${page} failed:`, e.message);
    }
  }

  const finalItems = items.slice(0, MAX_ITEMS);

  if (finalItems.length === 0) {
    return jsonResponse({
      error: '인기 종목을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.',
      error_code: 'POPULAR_FETCH_FAILED',
    }, 502);
  }

  return jsonResponse({
    items: finalItems,
    total: finalItems.length,
    pages_fetched: pagesFetched,
    etf_excluded_estimate: etfExcluded,
    source: 'naver_finance_popular',
    fetched_at: new Date().toISOString(),
  });
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