// functions/api/quote.js
// GET /api/quote?ticker=삼성전자 (or 005930)

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  let query = (url.searchParams.get('ticker') || '').trim();

  if (!query) {
    return jsonResponse({ error: '종목명 또는 코드를 입력해 주세요.' }, 400);
  }

  let ticker = query;
  let stock_name = query;

  try {
    // 1) 입력값이 6자리 숫자(종목코드)가 아닌 경우, 네이버 금융 검색 API로 코드 조회
    if (!/^\d{6}$/.test(query)) {
      const searchRes = await fetch(
        `https://ac.finance.naver.com/ac?q=${encodeURIComponent(query)}&q_enc=utf-8&st=111&r_format=json&r_enc=utf-8`
      );
      const searchData = await searchRes.json();
      const items = searchData?.items?.[0];

      if (!items || items.length === 0) {
        return jsonResponse({ error: `'${query}'에 해당하는 종목을 찾을 수 없습니다.` }, 404);
      }

      // 검색된 첫 번째 종목의 코드와 이름 추출 (예: items[0][1] = "005930", items[0][0] = "삼성전자")
      ticker = items[0][1];
      stock_name = items[0][0];
    }

    // 2) 추출된 종목코드로 KIS API 호출 (또는 추후 대체될 API)
    const accessToken = await getKisAccessToken(env);

    const kisQuery = new URLSearchParams({
      FID_COND_MRKT_DIV_CODE: 'J',
      FID_INPUT_ISCD: ticker,
    });

    const kisRes = await fetch(
      `${env.KIS_BASE_URL}/uapi/domestic-stock/v1/quotations/inquire-price?${kisQuery}`,
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
      return jsonResponse(
        {
          error: '시세를 가져오지 못했습니다. 잠시 후 다시 확인해 주세요.',
          detail: kisRes.status,
          raw: errText.slice(0, 300),
        },
        502
      );
    }

    const data = await kisRes.json();
    const output = data.output || {};

    // 3) 결과 반환 (KIS API가 반환하는 정식 종목명이 있으면 그것을 사용)
    return jsonResponse({
      ticker,
      stock_name: output.hts_kor_isnm || stock_name, // KIS API의 한글 종목명 필드
      price: output.stck_prpr ? Number(output.stck_prpr) : null,
      change_rate: output.prdy_ctrt ? Number(output.prdy_ctrt) : null,
      volume: output.acml_vol ? Number(output.acml_vol) : null,
      market_status: mapMarketStatus(output),
      quote_as_of: new Date().toISOString(),
      provider: '한국투자증권 Open API',
      data_status: 'LATEST',
    });
  } catch (err) {
    return jsonResponse(
      { error: '시세를 가져오지 못했습니다. 잠시 후 다시 확인해 주세요.', detail: err.message },
      502
    );
  }
}

let tokenCache = { accessToken: null, expiresAt: 0 };

async function getKisAccessToken(env) {
  const now = Date.now();
  if (tokenCache.accessToken && now < tokenCache.expiresAt) {
    return tokenCache.accessToken;
  }

  const res = await fetch(`${env.KIS_BASE_URL}/oauth2/tokenP`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      appkey: env.KIS_APP_KEY,
      appsecret: env.KIS_APP_SECRET,
    }),
  });

  if (!res.ok) {
    throw new Error(`KIS token error: ${res.status}`);
  }

  const data = await res.json();
  const expiresIn = Number(data.expires_in) || 86400;
  tokenCache = {
    accessToken: data.access_token,
    expiresAt: now + (expiresIn - 60) * 1000,
  };
  return data.access_token;
}

function mapMarketStatus(output) {
  return 'UNKNOWN';
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}