// functions/api/news.js
export async function onRequestGet(context) {
  const { request } = context;
  const url = new URL(request.url);
  const query = (url.searchParams.get('ticker') || '').trim();

  if (!query) return jsonResponse({ error: '종목명을 입력해 주세요.' }, 400);

  try {
    // ★ 검색어에 '주가'를 추가하여 스포츠/연예 뉴스 필터링
    const searchQuery = `${query} 주가`;
    const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(searchQuery)}&hl=ko&gl=KR&ceid=KR:ko`;
    
    const res = await fetch(rssUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    if (!res.ok) {
      return jsonResponse({ error: '뉴스를 가져오지 못했습니다.' }, 502);
    }

    const xmlText = await res.text();
    let items = parseRssItems(xmlText).slice(0, 10);

    // ★ 스포츠/연예 관련 키워드가 포함된 뉴스 제외
    const excludeKeywords = ['야구', '축구', '농구', '배구', '선수', '감독', '구단', '경기', '연예인', '아이돌', '배우', '가수', '결혼', '열애', '이혼'];
    items = items.filter(item => {
      const text = `${item.title}`;
      return !excludeKeywords.some(kw => text.includes(kw));
    });

    // 최근 5일 이내 기사만 필터링
    const fiveDaysAgo = new Date();
    fiveDaysAgo.setDate(fiveDaysAgo.getDate() - 5);
    const recentItems = items.filter(item => new Date(item.published_at) >= fiveDaysAgo).slice(0, 3);

    return jsonResponse({
      items: recentItems,
      delayed: true,
    });
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
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}