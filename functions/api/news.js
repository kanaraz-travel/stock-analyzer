// functions/api/news.js
const MAX_URL_LENGTH = 2048;
const MAX_RETURN = 15;

// ★ 외부 뉴스 사이트 응답 지연 대비 4초 타임아웃 유틸리티
async function fetchWithTimeout(url, options = {}, timeoutMs = 4000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return response;
  } catch (e) {
    clearTimeout(id);
    return null; // 타임아웃 또는 에러 시 null 반환
  }
}

export async function onRequestGet(context) {
  const { request } = context;
  const url = new URL(request.url);
  const query = (url.searchParams.get('ticker') || '').trim();

  if (!query || query.length > 50) {
    return jsonResponse({ error: '종목명이 유효하지 않습니다.' }, 400);
  }

  try {
    // 네이버와 구글 뉴스를 병렬로 수집
    const [naverItems, googleItems] = await Promise.all([
      tryNaverRss(query).catch(() => []),
      tryGoogleNewsRss(query).catch(() => []),
    ]);

    // URL 기준 중복 제거
    const seen = new Set();
    const merged = [];
    for (const item of [...naverItems, ...googleItems]) {
      const key = item.url.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }

    // 최신순 정렬
    merged.sort((a, b) => {
      if (a.published_at && b.published_at) return new Date(b.published_at) - new Date(a.published_at);
      if (a.published_at) return -1;
      if (b.published_at) return 1;
      return 0;
    });

    return jsonResponse({
      items: merged.slice(0, MAX_RETURN),
      total_collected: merged.length,
    });
  } catch (err) {
    console.error('news.js Error:', err.message);
    return jsonResponse({ error: '뉴스를 가져오는 중 오류가 발생했습니다.' }, 502);
  }
}

async function tryNaverRss(query) {
  const url = `https://finance.naver.com/news/news_search.naver?q=${encodeURIComponent(query)}&rss=1`;
  const res = await fetchWithTimeout(url, {
    headers: { 
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 
      'Accept': 'application/rss+xml, application/xml, text/xml' 
    },
  }, 4000);

  if (!res || !res.ok) return [];
  return parseRssItems(await res.text(), '네이버 금융');
}

async function tryGoogleNewsRss(query) {
  // 검색어 확장: "종목명 주가"로 검색하여 관련 기사 우선 수집
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query + ' 주가')}&hl=ko&gl=KR&ceid=KR:ko`;
  const res = await fetchWithTimeout(url, { 
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' } 
  }, 4000);

  if (!res || !res.ok) return [];
  return parseRssItems(await res.text(), 'Google News');
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
    
    // ★ 뉴스 본문 요약(description) 파싱
    const descMatch = content.match(/<description>(.*?)<\/description>/);

    if (!titleMatch || !linkMatch) continue;

    const url = linkMatch[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim();
    if (!url || !/^https?:\/\//i.test(url) || url.length > MAX_URL_LENGTH) continue;

    let publishedAt = null;
    if (pubDateMatch) {
      const d = new Date(pubDateMatch[1]);
      if (!isNaN(d.getTime())) publishedAt = d.toISOString();
    }

    // ★ HTML 태그 제거 및 텍스트만 추출 (최대 200자)
    const summary = descMatch 
      ? decodeHtmlEntities(descMatch[1].replace(/<[^>]*>/g, '')).slice(0, 200) 
      : '';

    items.push({
      title: decodeHtmlEntities(titleMatch[1].replace(/<!\[CDATA\[|\]\]>/g, '')).slice(0, 500),
      summary, // ★ 본문 요약 추가
      url,
      published_at: publishedAt,
      source_name: sourceMatch ? decodeHtmlEntities(sourceMatch[1]) : defaultSource,
    });
  }
  return items;
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}