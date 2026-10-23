// functions/api/popular.js
import { getKisAccessToken } from './_kis_token.js';

const ETF_BRANDS = [
  'KODEX', 'TIGER', 'KBSTAR', 'ARIRANG', 'HANARO',
  'SOL', 'ACE', 'PLUS', 'RISE', 'KOSEF',
  'TIMEFOLIO', '히어로즈', '마이다스', '파워',
];

function isEtf(name) {
  const upper = name.toUpperCase();
  return ETF_BRANDS.some(b => upper.includes(b.toUpperCase()));
}

export async function onRequestGet(context) {
  const { env } = context;
  const baseUrl = env.KIS_BASE_URL || 'https://openapi.koreainvestment.com:9443';

  if (!env.KIS_APP_KEY || !env.KIS_APP_SECRET) {
    return jsonResponse({ error: 'KIS API 키가 설정되지 않았습니다.' }, 500);
  }

  try {
    const accessToken = await getKisAccessToken(env, baseUrl);

    const query = new URLSearchParams({
      FID_COND_MRKT_DIV_CODE: 'J',
      FID_COND_SCR_DIV_CODE: '20171', // 거래량 순위
      FID_INPUT_ISCD: '0000',
      FID_DIV_CLS_CODE: '0',
      FID_BLNG_CLS_CODE: '0',
      FID_TRGT_CLS_CODE: '111111111',
      FID_TRGT_EXLS_CLS_CODE: '000000',
      FID_INPUT_PRICE_1: '',
      FID_INPUT_PRICE_2: '',
      FID_VOL_CNT: '',
      FID_INPUT_DATE_1: '',
      FID_INPUT_CNT_1: '30', // ★ API는 최대 30개까지만 반환함
    });

    const res = await fetch(`${baseUrl}/uapi/domestic-stock/v1/quotations/volume-rank?${query}`, {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        authorization: `Bearer ${accessToken}`,
        appkey: env.KIS_APP_KEY,
        appsecret: env.KIS_APP_SECRET,
        tr_id: 'FHPST01710000',
      },
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error('KIS Volume Rank Error:', res.status, errText.slice(0, 300));
      return jsonResponse({ error: '인기 종목을 불러오지 못했습니다.', error_code: 'KIS_API_ERROR' }, 502);
    }

    const data = await res.json();
    if (data.rt_cd && data.rt_cd !== '0') {
      return jsonResponse({ error: `조회 실패: ${data.msg1}`, error_code: 'KIS_DATA_ERROR' }, 502);
    }

    const items = [];
    const output = data.output || [];

    for (const row of output) {
      const ticker = row.mksc_shrn_iscd;
      const name = row.hts_kor_isnm;
      const prdtType = row.prdt_type_cd; // 상품 유형 코드 (300: 주식)
      const marketName = row.rprs_mrkt_kor_name || row.bstp_kor_isnm || ''; // 시장명
      
      if (!ticker || !name) continue;
      
      // 1. 주식(300)만 필터링 (ETF, ETN 등 제외)
      if (prdtType !== '300') continue;
      
      // 2. 코스피(유가증권) / 코스닥 시장만 필터링
      if (!marketName.includes('유가증권') && !marketName.includes('코스피') && !marketName.includes('코스닥')) continue;
      
      // 3. ETF 브랜드명 2차 필터링 (혹시 모를 잔여 ETF 제거)
      if (isEtf(name)) continue;

      items.push({ rank: items.length + 1, ticker, name });
    }

    if (items.length === 0) {
      return jsonResponse({ error: '조회된 인기 종목이 없습니다.', error_code: 'EMPTY_RESULT' }, 404);
    }

    return jsonResponse({
      items,
      total: items.length,
      source: 'kis_volume_rank',
      fetched_at: new Date().toISOString(),
    });

  } catch (err) {
    console.error('popular.js Error:', err.message);
    return jsonResponse({ error: '인기 종목을 가져오는 중 오류가 발생했습니다.', error_code: 'FETCH_ERROR' }, 500);
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}