// functions/api/popular.js
import { getKisAccessToken } from './_kis_token.js';

const EXCLUDE_KEYWORDS = [
  'KODEX', 'TIGER', 'KBSTAR', 'ARIRANG', 'HANARO', 'SOL', 'ACE', 'PLUS', 'RISE', 'KOSEF',
  'TIMEFOLIO', '히어로즈', '마이다스', '파워', '인버스', '레버리지', '선물', '합성', 'ETN', 'ELW'
];
function isExcluded(name) {
  const upper = String(name).toUpperCase();
  return EXCLUDE_KEYWORDS.some(k => upper.includes(k.toUpperCase()));
}
function isValidTicker(ticker) {
  return /^\d{6}$/.test(String(ticker));
}

// ★ 각 소스 결과에서 "상위 10 + 11~100위 랜덤 10" = 20개를 확정
function pickTopAndRandom(sourceItems) {
  const valid = sourceItems.filter(i => isValidTicker(i.ticker) && !isExcluded(i.name));
  if (valid.length === 0) return [];

  const topN = valid.slice(0, 10);
  const pool = valid.slice(10, 100);
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  const randomN = shuffled.slice(0, 10);

  return [...topN, ...randomN];
}

// 1순위: 네이버 인기 검색 종목 (최대 100개 원본 수집)
async function fetchFromNaver() {
  try {
    const res = await fetch('https://finance.naver.com/sise/lastsearch2.naver', {
      headers: { 'User-Agent': 'stock-analyzer/1.0', 'Referer': 'https://finance.naver.com/' }
    });
    if (!res.ok) return [];
    const html = new TextDecoder('euc-kr').decode(await res.arrayBuffer());
    const items = [];
    const seen = new Set();
    const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
    let m;
    while ((m = rowRegex.exec(html)) !== null) {
      const codeMatch = m[1].match(/code=(\d{6})/);
      if (!codeMatch) continue;
      const ticker = codeMatch[1];
      if (seen.has(ticker)) continue;
      const nameMatch = m[1].match(/<a[^>]*class="tltle"[^>]*>([\s\S]*?)<\/a>/);
      if (!nameMatch) continue;
      const name = nameMatch[1].replace(/<[^>]*>/g, '').trim();
      if (!name) continue;
      seen.add(ticker);
      items.push({ ticker, name });
      if (items.length >= 100) break;
    }
    return items;
  } catch { return []; }
}

// 2순위: 다음 금융 조회 급등 (최대 100개 원본 수집)
async function fetchFromDaum() {
  try {
    const res = await fetch('https://finance.daum.net/api/trend/price_performance?intervalType=TODAY&perPage=100&page=1', {
      headers: { 'User-Agent': 'stock-analyzer/1.0', 'Referer': 'https://finance.daum.net/' }
    });
    if (!res.ok) return [];
    const json = await res.json();
    const list = json.data || [];
    const items = [];
    const seen = new Set();
    for (const row of list) {
      const ticker = String(row.symbolCode || row.code || '').replace(/^A/, '');
      if (!isValidTicker(ticker) || seen.has(ticker)) continue;
      const name = row.name || '';
      if (!name) continue;
      seen.add(ticker);
      items.push({ ticker, name });
      if (items.length >= 100) break;
    }
    return items;
  } catch { return []; }
}

// ★ 4순위 후보: KIS 거래량+등락률 (코스피/코스닥 시장 필터)
async function fetchKisCandidates(env, limit = 100) {
  const baseUrl = env.KIS_BASE_URL || 'https://openapi.koreainvestment.com:9443';
  if (!env.KIS_APP_KEY || !env.KIS_APP_SECRET) return [];
  try {
    const accessToken = await getKisAccessToken(env, baseUrl);
    const results = [];
    const seen = new Set();

    const addFromRows = (rows, tickerField) => {
      for (const row of rows || []) {
        const ticker = row[tickerField];
        const name = row.hts_kor_isnm;
        if (!ticker || !name) continue;
        if (!isValidTicker(ticker) || seen.has(ticker) || isExcluded(name)) continue;

        // ★ 시장 구분 필터: 코스피/코스닥만
        const mkt = String(row.rprs_mrkt_kor_name || row.bstp_kor_isnm || '').toUpperCase();
        const isKospiKosdaq = /유가증권|코스피|코스닥|KOSPI|KOSDAQ/.test(mkt);
        // 시장 정보가 아예 없는 경우는 허용(구형 응답 대비)
        if (mkt && !isKospiKosdaq) continue;

        seen.add(ticker);
        results.push({ ticker, name });
        if (results.length >= limit) break;
      }
    };

    // 거래량 순위
    const qVol = new URLSearchParams({
      FID_COND_MRKT_DIV_CODE: 'J', FID_COND_SCR_DIV_CODE: '20171',
      FID_INPUT_ISCD: '0000', FID_DIV_CLS_CODE: '0', FID_BLNG_CLS_CODE: '0',
      FID_TRGT_CLS_CODE: '111111111', FID_TRGT_EXLS_CLS_CODE: '000000',
      FID_INPUT_PRICE_1: '0', FID_INPUT_PRICE_2: '0', FID_VOL_CNT: '0',
      FID_INPUT_DATE_1: '0', FID_INPUT_CNT_1: '50'
    });
    const resVol = await fetch(`${baseUrl}/uapi/domestic-stock/v1/quotations/volume-rank?${qVol}`, {
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}`, appkey: env.KIS_APP_KEY, appsecret: env.KIS_APP_SECRET, tr_id: 'FHPST01710000' }
    });
    if (resVol.ok) {
      const data = await resVol.json();
      addFromRows(data.output, 'mksc_shrn_iscd');
    }

    // 등락률 순위 (보충)
    if (results.length < limit) {
      await new Promise(r => setTimeout(r, 200));
      const qChg = new URLSearchParams({
        FID_COND_MRKT_DIV_CODE: 'J', FID_COND_SCR_DIV_CODE: '20170',
        FID_INPUT_ISCD: '0000', FID_DIV_CLS_CODE: '0', FID_BLNG_CLS_CODE: '0',
        FID_TRGT_CLS_CODE: '111111111', FID_TRGT_EXLS_CLS_CODE: '000000',
        FID_INPUT_PRICE_1: '0', FID_INPUT_PRICE_2: '0', FID_VOL_CNT: '0', FID_INPUT_DATE_1: '0', FID_INPUT_CNT_1: '50'
      });
      const resChg = await fetch(`${baseUrl}/uapi/domestic-stock/v1/ranking/fluctuation?${qChg}`, {
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}`, appkey: env.KIS_APP_KEY, appsecret: env.KIS_APP_SECRET, tr_id: 'FHPST01700000' }
      });
      if (resChg.ok) {
        const data = await resChg.json();
        addFromRows(data.output, 'stck_shrn_iscd');
      }
    }

    return results;
  } catch (e) {
    console.warn('[popular] KIS 후보 실패:', e.message);
    return [];
  }
}

