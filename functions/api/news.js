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
    const items = parseRssItems(xmlText);
    const fetchedAt = new Date().toISOString();

    const fiveDaysAgo = new Date();
    fiveDaysAgo.setDate(fiveDaysAgo.getDate() - 5);
    const fourteenDaysAgo = new Date();
    fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);

    // ★ 각 항목 기본 검증 (제목/URL만 필수, 발행 시각은 선택)
    const validItems = items.filter((item) => {
      if (typeof item.title !== 'string' || item.title.length === 0 || item.title.length > 500) return false;
      if (typeof item.url !== 'string' || item.url.length > MAX_URL_LENGTH || !/^https?:\/\//i.test(item.url)) return false;
      return true;
    }).map((item) => ({
      title: item.title.slice(0, 500),
      url: item.url,
      published_at: item.published_at, // null 가능
      source_name: item.source_name || '네이버 금융',
      fetched_at: fetchedAt,
    }));

    // ★ 우선순위 1: 5일 이내 기사
    const within5 = validItems.filter((item) => {
      if (!item.published_at) return false;
      const t = new Date(item.published_at);
      return !isNaN(t.getTime()) && t >= fiveDaysAgo;
    });

    // ★ 우선순위 2: 5~14일 이내 기사 (5일 기사가 3개 미만일 때 보충)
    let finalItems = within5;
    if (within5.length < 3) {
      const within14 = validItems.filter((item) => {
        if (!item.published_at) return false;
        const t = new Date(item.published_at);
        return !isNaN(t.getTime()) && t >= fourteenDaysAgo && t < fiveDaysAgo;
      });
      finalItems = [...within5, ...within14].slice(0, 10);
    } else {
      finalItems = within5.slice(0, 10);
    }

    // ★ 최종적으로 0개면, 발행 시각 없는 기사도 포함 (제목/URL만 유효)
    if (finalItems.length === 0) {
      finalItems = validItems.slice(0, 5);
    }

    return jsonResponse({
      items: finalItems,
      delayed: false,
      // ★ 신뢰도 힌트: 5일 이내 기사가 있는지 여부
      has_recent_within_5d: within5.length > 0,
      total_collected: validItems.length,
      within_5d_count: within5.length,
    });
  } catch (err) {
    console.error('news.js Error:', err.message);
    return jsonResponse({ error: '뉴스를 가져오는 중 오류가 발생했습니다.' }, 502);
  }
}

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

    // ★ 발행 시각이 없으면 null로 (제외하지 않음)
    let publishedAt = null;
    if (pubDateMatch) {
      const d = new Date(pubDateMatch[1]);
      if (!isNaN(d.getTime())) publishedAt = d.toISOString();
    }

    items.push({
      title: decodeHtmlEntities(titleMatch[1].replace(/<!\[CDATA\[|\]\]>/g, '')),
      url,
      published_at: publishedAt,
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