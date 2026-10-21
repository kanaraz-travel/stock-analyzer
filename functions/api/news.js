// functions/api/news.js
export async function onRequestGet(context) {
  const { request } = context;
  const url = new URL(request.url);
  const query = (url.searchParams.get('ticker') || '').trim();

  if (!query) return jsonResponse({ error: '종목명을 입력해 주세요.' }, 400);

  // 네이버 금융 뉴스 RSS (한국 주식 특화)
  const naverRssUrl = `https://finance.naver.com/news/news_search.naver?q=${encodeURIComponent(query)}&rss=1`;

  try {
    const res = await fetch(naverRssUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/rss+xml, application/xml, text/xml',
      },
    });

    if (!res.ok) {
      console.error('Naver News RSS Error:', res.status);
      return jsonResponse({ error: '뉴스를 가져오지 못했습니다.' }, 502);
    }

    const xmlText = await res.text();
    let items = parseRssItems(xmlText);

    // 최근 5일 이내 필터링
    const fiveDaysAgo = new Date();
    fiveDaysAgo.setDate(fiveDaysAgo.getDate() - 5);
    
    let recentItems = items.filter(item => {
      if (!item.published_at) return true; // 날짜 없으면 포함
      return new Date(item.published_at) >= fiveDaysAgo;
    });

    // 최대 5개 반환
    recentItems = recentItems.slice(0, 5);

    return jsonResponse({ items: recentItems, delayed: false });
  } catch (err) {
    console.error('news.js Error:', err.message);
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
    const sourceMatch = itemContent.match(/<source[^>]*>(.*?)<\/source>/);

    if (titleMatch && linkMatch) {
      items.push({
        title: decodeHtmlEntities(titleMatch[1].replace(/<!\[CDATA\[|\]\]>/g, '')),
        url: linkMatch[1].replace(/<!\[CDATA\[|\]\]>/g, ''),
        published_at: pubDateMatch ? new Date(pubDateMatch[1]).toISOString() : null,
        source_name: sourceMatch ? decodeHtmlEntities(sourceMatch[1]) : '네이버 금융',
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