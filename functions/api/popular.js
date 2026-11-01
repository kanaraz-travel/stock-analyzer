// functions/api/popular.js
import {
  fetchFromNaver, fetchFromDaum, fetchKisCandidates, fetchMarketCapRandom,
  fetchIssueStocks, isValidTicker, isExcluded, isPreferredStock, resolvedTradingDayCache
} from './_popular_sources.js';

// 기본 폴백 종목 (모든 소스 실패 시)
const FALLBACK_ITEMS = [
  { ticker: '005930', name: '삼성전자' }, { ticker: '000660', name: 'SK하이닉스' },
  { ticker: '373220', name: 'LG에너지솔루션' }, { ticker: '207940', name: '삼성바이오로직스' },
  { ticker: '005380', name: '현대차' }, { ticker: '000270', name: '기아' },
  { ticker: '068270', name: '셀트리온' }, { ticker: '005490', name: 'POSCO홀딩스' },
  { ticker: '035420', name: 'NAVER' }, { ticker: '051910', name: 'LG화학' },
  { ticker: '006400', name: '삼성SDI' }, { ticker: '035720', name: '카카오' },
  { ticker: '105560', name: 'KB금융' }, { ticker: '055550', name: '신한지주' },
  { ticker: '012330', name: '현대모비스' }, { ticker: '028260', name: '삼성물산' },
  { ticker: '066570', name: 'LG전자' }, { ticker: '003670', name: '포스코퓨처엠' },
  { ticker: '015760', name: '한국전력' }, { ticker: '032830', name: '삼성생명' }
];

function pickTopAndRandom(sourceItems) {
  const valid = sourceItems.filter(i => isValidTicker(i.ticker) && !isExcluded(i.name) && !isPreferredStock(i.name));
  if (valid.length === 0) return [];
  const topN = valid.slice(0, 10);
  const pool = valid.slice(10, 100);
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  return [...topN, ...shuffled.slice(0, 10)];
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const excludePreferred = url.searchParams.get('exclude_preferred') === '1';
  
  const sourceStats = { naver: 0, daum: 0, issue: 0, kis: 0, cap: 0 };

  try {
    // ★ 4가지 소스 병렬 호출 (속도 극대화)
    const [naverRaw, daumRaw, kisRaw] = await Promise.all([
      fetchFromNaver().catch(() => []),
      fetchFromDaum().catch(() => []),
      fetchKisCandidates(env, 100).catch(() => [])
    ]);

    // 뉴스 이슈 종목은 KIS 후보를 기반으로 병렬 호출
    const issueRaw = await fetchIssueStocks(kisRaw).catch(() => []);

    let selected = [];
    let source = 'none';

    const addItems = (items, sourceName) => {
      const valid = pickTopAndRandom(items);
      const newItems = valid.filter(d => !selected.find(i => i.ticker === d.ticker));
      const fillCount = 20 - selected.length;
      const fill = newItems.slice(0, fillCount);
      selected = [...selected, ...fill];
      sourceStats[sourceName] = fill.length;
      if (fill.length > 0 && source === 'none') source = sourceName;
    };

    // 우선순위에 따라 데이터 병합 (순서는 유지하되 속도는 빠름)
    if (selected.length < 20) addItems(naverRaw, 'naver');
    if (selected.length < 20) addItems(daumRaw, 'daum');
    if (selected.length < 20) addItems(issueRaw, 'issue');
    if (selected.length < 20) addItems(kisRaw, 'kis');
    
    // 시총 랜덤은 단독 호출 (필요할 때만)
    if (selected.length < 20) {
      const capRaw = await fetchMarketCapRandom(env, (20 - selected.length) + 10).catch(() => []);
      addItems(capRaw, 'cap');
    }

    // ★ 모든 소스가 실패하여 20개를 채우지 못했다면 기본 종목으로 폴백
    if (selected.length < 20) {
      const remaining = 20 - selected.length;
      const fallbackFill = FALLBACK_ITEMS
        .filter(item => !selected.find(i => i.ticker === item.ticker))
        .slice(0, remaining);
      selected = [...selected, ...fallbackFill];
      source = 'fallback';
      console.warn(`[popular] Fallback triggered. Added ${fallbackFill.length} default stocks.`);
    }

    const items = selected.slice(0, 20).map((item, idx) => ({ ...item, rank: idx + 1 }));

    return new Response(JSON.stringify({
      items, total: items.length, source, source_stats: sourceStats,
      resolved_trading_day: resolvedTradingDayCache.ymd || null,
      fetched_at: new Date().toISOString(),
    }), { headers: { 'content-type': 'application/json; charset=utf-8' } });

  } catch (err) {
    console.error('[popular.js] Unhandled error:', err.message);
    // 예기치 못한 에러가 나도 기본 종목이라도 반환해줌
    return new Response(JSON.stringify({
      items: FALLBACK_ITEMS.map((item, idx) => ({ ...item, rank: idx + 1 })),
      total: 20, source: 'fallback', error: err.message
    }), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } });
  }
}