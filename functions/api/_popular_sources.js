// functions/api/_popular_sources.js
import { getKisAccessToken } from './_kis_token.js';

// ★ 스팩(SPAC) 관련 키워드 추가 ('스팩', 'SPAC', '기업인수목적')
const EXCLUDE_KEYWORDS = [
  'KODEX', 'TIGER', 'KBSTAR', 'ARIRANG', 'HANARO', 'SOL', 'ACE', 'PLUS', 'RISE', 'KOSEF',
  'TIMEFOLIO', '히어로즈', '마이다스', '파워', '인버스', '레버리지', '선물', '합성', 'ETN', 'ELW',
  'UNICORN', '액티브', '밸류체인', '인덱스',
  '채권', '국채', '지방채', '특수채', '회사채', 'CP', '전단채', '수익증권',
  '리츠', '부동산투자회사', '인프라', '선박', '펀드', 'MMF',
  '스팩', 'SPAC', '기업인수목적'
];

export function isExcluded(name) {
  const upper = String(name).toUpperCase();
  return EXCLUDE_KEYWORDS.some(k => upper.includes(k.toUpperCase()));
}

export function isValidTicker(ticker) {
  return /^[0-9A-Z]{6}$/.test(String(ticker));
}

export function isPreferredStock(name) {
  if (!name || typeof name !== 'string') return false;
  const clean = name.replace(/\(.*?\)/g, '').trim();
  return /[0-9]*우[A-Za-z]?$/.test(clean);
}

function decodeHtmlEntities(str) {
  return String(str)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}

function getKstNow() { return new Date(Date.now() + 9 * 60 * 60 * 1000); }
function formatYmd(date) { return date.toISOString().slice(0, 10).replace(/-/g, ''); }
function ymdToUtcDate(ymd) { return new Date(Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8)))); }

function getCandidateStartDate() {
  const kst = getKstNow();
  const hhmm = kst.getUTCHours() * 100 + kst.getUTCMinutes();
  const date = new Date(Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate()));
  while (date.getUTCDay() === 0 || date.getUTCDay() === 6) date.setUTCDate(date.getUTCDate() - 1);
  if (hhmm < 900) {
    date.setUTCDate(date.getUTCDate() - 1);
    while (date.getUTCDay() === 0 || date.getUTCDay() === 6) date.setUTCDate(date.getUTCDate() - 1);
  }
  return formatYmd(date);
}

function prevWeekdayYmd(ymd) {
  const date = ymdToUtcDate(ymd);
  do { date.setUTCDate(date.getUTCDate() - 1); } while (date.getUTCDay() === 0 || date.getUTCDay() === 6);
  return formatYmd(date);
}

export let resolvedTradingDayCache = { ymd: null, resolvedAt: 0 };
const RESOLVED_CACHE_TTL_MS = 5 * 60 * 1000;

export async function fetchFromNaver() {
  try {
    const res = await fetch('https://finance.naver.com/sise/lastsearch2.naver', {
      headers: { 'User-Agent': 'stock-analyzer/1.0', 'Referer': 'https://finance.naver.com/' }
    });
    if (!res.ok) return [];
    const html = new TextDecoder('euc-kr').decode(await res.arrayBuffer());
    const items = [], seen = new Set();
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
      seen.add(ticker); items.push({ ticker, name });
      if (items.length >= 100) break;
    }
    return items;
  } catch { return []; }
}

export async function fetchFromDaum() {
  try {
    const res = await fetch('https://finance.daum.net/api/trend/price_performance?intervalType=TODAY&perPage=100&page=1', {
      headers: { 'User-Agent': 'stock-analyzer/1.0', 'Referer': 'https://finance.daum.net/' }
    });
    if (!res.ok) return [];
    const json = await res.json();
    const items = [], seen = new Set();
    for (const row of (json.data || [])) {
      const ticker = String(row.symbolCode || row.code || '').replace(/^A/, '');
      if (!isValidTicker(ticker) || seen.has(ticker)) continue;
      const name = row.name || '';
      if (!name) continue;
      seen.add(ticker); items.push({ ticker, name });
      if (items.length >= 100) break;
    }
    return items;
  } catch { return []; }
}

