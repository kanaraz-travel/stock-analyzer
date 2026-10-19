// functions/api/quote.js
// GET /api/quote?ticker=005930

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const ticker = (url.searchParams.get('ticker') || '').trim();

  // 입력 검증 (6자리 숫자)
  if (!/^\d{6}$/.test(ticker)) {
    return jsonResponse({ error: '종목코드는 6자리 숫자여야 합니다.' }, 400);
  }

  try {
    // 1) 접근토큰 발급 (캐시된 토큰이 있으면 재사용)
    const accessToken = await getKisAccessToken(env);

    // 2) 현재가 시세 조회
    const query = new URLSearchParams({
      FID_COND_MRKT_DIV_CODE: 'J',
      FID_INPUT_ISCD: ticker,
    });

    const kisRes = await fetch(
      `${env.KIS_BASE_URL}/uapi/domestic-stock/v1/quotations/inquire-price?${query}`,
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

    // 3) 필요한 필드만 정규화하여 반환 (원본 전체를 그대로 노출하지 않음)
    return jsonResponse({
      ticker,
      // stck_prpr: 현재가, prdy_ctrt: 전일 대비율, acml_vol: 누적 거래량
      price: output.stck_prpr ? Number(output.stck_prpr) : null,
      change_rate: output.prdy_ctrt ? Number(output.prdy_ctrt) : null,
      volume: output.acml_vol ? Number(output.acml_vol) : null,
      market_status: mapMarketStatus(output),
      quote_as_of: new Date().toISOString(), // 실제 응답 시각 (KIS 응답에 시각 필드가 있으면 우선 사용)
      provider: '한국투자증권 Open API',
      data_status: 'LATEST',
    });
  } catch (err) {
    return jsonResponse(
      {
        error: '시세를 가져오지 못했습니다. 잠시 후 다시 확인해 주세요.',
        detail: err.message,
      },
      502
    );
  }
}

// ------------------------------------------------------------
// 접근토큰 발급 (KV 캐시 사용 권장, 여기서는 단순화를 위해 인메모리 캐시)
// 실제 운영에서는 Cloudflare KV에 토큰을 저장하고 만료 시간을 관리하세요.
// ------------------------------------------------------------
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
  const expiresIn = Number(data.expires_in) || 86400; // 기본 1일
  tokenCache = {
    accessToken: data.access_token,
    expiresAt: now + (expiresIn - 60) * 1000, // 1분 여유
  };
  return data.access_token;
}

function mapMarketStatus(output) {
  // KIS 응답 필드에 따라 장중/장마감/휴장 판단 (간략화)
  // 실제로는 응답의 시간 외/장중 구분 필드를 확인해야 합니다.
  return 'UNKNOWN';
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}