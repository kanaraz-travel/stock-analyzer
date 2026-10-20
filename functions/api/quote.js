// functions/api/quote.js
// GET /api/quote?ticker=삼성전자 (or 005930)

import { unzipSync } from 'fflate';

// 마스터 파일 캐싱 (전역 변수)
let masterCache = {
  loaded: false,
  map: new Map(), // 종목명 -> 종목코드
  codeMap: new Map(), // 종목코드 -> 종목명
  expiresAt: 0,
};
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24시간

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
    // 1) 입력값이 6자리 숫자(종목코드)가 아닌 경우, KIS 마스터 파일에서 검색
    if (!/^\d{6}$/.test(query)) {
      await ensureMasterLoaded();
      const foundCode = findCodeByName(query);

      if (!foundCode) {
        return jsonResponse({ error: `'${query}'에 해당하는 종목을 찾을 수 없습니다.` }, 404);
      }

      ticker = foundCode;
      stock_name = masterCache.codeMap.get(ticker) || query;
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
        { error: '시세를 가져오지 못했습니다. 잠시 후 다시 확인해 주세요.', detail: kisRes.status },
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
// 마스터 파일 로드 및 파싱
// ------------------------------------------------------------
async function ensureMasterLoaded() {
  if (masterCache.loaded && Date.now() < masterCache.expiresAt) return;

  const urls = [
    'https://new.real.download.dws.co.kr/common/master/kospi_code.mst.zip',
    'https://new.real.download.dws.co.kr/common/master/kosdaq_code.mst.zip',
  ];

  masterCache.map.clear();
  masterCache.codeMap.clear();

  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;

      const buf = await res.arrayBuffer();
      const unzipped = unzipSync(new Uint8Array(buf));

      for (const filename in unzipped) {
        const content = new TextDecoder('euc-kr').decode(unzipped[filename]);
        parseMasterFile(content);
      }
    } catch (e) {
      console.error('Master file load error:', url, e.message);
    }
  }

  masterCache.loaded = true;
  masterCache.expiresAt = Date.now() + CACHE_TTL;
}

function parseMasterFile(text) {
  const lines = text.split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;

    // KIS 마스터 파일 형식: 고정폭 (첫 9자리: 종목코드, 그 다음: 종목명 등)
    // 실제 형식은 버전에 따라 다를 수 있으므로, 안전하게 파싱합니다.
    // 일반적으로 첫 9자리는 단축코드(6자리) + 시장구분 등으로 구성됩니다.
    const codePart = line.substring(0, 9).trim();
    const code = codePart.substring(0, 6).trim();

    if (!/^\d{6}$/.test(code)) continue;

    // 종목명은 고정폭 형식에서 일반적으로 21번째 문자부터 시작합니다.
    // (KIS 마스터 파일 스펙에 따라 다를 수 있으므로, 유연하게 처리)
    let name = '';
    // 종목명 필드를 찾기 위해 여러 위치를 시도합니다.
    for (let start = 9; start < 30; start++) {
      const candidate = line.substring(start, start + 20).trim();
      // 한글이 포함된 필드를 종목명으로 간주
      if (/[가-힣]/.test(candidate)) {
        name = candidate.split(/\s{2,}/)[0].trim();
        break;
      }
    }

    if (name) {
      masterCache.map.set(name, code);
      masterCache.codeMap.set(code, name);
    }
  }
}

function findCodeByName(query) {
  const normalized = query.replace(/\s+/g, '').toLowerCase();

  // 완전 일치 우선
  for (const [name, code] of masterCache.map.entries()) {
    if (name.replace(/\s+/g, '').toLowerCase() === normalized) return code;
  }

  // 부분 일치
  for (const [name, code] of masterCache.map.entries()) {
    if (name.replace(/\s+/g, '').toLowerCase().includes(normalized)) return code;
  }

  return null;
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