export async function fetchKisCandidates(env, limit = 100) {
  const baseUrl = env.KIS_BASE_URL || 'https://openapi.koreainvestment.com:9443';
  if (!env.KIS_APP_KEY || !env.KIS_APP_SECRET) return [];

  const now = Date.now();
  let startYmd = (resolvedTradingDayCache.ymd && (now - resolvedTradingDayCache.resolvedAt) < RESOLVED_CACHE_TTL_MS) 
    ? resolvedTradingDayCache.ymd : getCandidateStartDate();

  try {
    const accessToken = await getKisAccessToken(env, baseUrl);
    let currentYmd = startYmd;
    for (let attempt = 0; attempt < 7; attempt++) {
      const results = await tryFetchKisForDate(env, baseUrl, accessToken, currentYmd, limit);
      if (results.length > 0) {
        resolvedTradingDayCache = { ymd: currentYmd, resolvedAt: Date.now() };
        return results;
      }
      currentYmd = prevWeekdayYmd(currentYmd);
      await new Promise(r => setTimeout(r, 200));
    }
    return [];
  } catch (e) { return []; }
}

async function tryFetchKisForDate(env, baseUrl, accessToken, ymd, limit) {
  const results = [], seen = new Set();
  const addFromRows = (rows, tickerField) => {
    for (const row of rows || []) {
      const ticker = row[tickerField], name = row.hts_kor_isnm;
      if (!ticker || !name) continue;
      // ★ isExcluded에 스팩 키워드가 추가되어 여기서 자동으로 걸러집니다.
      if (!isValidTicker(ticker) || seen.has(ticker) || isExcluded(name) || isPreferredStock(name)) continue;
      const mkt = String(row.rprs_mrkt_kor_name || row.bstp_kor_isnm || '').toUpperCase();
      if (mkt && !/유가증권|코스피|코스닥|KOSPI|KOSDAQ/.test(mkt)) continue;
      seen.add(ticker); results.push({ ticker, name });
      if (results.length >= limit) break;
    }
  };

  const qVol = new URLSearchParams({ FID_COND_MRKT_DIV_CODE: 'J', FID_COND_SCR_DIV_CODE: '20171', FID_INPUT_ISCD: '0000', FID_DIV_CLS_CODE: '0', FID_BLNG_CLS_CODE: '0', FID_TRGT_CLS_CODE: '111111111', FID_TRGT_EXLS_CLS_CODE: '000000', FID_INPUT_PRICE_1: '0', FID_INPUT_PRICE_2: '0', FID_VOL_CNT: '0', FID_INPUT_DATE_1: ymd, FID_INPUT_CNT_1: '50' });
  const resVol = await fetch(`${baseUrl}/uapi/domestic-stock/v1/quotations/volume-rank?${qVol}`, {
    headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}`, appkey: env.KIS_APP_KEY, appsecret: env.KIS_APP_SECRET, tr_id: 'FHPST01710000' }
  });
  if (resVol.ok) { const data = await resVol.json(); if (data.rt_cd === '0') addFromRows(data.output, 'mksc_shrn_iscd'); }

  if (results.length < limit) {
    await new Promise(r => setTimeout(r, 200));
    const qChg = new URLSearchParams({ FID_COND_MRKT_DIV_CODE: 'J', FID_COND_SCR_DIV_CODE: '20170', FID_INPUT_ISCD: '0000', FID_DIV_CLS_CODE: '0', FID_BLNG_CLS_CODE: '0', FID_TRGT_CLS_CODE: '111111111', FID_TRGT_EXLS_CLS_CODE: '000000', FID_INPUT_PRICE_1: '0', FID_INPUT_PRICE_2: '0', FID_VOL_CNT: '0', FID_INPUT_DATE_1: ymd, FID_INPUT_CNT_1: '50' });
    const resChg = await fetch(`${baseUrl}/uapi/domestic-stock/v1/ranking/fluctuation?${qChg}`, {
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}`, appkey: env.KIS_APP_KEY, appsecret: env.KIS_APP_SECRET, tr_id: 'FHPST01700000' }
    });
    if (resChg.ok) { const data = await resChg.json(); if (data.rt_cd === '0') addFromRows(data.output, 'stck_shrn_iscd'); }
  }
  return results;
}

