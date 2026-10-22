// functions/api/news.js
const MAX_URL_LENGTH = 2048;
const MAX_RETURN = 15;

export async function onRequestGet(context) {
  const { request } = context;
  const url = new URL(request.url);
  const query = (url.searchParams.get('ticker') || '').trim();

  if (!query || query.length > 50) {
    return jsonResponse({ error: '종목명이 유효하지 않습니다.' }, 400);
  }

  try {
    // ★ 네이버 + Google 병렬 수집
    const [naverItems, googleItems] = await Promise.all([
      tryNaverRss(query).catch((e) => { console.warn('Naver RSS 실패:', e.message); return []; }),
      tryGoogleNewsRss(query).catch((e) => { console.warn('Google RSS 실패:', e.message); return []; }),
    ]);

    // ★ URL 기준 병합 및 중복 제거
    const seen = new Set();
    const merged = [];
    for (const item of [...naverItems, ...googleItems]) {
      const key = item.url.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }

    // ★ 최신순 정렬 (published_at 있는 것 우선, 없으면 뒤로)
    merged.sort((a, b) => {
      if (a.published_at && b.published_at) return new Date(b.published_at) - new Date(a.published_at);
      if (a.published_at) return -1;
      if (b.published_at) return 1;
      return 0;
    });

    return jsonResponse({
      items: merged.slice(0, MAX_RETURN),
      total_collected: merged.length,
      sources_used: {
        naver: naverItems.length,
        google: googleItems.length,
      },
    });
  } catch (err) {
    console.error('news.js Error:', err.message);
    return jsonResponse({ error: '뉴스를 가져오는 중 오류가 발생했습니다.' }, 502);
  }
}

async function tryNaverRss(query) {
  const url = `https://finance.naver.com/news/news_search.naver?q=${encodeURIComponent(query)}&rss=1`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/rss+xml, application/xml, text/xml',
    },
  });
  if (!res.ok) return [];
  const xml = await res.text();
  return parseRssItems(xml, '네이버 금융');
}

async function tryGoogleNewsRss(query) {
  // Google News RSS: 종목명 + "주가"로 검색하여 주식 관련 기사 우선 수집
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query + ' 주가')}&hl=ko&gl=KR&ceid=KR:ko`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
  });
  if (!res.ok) return [];
  const xml = await res.text();
  return parseRssItems(xml, 'Google News');
}

function parseRssItems(xml, defaultSource) {
  const items = [];
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

    // ★ 발행 시각이 없으면 null (기사 자체는 유지)
    let publishedAt = null;
    if (pubDateMatch) {
      const d = new Date(pubDateMatch[1]);
      if (!isNaN(d.getTime())) publishedAt = d.toISOString();
    }

    const sourceName = sourceMatch ? decodeHtmlEntities(sourceMatch[1]) : defaultSource;

    items.push({
      title: decodeHtmlEntities(titleMatch[1].replace(/<!\[CDATA\[|\]\]>/g, '')).slice(0, 500),
      url,
      published_at: publishedAt,
      source_name: sourceName,
    });
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