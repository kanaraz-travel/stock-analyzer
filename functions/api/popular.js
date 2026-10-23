// functions/api/popular.js
import { getKisAccessToken } from './_kis_token.js';

// 1, 2순위는 기존 로직 유지 (차단되면 빠르게 실패)
async function fetchFromNaver() {
  // ... (기존 네이버 크롤링 로직 유지, 실패 시 빈 배열) ...
  return [];
}
async function fetchFromDaum() {
  // ... (기존 다음 크롤링 로직 유지, 실패 시 빈 배열) ...
  return [];
}

// ★ 3순위: 뉴스 이슈 점수 기반 선정 (T3)
async function fetchIssueStocks(env) {
  try {
    const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent('특징주 OR 급등주 OR 상한가')}&hl=ko&gl=KR&ceid=KR:ko`;
    const res = await fetch(rssUrl, { headers: { 'User-Agent': 'stock-analyzer/1.0' } });
    if (!res.ok) return [];
    const xml = await res.text();

    const titles = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRegex.exec(xml)) !== null) {
      const titleMatch = match[1].match(/<title>(.*?)<\/title>/);
      if (titleMatch) titles.push(titleMatch[1].replace(/<[^>]*>/g, ''));
    }

    // KIS 거래량 상위 100개 종목을 후보로 가져와서 매칭 (속도 개선)
    const kisCandidates = await fetchKisCandidates(env, 100);
    const scoreMap = new Map();

    kisCandidates.forEach(stock => {
      let mentionCount = 0;
      titles.forEach(title => {
        if (title.includes(stock.name)) mentionCount++;
      });
      if (mentionCount > 0) {
        scoreMap.set(stock.ticker, { ...stock, score: mentionCount });
      }
    });

    const sorted = Array.from(scoreMap.values()).sort((a, b) => b.score - a.score);
    return sorted.slice(0, 20).map(s => ({ ticker: s.ticker, name: s.name }));
  } catch (e) {
    console.warn('[popular] 이슈 종목 선정 실패:', e.message);
    return [];
  }
}

// ★ 4순위: KIS 거래량 + 등락률 상위 (T4)
async function fetchKisCandidates(env, limit = 20) {
  // KIS API 호출 로직 (거래량 순위와 등락률 순위를 섞어서 반환)
  // ... 기존 KIS API 호출 로직 재사용 ...
  return [];
}

export async function onRequestGet(context) {
  const { env } = context;
  let items = [];
  let sourceStats = { naver: 0, daum: 0, issue: 0, kis: 0 };
  
  // 1. 네이버
  const naver = await fetchFromNaver();
  items.push(...naver);
  sourceStats.naver = naver.length;

  // 2. 다음 (중복 제외)
  if (items.length < 20) {
    const daum = await fetchFromDaum();
    const newDaum = daum.filter(d => !items.find(i => i.ticker === d.ticker));
    items.push(...newDaum);
    sourceStats.daum = newDaum.length;
  }

  // 3. 이슈 종목 (중복 제외)
  if (items.length < 20) {
    const issue = await fetchIssueStocks(env);
    const newIssue = issue.filter(d => !items.find(i => i.ticker === d.ticker));
    items.push(...newIssue);
    sourceStats.issue = newIssue.length;
  }

  // 4. KIS 보충 (중복 제외)
  if (items.length < 20) {
    const kis = await fetchKisCandidates(env, 20 - items.length);
    const newKis = kis.filter(d => !items.find(i => i.ticker === d.ticker));
    items.push(...newKis);
    sourceStats.kis = newKis.length;
  }

  items = items.slice(0, 20).map((item, idx) => ({ ...item, rank: idx + 1 }));

  return new Response(JSON.stringify({ items, source_stats: sourceStats }), {
    headers: { 'content-type': 'application/json' }
  });
}