export async function fetchMarketCapRandom(env, neededCount) {
  const baseUrl = env.KIS_BASE_URL || 'https://openapi.koreainvestment.com:9443';
  if (!env.KIS_APP_KEY || !env.KIS_APP_SECRET) return [];

  const startYmd = resolvedTradingDayCache.ymd || getCandidateStartDate();
  try {
    const accessToken = await getKisAccessToken(env, baseUrl);
    const collected = [], seen = new Set();
    let trCont = '';

    for (let page = 0; page < 7; page++) {
      const q = new URLSearchParams({ FID_COND_MRKT_DIV_CODE: 'J', FID_COND_SCR_DIV_CODE: '20174', FID_INPUT_ISCD: '0000', FID_DIV_CLS_CODE: '1', FID_TRGT_CLS_CODE: '0', FID_TRGT_EXLS_CLS_CODE: '0', FID_INPUT_PRICE_1: '', FID_INPUT_PRICE_2: '', FID_VOL_CNT: '', FID_INPUT_DATE_1: startYmd });
      const res = await fetch(`${baseUrl}/uapi/domestic-stock/v1/ranking/market-cap?${q}`, {
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}`, appkey: env.KIS_APP_KEY, appsecret: env.KIS_APP_SECRET, tr_id: 'FHPST01740000', tr_cont: trCont },
      });
      if (!res.ok) break;
      const data = await res.json();
      if (data.rt_cd !== '0') break;

      for (const row of data.output || []) {
        const ticker = row.mksc_shrn_iscd, name = row.hts_kor_isnm;
        if (!ticker || !name) continue;
        if (!isValidTicker(ticker) || seen.has(ticker) || isExcluded(name) || isPreferredStock(name)) continue;
        seen.add(ticker); collected.push({ ticker, name });
      }
      if (collected.length >= 200) break;
      trCont = res.headers.get('tr_cont') || '';
      if (trCont !== 'F' && trCont !== 'M') break;
      await new Promise(r => setTimeout(r, 200));
    }
    return [...collected].sort(() => Math.random() - 0.5).slice(0, neededCount);
  } catch (e) { return []; }
}

export async function fetchIssueStocks(kisCandidates) {
  if (!kisCandidates || kisCandidates.length === 0) return [];
  try {
    const query = encodeURIComponent('특징주 OR 급등주 OR 상한가 when:7d');
    const res = await fetch(`https://news.google.com/rss/search?q=${query}&hl=ko&gl=KR&ceid=KR:ko`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 'Accept': 'application/rss+xml, application/xml, text/xml' }
    });
    if (!res.ok) return [];
    const xml = await res.text();
    const titles = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = itemRegex.exec(xml)) !== null) {
      const tm = m[1].match(/<title>(.*?)<\/title>/);
      if (tm) titles.push(decodeHtmlEntities(tm[1].replace(/<[^>]*>/g, '')));
    }
    const scoreMap = new Map();
    for (const stock of kisCandidates) {
      let cnt = 0;
      for (const title of titles) { if (title.includes(stock.name)) cnt++; }
      if (cnt > 0) scoreMap.set(stock.ticker, { ...stock, score: cnt });
    }
    return Array.from(scoreMap.values()).sort((a, b) => b.score - a.score).slice(0, 20);
  } catch (e) { return []; }
}