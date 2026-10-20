// functions/api/quote.js
// GET /api/quote?ticker=삼성전자 (or 005930)

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  let query = (url.searchParams.get('ticker') || '').trim();

  if (!query) {
    return jsonResponse({ error: '종목명 또는 코드를 입력해 주세요.' }, 400);
  }

  const baseUrl = env.KIS_BASE_URL || 'https://openapi.koreainvestment.com:9443';

  if (!env.KIS_APP_KEY || !env.KIS_APP_SECRET) {
    return jsonResponse(
      { error: '한국투자증권 API 키가 서버에 설정되지 않았습니다. 관리자에게 문의하세요.' },
      500
    );
  }

  let ticker = query;
  let stock_name = query;

  try {
    // 1) 입력값이 6자리 숫자(종목코드)가 아닌 경우, Yahoo Finance 검색 API로 코드 조회
    if (!/^\d{6}$/.test(query)) {
      const searchRes = await fetch(
        `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=1&newsCount=0`,
        {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/json',
          },
        }
      );

      if (!searchRes.ok) {
        console.error('Yahoo Search API Error:', searchRes.status);
        return jsonResponse(
          { error: '종목 검색 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' },
          502
        );
      }

      const searchData = await searchRes.json();
      const quotes = searchData?.quotes;

      if (!quotes || quotes.length === 0) {
        return jsonResponse({ error: `'${query}'에 해당하는 종목을 찾을 수 없습니다.` }, 404);
      }

      // Yahoo Finance 검색 결과에서 첫 번째 종목의 심볼과 이름 추출
      const firstQuote = quotes[0];
      // 한국 주식의 심볼은 "005930.KS" (KOSPI) 또는 "035720.KQ" (KOSDAQ) 형태입니다.
      // KIS API는 6자리 코드만 필요하므로 .KS / .KQ를 제거합니다.
      ticker = firstQuote.symbol.split('.')[0];
      stock_name = firstQuote.shortname || firstQuote.longname || query;
    }

    // 2) 추출된 종목코드로 KIS API 호출
    const accessToken = await getKisAccessToken(env, baseUrl);

    const kisQuery = new URLSearchParams({
      FID_COND_MRKT_DIV_CODE: 'J',
      FID_INPUT_ISCD: ticker,
    });

    const kisRes = await fetch(
      `${baseUrl}/uapi/domestic-stock/v1/quotations/inquire-price?${kisQuery}`,
      {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          authorization: `Bearer ${accessToken}`,
          appkey: env.KIS_APP_KEY,
          appsecret: env.KIS_APP_SECRET,
          tr_id: 'FHKST01010100',
        },
      }
    );

    if (!kisRes.ok) {
      const errText = await kisRes.text();
      console.error('KIS API Error:', kisRes.status, errText.slice(0, 300));
      return jsonResponse(
        {
          error: '시세를 가져오지 못했습니다. 잠시 후 다시 확인해 주세요.',
          detail: kisRes.status,
        },
        502
      );
    }

    let data;
    try {
      data = await kisRes.json();
    } catch (parseErr) {
      console.error('KIS API JSON Parse Error:', parseErr.message);
      return jsonResponse({ error: '시세 응답을 처리하지 못했습니다.' }, 502);
    }

    const output = data.output || {};

    // 3) 결과 반환
    return jsonResponse({
      ticker,
      stock_name: output.hts_kor_isnm || stock_name,
      price: output.stck_prpr ? Number(output.stck_prpr) : null,
      change_rate: output.prdy_ctrt ? Number(output.prdy_ctrt) : null,
      volume: output.acml_vol ? Number(output.acml_vol) : null,
      market_status: 'UNKNOWN',
      quote_as_of: new Date().toISOString(),
      provider: '한국투자증권 Open API',
      data_status: 'LATEST',
    });
  } catch (err) {
    console.error('quote.js Unexpected Error:', err.message);
    return jsonResponse(
      { error: '시세를 가져오지 못했습니다. 잠시 후 다시 확인해 주세요.', detail: err.message },
      502
    );
  }
}

// ------------------------------------------------------------
// 접근토큰 발급 (캐시 사용)
// ------------------------------------------------------------
let tokenCache = { accessToken: null, expiresAt: 0 };

async function getKisAccessToken(env, baseUrl) {
  const now = Date.now();
  if (tokenCache.accessToken && now < tokenCache.expiresAt) {
    return tokenCache.accessToken;
  }

  const res = await fetch(`${baseUrl}/oauth2/tokenP`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      appkey: env.KIS_APP_KEY,
      appsecret: env.KIS_APP_SECRET,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`KIS Token Error (${res.status}): ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  const expiresIn = Number(data.expires_in) || 86400;
  tokenCache = {
    accessToken: data.access_token,
    expiresAt: now + (expiresIn - 60) * 1000,
  };
  return data.access_token;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}