// functions/api/history.js
// GET /api/history?ticker=005930

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const ticker = (url.searchParams.get('ticker') || '').trim();

  if (!/^\d{6}$/.test(ticker)) return jsonResponse({ error: '종목코드는 6자리 숫자여야 합니다.' }, 400);

  const baseUrl = env.KIS_BASE_URL || 'https://openapi.koreainvestment.com:9443';
  if (!env.KIS_APP_KEY || !env.KIS_APP_SECRET) return jsonResponse({ error: 'KIS API 키가 설정되지 않았습니다.' }, 500);

  try {
    const accessToken = await getKisAccessToken(env, baseUrl);

    // 최근 30일(영업일 기준 약 20~22일) 데이터를 가져오기 위한 날짜 설정
    const now = new Date();
    const endDate = now.toISOString().slice(0, 10).replace(/-/g, ''); // YYYYMMDD
    const startDateObj = new Date(now);
    startDateObj.setDate(startDateObj.getDate() - 40); // 넉넉하게 40일 전부터
    const startDate = startDateObj.toISOString().slice(0, 10).replace(/-/g, '');

    const query = new URLSearchParams({
      FID_COND_MRKT_DIV_CODE: 'J',
      FID_INPUT_ISCD: ticker,
      FID_INPUT_DATE_1: startDate,
      FID_INPUT_DATE_2: endDate,
      FID_PERIOD_DIV_CODE: 'D',
    });

    const res = await fetch(`${baseUrl}/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice?${query}`, {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        authorization: `Bearer ${accessToken}`,
        appkey: env.KIS_APP_KEY,
        appsecret: env.KIS_APP_SECRET,
        tr_id: 'FHKST03010100',
      },
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error('KIS History API Error:', res.status, errText.slice(0, 300));
      return jsonResponse({ error: '과거 시세를 가져오지 못했습니다.' }, 502);
    }

    const data = await res.json();
    
    if (data.rt_cd && data.rt_cd !== '0') {
      return jsonResponse({ error: `과거 시세 조회 실패: ${data.msg1}` }, 502);
    }

    const output2 = data.output2 || []; // 일봉 데이터 배열 (최신순)
    if (output2.length < 20) return jsonResponse({ error: '과거 데이터가 부족합니다.' }, 404);

    // KIS API는 최신 데이터가 배열 앞쪽에 옴
    const currentPrice = Number(output2[0].stck_clpr); // 가장 최근 종가
    const price20DaysAgo = Number(output2[19].stck_clpr); // 20거래일 전 종가

    // 1개월 수익률 계산
    const return1M = ((currentPrice - price20DaysAgo) / price20DaysAgo) * 100;

    // 20일 이동평균 계산 (최근 20일 종가의 평균)
    let sum20 = 0;
    for (let i = 0; i < 20; i++) {
      sum20 += Number(output2[i].stck_clpr);
    }
    const ma20 = sum20 / 20;
    const ma20Disparity = ((currentPrice - ma20) / ma20) * 100; // 괴리율

    return jsonResponse({
      ticker,
      return_1m: Number(return1M.toFixed(2)),
      ma20_disparity: Number(ma20Disparity.toFixed(2)),
    });
  } catch (err) {
    console.error('history.js Error:', err.message);
    return jsonResponse({ error: '과거 시세를 가져오는 중 오류가 발생했습니다.' }, 502);
  }
}

// 토큰 발급 (중복 방지 Lock)
let tokenCache = { accessToken: null, expiresAt: 0 };
let tokenPromise = null;

async function getKisAccessToken(env, baseUrl) {
  const now = Date.now();
  if (tokenCache.accessToken && now < tokenCache.expiresAt) return tokenCache.accessToken;
  if (tokenPromise) return tokenPromise;

  tokenPromise = (async () => {
    try {
      const res = await fetch(`${baseUrl}/oauth2/tokenP`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ grant_type: 'client_credentials', appkey: env.KIS_APP_KEY, appsecret: env.KIS_APP_SECRET }),
      });
      if (!res.ok) throw new Error(`KIS Token Error (${res.status})`);
      const data = await res.json();
      tokenCache = { accessToken: data.access_token, expiresAt: now + ((Number(data.expires_in) || 86400) - 60) * 1000 };
      return data.access_token;
    } finally {
      tokenPromise = null;
    }
  })();
  return tokenPromise;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}