// 3순위: 뉴스 이슈 점수 기반 (최대 20개)
async function fetchIssueStocks(kisCandidates) {
  try {
    const query = encodeURIComponent('특징주 OR 급등주 OR 상한가');
    const res = await fetch(`https://news.google.com/rss/search?q=${query}&hl=ko&gl=KR&ceid=KR:ko`, {
      headers: { 'User-Agent': 'stock-analyzer/1.0' }
    });
    if (!res.ok) return [];
    const xml = await res.text();
    const titles = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = itemRegex.exec(xml)) !== null) {
      const tm = m[1].match(/<title>(.*?)<\/title>/);
      if (tm) titles.push(tm[1].replace(/<[^>]*>/g, ''));
    }

    const scoreMap = new Map();
    for (const stock of kisCandidates) {
      let cnt = 0;
      for (const title of titles) {
        if (title.includes(stock.name)) cnt++;
      }
      if (cnt > 0) scoreMap.set(stock.ticker, { ...stock, score: cnt });
    }
    return Array.from(scoreMap.values()).sort((a, b) => b.score - a.score).slice(0, 20);
  } catch (e) {
    console.warn('[popular] 이슈 종목 실패:', e.message);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────
// 메인 핸들러: 요청하신 4단계 소스 우선순위 + 소스별 20개 확정
// ─────────────────────────────────────────────────────────────
export async function onRequestGet(context) {
  const { env } = context;
  const sourceStats = { naver: 0, daum: 0, issue: 0, kis: 0 };
  let selected = [];
  let source = 'none';

  // ★ 1순위: 네이버 (성공 시 20개 확정)
  if (selected.length < 20) {
    const naverRaw = await fetchFromNaver();
    const naverPicked = pickTopAndRandom(naverRaw);
    const newItems = naverPicked.filter(d => !selected.find(i => i.ticker === d.ticker));
    selected = [...selected, ...newItems].slice(0, 20);
    sourceStats.naver = newItems.length;
    if (selected.length > 0 && source === 'none') source = 'naver';
  }

  // ★ 2순위: 다음 (부족분만. 네이버가 20개 채웠으면 스킵)
  if (selected.length < 20) {
    const daumRaw = await fetchFromDaum();
    const daumPicked = pickTopAndRandom(daumRaw);
    const newItems = daumPicked.filter(d => !selected.find(i => i.ticker === d.ticker));
    selected = [...selected, ...newItems].slice(0, 20);
    sourceStats.daum = newItems.length;
    if (selected.length > 0 && source === 'none') source = 'daum';
  }

  // ★ 3순위: 이슈 종목 (부족분만)
  let kisCandidates = [];
  if (selected.length < 20) {
    kisCandidates = await fetchKisCandidates(env, 100);
    const issuePicked = await fetchIssueStocks(kisCandidates);
    const newItems = issuePicked.filter(d => !selected.find(i => i.ticker === d.ticker));
    selected = [...selected, ...newItems].slice(0, 20);
    sourceStats.issue = newItems.length;
    if (selected.length > 0 && source === 'none') source = 'issue';
  }

  // ★ 4순위: KIS 보충 (부족분만, 코스피/코스닥 필터 적용됨)
  if (selected.length < 20) {
    if (kisCandidates.length === 0) kisCandidates = await fetchKisCandidates(env, 100);
    const newItems = kisCandidates.filter(d => !selected.find(i => i.ticker === d.ticker));
    const remaining = 20 - selected.length;
    const kisFill = newItems.slice(0, remaining);
    selected = [...selected, ...kisFill];
    sourceStats.kis = kisFill.length;
    if (selected.length > 0 && source === 'none') source = 'kis';
  }

  const items = selected.slice(0, 20).map((item, idx) => ({ ...item, rank: idx + 1 }));

  if (items.length === 0) {
    return new Response(JSON.stringify({ error: '모든 소스 실패', error_code: 'EMPTY_RESULT', source_stats: sourceStats }), {
      status: 502, headers: { 'content-type': 'application/json' }
    });
  }

  return new Response(JSON.stringify({
    items,
    total: items.length,
    source,
    source_stats: sourceStats,
    fetched_at: new Date().toISOString(),
  }), { headers: { 'content-type': 'application/json; charset=utf-8' } });
}