// functions/api/history.js
import { getKisAccessToken } from './_kis_token.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const ticker = (url.searchParams.get('ticker') || '').trim();

  if (!/^[0-9A-Z]{6}$/i.test(ticker)) return jsonResponse({ error: '종목코드 형식이 올바르지 않습니다.' }, 400);

  const baseUrl = env.KIS_BASE_URL || 'https://openapi.koreainvestment.com:9443';
  if (!env.KIS_APP_KEY || !env.KIS_APP_SECRET) return jsonResponse({ error: 'KIS API 키가 설정되지 않았습니다.' }, 500);

  try {
    const accessToken = await getKisAccessToken(env, baseUrl);
    const now = new Date();
    const endDate = toKstDateStr(now);
    const startDate = toKstDateStr(new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000));

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

    // ★ KIS API 에러 시 502 대신 200(데이터 없음)으로 응답
    if (!res.ok) {
      const errText = await res.text();
      console.error('KIS History API Error:', res.status, errText.slice(0, 300));
      return jsonResponse({ 
        error: '과거 시세를 가져오지 못했습니다.', 
        data_available: false,
        return_1m: null,
        ma20_disparity: null,
        current_volume: null,
        avg_volume_20: null,
      });
    }

    const data = await res.json();
    
    if (data.rt_cd && data.rt_cd !== '0') {
      console.error('KIS History Data Error:', data.msg1);
      return jsonResponse({ 
        error: '과거 시세를 가져오지 못했습니다.', 
        data_available: false,
        return_1m: null,
        ma20_disparity: null,
        current_volume: null,
        avg_volume_20: null,
      });
    }

    const output2 = (data.output2 || [])
      .filter((r) => r && r.stck_bsop_date && Number(r.stck_clpr) > 0)
      .sort((a, b) => String(b.stck_bsop_date).localeCompare(String(a.stck_bsop_date)));

    if (output2.length < 20) {
      return jsonResponse({ 
        error: '과거 데이터가 부족합니다.', 
        data_available: false,
        return_1m: null,
        ma20_disparity: null,
        current_volume: null,
        avg_volume_20: null,
      });
    }

    const currentPrice = Number(output2[0].stck_clpr);
    const currentVolume = Number(output2[0].acml_vol || 0);
    const price20DaysAgo = Number(output2[19].stck_clpr);
    const return1M = ((currentPrice - price20DaysAgo) / price20DaysAgo) * 100;

    let sum20Price = 0;
    for (let i = 0; i < 20; i++) sum20Price += Number(output2[i].stck_clpr);
    const ma20 = sum20Price / 20;
    const ma20Disparity = ((currentPrice - ma20) / ma20) * 100;

    const todayPartial = output2[0].stck_bsop_date === toKstDateStr(now) && isRegularSessionKst(now);
    const volRows = (todayPartial ? output2.slice(1) : output2).slice(0, 20);
    let sum20Volume = 0;
    let validVolumeDays = 0;
    for (const r of volRows) {
      const v = Number(r.acml_vol || 0);
      if (v > 0) { sum20Volume += v; validVolumeDays++; }
    }
    const avgVolume20 = validVolumeDays > 0 ? Math.round(sum20Volume / validVolumeDays) : null;

    return jsonResponse({
      ticker,
      data_available: true,
      return_1m: Number(return1M.toFixed(2)),
      ma20_disparity: Number(ma20Disparity.toFixed(2)),
      current_volume: currentVolume > 0 ? currentVolume : null,
      avg_volume_20: avgVolume20,
      valid_volume_days: validVolumeDays,
      today_partial: todayPartial,
    });
  } catch (err) {
    console.error('history.js Error:', err.message);
    return jsonResponse({ error: '과거 시세를 가져오는 중 오류가 발생했습니다.', data_available: false }, 500);
  }
}

function toKstDateStr(d) {
  return new Date(d.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10).replace(/-/g, '');
}

function isRegularSessionKst(d) {
  const k = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const day = k.getUTCDay();
  const t = k.getUTCHours() * 100 + k.getUTCMinutes();
  return day !== 0 && day !== 6 && t >= 900 && t < 1530;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}