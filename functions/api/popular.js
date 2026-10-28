// functions/api/popular.js
import {
  fetchFromNaver, fetchFromDaum, fetchKisCandidates, fetchMarketCapRandom,
  fetchIssueStocks, isValidTicker, isExcluded, resolvedTradingDayCache
} from './_popular_sources.js';

function pickTopAndRandom(sourceItems) {
  const valid = sourceItems.filter(i => isValidTicker(i.ticker) && !isExcluded(i.name));
  if (valid.length === 0) return [];
  const topN = valid.slice(0, 10);
  const pool = valid.slice(10, 100);
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  return [...topN, ...shuffled.slice(0, 10)];
}

export async function onRequestGet(context) {
  const { env } = context;
  const sourceStats = { naver: 0, daum: 0, issue: 0, kis: 0, cap: 0 };
  let selected = [];
  let source = 'none';

  // 1순위: 네이버
  if (selected.length < 20) {
    const naverPicked = pickTopAndRandom(await fetchFromNaver());
    const newItems = naverPicked.filter(d => !selected.find(i => i.ticker === d.ticker));
    selected = [...selected, ...newItems].slice(0, 20);
    sourceStats.naver = newItems.length;
    if (selected.length > 0 && source === 'none') source = 'naver';
  }

  // 2순위: 다음
  if (selected.length < 20) {
    const daumPicked = pickTopAndRandom(await fetchFromDaum());
    const newItems = daumPicked.filter(d => !selected.find(i => i.ticker === d.ticker));
    selected = [...selected, ...newItems].slice(0, 20);
    sourceStats.daum = newItems.length;
    if (selected.length > 0 && source === 'none') source = 'daum';
  }

  // 3순위: 이슈 종목
  let kisCandidates = [];
  if (selected.length < 20) {
    kisCandidates = await fetchKisCandidates(env, 100);
    const issuePicked = await fetchIssueStocks(kisCandidates);
    const newItems = issuePicked.filter(d => !selected.find(i => i.ticker === d.ticker));
    selected = [...selected, ...newItems].slice(0, 20);
    sourceStats.issue = newItems.length;
    if (selected.length > 0 && source === 'none') source = 'issue';
  }

  // 4순위: KIS 거래량/등락률
  if (selected.length < 20) {
    if (kisCandidates.length === 0) kisCandidates = await fetchKisCandidates(env, 100);
    const newItems = kisCandidates.filter(d => !selected.find(i => i.ticker === d.ticker));
    const kisFill = newItems.slice(0, 20 - selected.length);
    selected = [...selected, ...kisFill];
    sourceStats.kis = kisFill.length;
    if (selected.length > 0 && source === 'none') source = 'kis';
  }

  // 5순위: 시가총액 랜덤
  if (selected.length < 20) {
    const capPicked = await fetchMarketCapRandom(env, (20 - selected.length) + 10);
    const newItems = capPicked.filter(d => !selected.find(i => i.ticker === d.ticker));
    const capFill = newItems.slice(0, 20 - selected.length);
    selected = [...selected, ...capFill];
    sourceStats.cap = capFill.length;
    if (selected.length > 0 && source === 'none') source = 'cap';
  }

  const items = selected.slice(0, 20).map((item, idx) => ({ ...item, rank: idx + 1 }));

  if (items.length === 0) {
    return new Response(JSON.stringify({ error: '모든 소스 실패', source_stats: sourceStats }), { status: 502, headers: { 'content-type': 'application/json' } });
  }

  return new Response(JSON.stringify({
    items, total: items.length, source, source_stats: sourceStats,
    resolved_trading_day: resolvedTradingDayCache.ymd || null,
    fetched_at: new Date().toISOString(),
  }), { headers: { 'content-type': 'application/json; charset=utf-8' } });
}