// functions/api/news.js
export async function onRequestGet(context) {
  const { request } = context;
  const url = new URL(request.url);
  const query = (url.searchParams.get('ticker') || '').trim();

  if (!query) return jsonResponse({ error: '종목명을 입력해 주세요.' }, 400);

  try {
    // ★ 두 가지 검색어로 병렬 검색하여 더 많은 기사 확보
    const searchQueries = [`${query} 주가`, `${query} 실적`];
    const allItems = [];

    const fetches = searchQueries.map(async (q) => {
      try {
        const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=ko&gl=KR&ceid=KR:ko`;
        const res = await fetch(rssUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
        });
        if (!res.ok) return [];
        const xml = await res.text();
        return parseRssItems(xml);
      } catch { return []; }
    });

    const results = await Promise.all(fetches);
    results.forEach(r => allItems.push(...r));

    // URL 기준 중복 제거
    const seen = new Set();
    const uniqueItems = allItems.filter(item => {
      if (seen.has(item.url)) return false;
      seen.add(item.url);
      return true;
    });

    // ★ 최소한의 스포츠/연예 필터 (오탐 방지를 위해 최소화)
    const excludeKeywords = ['야구', '축구', '농구', '배구', '선수', '감독', '구단', '홈런', '타자', '투수', '연예인', '아이돌', '배우', '가수', '결혼식', '열애설'];
    const filteredItems = uniqueItems.filter(item => {
      const text = `${item.title}`;
      return !excludeKeywords.some(kw => text.includes(kw));
    });

    // 최근 5일 이내 필터링
    const fiveDaysAgo = new Date();
    fiveDaysAgo.setDate(fiveDaysAgo.getDate() - 5);
    const recentItems = filteredItems
      .filter(item => new Date(item.published_at) >= fiveDaysAgo)
      .slice(0, 5); // AI가 판단할 수 있도록 5개 반환

    return jsonResponse({ items: recentItems, delayed: true });
  } catch (err) {
    return jsonResponse({ error: '뉴스를 가져오는 중 오류가 발생했습니다.' }, 502);
  }
}

function parseRssItems(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const itemContent = match[1];
    const titleMatch = itemContent.match(/<title>(.*?)<\/title>/);
    const linkMatch = itemContent.match(/<link>(.*?)<\/link>/);
    const pubDateMatch = itemContent.match(/<pubDate>(.*?)<\/pubDate>/);
    const sourceMatch = itemContent.match(/<source url=".*?">(.*?)<\/source>/);
    if (titleMatch && linkMatch) {
      items.push({
        title: decodeHtmlEntities(titleMatch[1]),
        url: linkMatch[1],
        published_at: pubDateMatch ? new Date(pubDateMatch[1]).toISOString() : new Date().toISOString(),
        source_name: sourceMatch ? decodeHtmlEntities(sourceMatch[1]) : 'Google News',
      });
    }
  }
  return items;
}

function decodeHtmlEntities(str) {
  return str.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}