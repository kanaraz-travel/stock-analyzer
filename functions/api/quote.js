// functions/api/quote.js
import { unzipSync } from 'fflate';

let masterCache = { loaded: false, map: new Map(), codeMap: new Map(), expiresAt: 0 };
const CACHE_TTL = 24 * 60 * 60 * 1000;
let tokenCache = { accessToken: null, expiresAt: 0 };
let tokenPromise = null;

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  let query = (url.searchParams.get('ticker') || '').trim();

  if (!query) return jsonResponse({ error: '종목명 또는 코드를 입력해 주세요.' }, 400);

  const baseUrl = env.KIS_BASE_URL || 'https://openapi.koreainvestment.com:9443';
  if (!env.KIS_APP_KEY || !env.KIS_APP_SECRET) return jsonResponse({ error: 'KIS API 키가 설정되지 않았습니다.' }, 500);

  let ticker = query;
  let stock_name = query;

  try {
    if (!/^\d{6}$/.test(query)) {
      await ensureMasterLoaded();
      const foundCode = findCodeByName(query);
      if (!foundCode) return jsonResponse({ error: `'${query}'에 해당하는 종목을 찾을 수 없습니다.` }, 404);
      ticker = foundCode;
      stock_name = masterCache.codeMap.get(ticker) || query;
    }

    const accessToken = await getKisAccessToken(env, baseUrl);
    const kisQuery = new URLSearchParams({ FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: ticker });

    // 재시도 로직 (최대 2회, 지수 백오프)
    let kisRes;
    let lastError;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        kisRes = await fetch(`${baseUrl}/uapi/domestic-stock/v1/quotations/inquire-price?${kisQuery}`, {
          headers: {
            'content-type': 'application/json; charset=utf-8',
            authorization: `Bearer ${accessToken}`,
            appkey: env.KIS_APP_KEY,
            appsecret: env.KIS_APP_SECRET,
            tr_id: 'FHKST01010100',
            // ★ WAF 차단 방지를 위해 브라우저 User-Agent 추가
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/json',
          },
        });

        if (kisRes.status === 429 || kisRes.status === 502) {
          lastError = new Error(`KIS API ${kisRes.status} Error`);
          console.warn(`KIS API ${kisRes.status} error for ${ticker}, retrying (${attempt + 1}/2)...`);
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        break;
      } catch (err) {
        lastError = err;
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      }
    }

    if (!kisRes || !kisRes.ok) {
      const errText = kisRes ? await kisRes.text() : (lastError?.message || 'Unknown error');
      console.error(`KIS API Final Error for ${ticker}:`, kisRes?.status, errText.slice(0, 300));
      return jsonResponse({ error: '시세를 가져오지 못했습니다. 잠시 후 다시 확인해 주세요.', detail: kisRes?.status }, 502);
    }

    let data;
    try { data = await kisRes.json(); } catch { return jsonResponse({ error: '시세 응답을 처리하지 못했습니다.' }, 502); }
    
    if (data.rt_cd && data.rt_cd !== '0') {
      console.error(`KIS API Business Error for ${ticker}: rt_cd=${data.rt_cd}, msg=${data.msg1}`);
      return jsonResponse({ error: `시세 조회 실패: ${data.msg1 || '알 수 없는 오류'}`, detail: data.rt_cd }, 502);
    }

    const output = data.output || {};
    let finalName = output.hts_kor_isnm || stock_name;
    if (/^[A-Z0-9]{10,}/.test(finalName)) finalName = finalName.replace(/^[A-Z0-9]{10,}\s*/, '').trim();

    const rawPrice = Number(output.stck_prpr);
    const price = (rawPrice && rawPrice > 0) ? rawPrice : null;

    return jsonResponse({
      ticker, stock_name: finalName,
      price: price,
      change_rate: output.prdy_ctrt ? Number(output.prdy_ctrt) : null,
      volume: output.acml_vol ? Number(output.acml_vol) : null,
      market_status: getMarketStatus(),
      quote_as_of: new Date().toISOString(),
      provider: '한국투자증권 Open API',
      data_status: 'LATEST',
    });
  } catch (err) {
    console.error('quote.js Unexpected Error:', err.message);
    return jsonResponse({ error: '시세를 가져오지 못했습니다. 잠시 후 다시 확인해 주세요.' }, 502);
  }
}

// ... (ensureMasterLoaded, parseMasterFile, findCodeByName, getMarketStatus, getKisAccessToken, jsonResponse 함수는 이전과 동일)