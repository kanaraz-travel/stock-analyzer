// functions/api/news.js
const MAX_URL_LENGTH = 2048;

export async function onRequestGet(context) {
  const { request } = context;
  const url = new URL(request.url);
  const query = (url.searchParams.get('ticker') || '').trim();

  if (!query || query.length > 50) return jsonResponse({ error: '종목명이 유효하지 않습니다.' }, 400);

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
    const fetchedAt = new Date().toISOString();

    // ★ 개선 #6: 최근 5일 + 유효 발행 시각 확인 (없으면 제외)
    const fiveDaysAgo = new Date();
    fiveDaysAgo.setDate(fiveDaysAgo.getDate() - 5);

    items = items
      .filter(item => {
        if (typeof item.title !== 'string' || item.title.length === 0 || item.title.length > 500) return false;
        if (typeof item.url !== 'string' || item.url.length > MAX_URL_LENGTH || !/^https?:\/\//i.test(item.url)) return false;
        if (!item.published_at) return false;
        const t = new Date(item.published_at);
        if (isNaN(t.getTime())) return false;
        if (t < fiveDaysAgo) return false;
        return true;
      })
      .map(item => ({
        title: item.title.slice(0, 500),
        url: item.url,
        published_at: item.published_at,
        source_name: item.source_name || '네이버 금융',
        fetched_at: fetchedAt,
      }))
      .slice(0, 5);

    return jsonResponse({ items, delayed: false });
  } catch (err) {
    console.error('news.js Error:', err.message);
    return jsonResponse({ error: '뉴스를 가져오는 중 오류가 발생했습니다.' }, 502);
  }
}

// ★ 개선 #6: URL 중복 제거 + 발행 시각 없는 기사는 스킵
function parseRssItems(xml) {
  const items = [];
  const seenUrls = new Set();
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const content = match[1];
    const titleMatch = content.match(/<title>(.*?)<\/title>/);
    const linkMatch = content.match(/<link>(.*?)<\/link>/);
    const pubDateMatch = content.match(/<pubDate>(.*?)<\/pubDate>/);
    const sourceMatch = content.match(/<source[^>]*>(.*?)<\/source>/);

    if (!titleMatch || !linkMatch) continue;

    const url = linkMatch[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim();
    if (!url || !/^https?:\/\//i.test(url) || url.length > MAX_URL_LENGTH) continue;

    const urlKey = url.toLowerCase();
    if (seenUrls.has(urlKey)) continue;
    seenUrls.add(urlKey);

    // ★ 발행 시각 없으면 제외
    if (!pubDateMatch) continue;
    const pubDate = new Date(pubDateMatch[1]);
    if (isNaN(pubDate.getTime())) continue;

    items.push({
      title: decodeHtmlEntities(titleMatch[1].replace(/<!\[CDATA\[|\]\]>/g, '')),
      url,
      published_at: pubDate.toISOString(),
      source_name: sourceMatch ? decodeHtmlEntities(sourceMatch[1]) : '네이버 금융',
    });
  }
  return items;
}

function decodeHtmlEntities(str) {
  return str.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}