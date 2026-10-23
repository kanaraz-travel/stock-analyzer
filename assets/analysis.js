// assets/analysis.js
import { 
  supabase, state, $, formatNumber, formatDateTime,
  updateMarketStatusBadge, updateDataStatusBadge, startCountdown
} from './app.js';
import { computeHoldings } from './holdings.js';

export function initAnalysis() {
  $('#search-btn').addEventListener('click', handleSearch);
  $('#ticker-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') handleSearch(); });
  $('#analyze-btn').addEventListener('click', () => runAnalysis(state.currentQuote?.ticker, state.currentQuote?.stock_name, state.currentQuote?.price, 'main'));
  
  const batchBtn = $('#batch-build-btn');
  if (batchBtn) batchBtn.addEventListener('click', runBatchAnalysis);

  // holdings.js에서 호출할 수 있도록 window에 바인딩
  window.runAnalysis = runAnalysis;
  window.renderInlineAnalysisResult = renderInlineAnalysisResult;
}

async function handleSearch() {
  const query = $('#ticker-input').value.trim(), errorEl = $('#search-error'); errorEl.hidden = true;
  if (!query) { errorEl.textContent = '종목명을 입력해 주세요.'; errorEl.hidden = false; return; }
  const btn = $('#search-btn'); btn.disabled = true; btn.textContent = '조회 중';
  try {
    const res = await fetch(`/api/quote?ticker=${encodeURIComponent(query)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '시세를 가져오지 못했습니다.');
    if (data.price == null) throw new Error('종목의 시세 정보가 없습니다.');
    state.currentQuote = data;
    if (data.price > 0) state.priceCache.set(data.ticker, data.price);
    renderQuote(data);
    updateMarketStatusBadge(data.market_status);
    updateDataStatusBadge(data.data_status);
  } catch (err) {
    errorEl.textContent = err.message || '시세를 가져오지 못했습니다.'; errorEl.hidden = false;
    $('#quote-card').hidden = true; $('#analysis-result').hidden = true;
    updateDataStatusBadge('ERROR');
  } finally { btn.disabled = false; btn.textContent = '조회'; }
}

function renderQuote(q) {
  $('#quote-card').hidden = false;
  $('#stock-name').textContent = q.stock_name || q.ticker;
  $('#current-price').textContent = q.price != null && q.price > 0 ? formatNumber(q.price) + '원' : '-';
  const changeEl = $('#change-rate');
  if (q.change_rate != null) {
    const sign = q.change_rate > 0 ? '+' : '';
    changeEl.textContent = `${sign}${q.change_rate.toFixed(2)}%`;
    changeEl.className = 'change-rate ' + (q.change_rate > 0 ? 'positive' : q.change_rate < 0 ? 'negative' : '');
  } else { changeEl.textContent = '-'; changeEl.className = 'change-rate'; }

  const ms = String(q.market_status || '');
  const ds = String(q.data_status || '');
  const isMarketClosed = ds === 'MARKET_CLOSED' || ms.includes('휴장') || ms.includes('장마감') || ms.includes('장 마감');
  const isAfterHours = ds === 'AFTER_HOURS' || ds === 'AFTER_MARKET';

  let timeLabel = '';
  if (q.quote_as_of) {
    timeLabel = `시세 기준 시각: ${formatDateTime(q.quote_as_of)}`;
  } else if (q.server_time) {
    const ts = formatDateTime(q.server_time);
    if (isMarketClosed) {
      timeLabel = `데이터 조회 시각: ${ts} · 장 마감 종가`;
    } else if (isAfterHours) {
      timeLabel = `데이터 조회 시각: ${ts} · 시간외 (정규장 종가 기준)`;
    } else {
      timeLabel = `데이터 조회 시각: ${ts} (시세 기준 시각 미확인)`;
    }
  } else {
    timeLabel = '시각 정보 없음';
  }
  $('#quote-as-of').textContent = timeLabel;

  if (state.analysisCache.has(q.ticker)) {
    renderAnalysisResult(state.analysisCache.get(q.ticker), false);
  } else {
    $('#analysis-result').hidden = true;
  }
}

export async function runAnalysis(ticker, name, price, targetType = 'main', cardElement = null) {
  if (!ticker) return;
  const isSilent = targetType === 'batch';

  let btn = null;
  let originalText = '';
  if (!isSilent) {
    btn = targetType === 'main' ? $('#analyze-btn') : cardElement.querySelector('.btn-ai-analyze');
    originalText = btn.textContent;
    btn.disabled = true; btn.textContent = '분석 중…';
    if (targetType === 'main') { state.isAnalyzingMain = true; $('#analysis-result').hidden = true; }
    else {
      const inlineResult = cardElement.querySelector('.holding-inline-result');
      if (inlineResult) { inlineResult.hidden = true; inlineResult.innerHTML = ''; }
    }
  }

  try {
    let { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      if (!isSilent) { alert('로그인 세션이 없습니다.'); await supabase.auth.signOut(); }
      throw new Error('로그인 세션이 없습니다.');
    }

    let freshQuote = null;
    try {
      const qRes = await fetch(`/api/quote?ticker=${encodeURIComponent(ticker)}`);
      if (qRes.ok) freshQuote = await qRes.json();
    } catch (e) { if (!isSilent) console.warn('시세 조회 실패', e); }

    const hasFreshPrice = freshQuote?.price != null && freshQuote.price > 0;
    const priceSource = hasFreshPrice ? 'FRESH' : 'STALE';
    const actualPrice = hasFreshPrice ? freshQuote.price : price;

    if (actualPrice == null || !Number.isFinite(actualPrice) || actualPrice <= 0) {
      throw new Error('유효한 현재가가 없어 분석할 수 없습니다.');
    }

    const actualChangeRate = hasFreshPrice ? (freshQuote?.change_rate ?? null) : null;
    const w52Hgpr = freshQuote?.w52_hgpr ?? null;
    const w52Lwpr = freshQuote?.w52_lwpr ?? null;

    let holdingsData = null;
    const txForTicker = state.transactions.filter(t => t.ticker === ticker);
    if (txForTicker.length > 0) {
      const result = computeHoldings(txForTicker).currentHoldings[0];
      if (result && result.qty > 0) {
        const buys = txForTicker.filter(t => t.transaction_type === 'BUY');
        const sells = txForTicker.filter(t => t.transaction_type === 'SELL');
        holdingsData = {
          quantity: result.qty,
          avg_cost: result.avgCost,
          return_rate: ((actualPrice - result.avgCost) / result.avgCost) * 100,
          total_cost: result.totalCost,
          first_buy_date: buys.length > 0 ? buys[0].trade_date : null,
          last_buy_date: buys.length > 0 ? buys[buys.length - 1].trade_date : null,
          last_sell_date: sells.length > 0 ? sells[sells.length - 1].trade_date : null,
        };
      }
    }

    let newsItems = [];
    let historyData = {};
    try {
      const [newsRes, histRes] = await Promise.all([
        fetch(`/api/news?ticker=${encodeURIComponent(name)}`),
        fetch(`/api/history?ticker=${encodeURIComponent(ticker)}`)
      ]);
      if (newsRes.ok) { const nd = await newsRes.json(); newsItems = nd.items || []; }
      if (histRes.ok) { historyData = await histRes.json(); }
    } catch { if (!isSilent) console.warn('뉴스/과거데이터 로드 실패'); }

    const currentVolume = freshQuote?.volume ?? historyData?.current_volume ?? null;
    const avgVolume20 = historyData?.avg_volume_20 ?? null;
    const volumeData = {
      current_volume: currentVolume,
      avg_volume_20: avgVolume20,
      ratio_5d: (currentVolume && avgVolume20 && avgVolume20 > 0) ? (currentVolume / avgVolume20) : null,
    };

    const payload = {
      ticker, stock_name: name || ticker, analysis_type: holdingsData ? 'sell' : 'buy',
      price_data: {
        current_price: actualPrice,
        quote_as_of: freshQuote?.quote_as_of ?? null,
        server_time: freshQuote?.server_time ?? null,
        quote_time_source: freshQuote?.quote_time_source ?? 'UNKNOWN',
        market_status: freshQuote?.market_status ?? null,
        price_source: priceSource,
        change_rate: actualChangeRate,
        return_1m: historyData?.return_1m ?? null,
        ma20_disparity: historyData?.ma20_disparity ?? null,
        w52_hgpr: w52Hgpr, w52_lwpr: w52Lwpr,
        is_after_hours_quote: freshQuote?.is_after_hours_quote ?? false,
        quote_note: freshQuote?.quote_note ?? null,
      },
      volume_data: volumeData,
      news_items: newsItems,
      holdings_data: holdingsData
    };

    let res = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify(payload)
    });
    if (res.status === 401) {
      await new Promise(r => setTimeout(r, 1000));
      const { data: { session: retrySession } } = await supabase.auth.refreshSession();
      if (retrySession) {
        res = await fetch('/api/analyze', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${retrySession.access_token}` }, body: JSON.stringify(payload) });
      } else {
        if (!isSilent) { alert('세션 만료'); await supabase.auth.signOut(); }
        throw new Error('세션 만료');
      }
    }
    const data = await res.json();
    if (!res.ok) {
      const detail = Array.isArray(data.details) ? `\n${data.details.join('\n')}` : '';
      throw new Error((data.error || '분석 실패') + detail);
    }
    data.analyzed_at = new Date().toISOString();
    state.analysisCache.set(ticker, data);

    if (isSilent) {
      // 배치 모드: UI 렌더링 없이 캐시만 저장
    } else if (targetType === 'main') {
      renderAnalysisResult(data, state.currentScreen === 'analysis');
    } else {
      renderInlineAnalysisResult(data, cardElement, true);
    }
    return data;
  } catch (err) {
    if (!isSilent) alert(err.message || '분석에 실패했습니다.');
    throw err;
  } finally {
    if (!isSilent && btn) {
      btn.disabled = false; btn.textContent = originalText;
      if (targetType === 'main') state.isAnalyzingMain = false;
    }
  }
}

async function waitWhileHidden(btn, currentIdx, total) {
  while (document.hidden) {
    btn.textContent = `일시정지 중 (탭 복귀 시 재개) ${currentIdx}/${total}`;
    await new Promise(r => setTimeout(r, 1000)); // HIDDEN_POLL_MS 대체
  }
}

async function runBatchAnalysis() {
  const name = $('#current-user-name').textContent;
  if (name !== '박필립') {
    alert(`박필립 계정에서만 사용할 수 있습니다.`);
    return;
  }
  if (state.isBatching) return;

  const btn = $('#batch-build-btn');
  const originalText = btn.textContent;

  state.isBatching = true;
  btn.disabled = true;
  btn.textContent = '인기 종목 불러오는 중...';

  let targets = [];
  let succeeded = 0;
  let failed = 0;

  try {
    const res = await fetch('/api/popular');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '인기 종목을 불러오지 못했습니다.');

    const items = Array.isArray(data.items) ? data.items : [];
    if (items.length === 0) throw new Error('인기 종목이 없습니다.');

    const topN = items.slice(0, Math.min(10, items.length));
    const pool = items.slice(10);
    const shuffled = [...pool].sort(() => Math.random() - 0.5);
    const randomN = shuffled.slice(0, Math.min(10, shuffled.length));

    targets = [...topN, ...randomN];
    if (targets.length === 0) throw new Error('분석할 종목이 없습니다.');

    const total = targets.length;

    for (let i = 0; i < targets.length; i++) {
      await waitWhileHidden(btn, i + 1, total);

      const stock = targets[i];
      btn.textContent = `이력 쌓기 ${i + 1}/${total} · ${stock.name}`;

      try {
        await runAnalysis(stock.ticker, stock.name, null, 'batch');
        succeeded++;
      } catch (e) {
        console.warn(`[batch] ${stock.name}(${stock.ticker}) 실패:`, e.message);
        failed++;
      }

      if (i < targets.length - 1) {
        await waitWhileHidden(btn, i + 1, total);
        await new Promise(r => setTimeout(r, 2500)); // BATCH_DELAY_MS 대체
      }
    }

    btn.textContent = `완료 (성공 ${succeeded} / 실패 ${failed})`;
    await new Promise(r => setTimeout(r, 4000));
  } catch (err) {
    console.error('[batch] error:', err);
    alert(err.message || '이력 쌓기에 실패했습니다.');
  } finally {
    state.isBatching = false;
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

function renderAnalysisResult(data, scrollTo = true) {
  $('#analysis-result').hidden = false;
  const badge = $('#recommendation-badge');
  badge.textContent = data.recommendation || '판단 보류';
  badge.className = 'recommendation-badge';
  const rec = data.recommendation || '';
  if (rec.includes('매수')) badge.classList.add('recommendation-badge--buy');
  else if (rec.includes('매도')) badge.classList.add('recommendation-badge--sell');
  else if (rec.includes('기다리기') || rec.includes('보유')) badge.classList.add('recommendation-badge--hold');
  else badge.classList.add('recommendation-badge--pending');

  const tsStr = formatDateTime(data.analyzed_at || new Date().toISOString());
  $('#analysis-timestamp').textContent = `분석 시각: ${tsStr}`;

  $('#overall-summary').textContent = data.overall_summary || '-';

  if (scrollTo && state.currentScreen === 'analysis') $('#analysis-result').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

export function renderInlineAnalysisResult(data, cardElement, scrollTo = true) {
  const container = cardElement.querySelector('.holding-inline-result');
  if (!container) return;
  container.hidden = false;
  container.innerHTML = '';

  const rec = data.recommendation || '판단 보류';
  let badgeClass = 'recommendation-badge--pending';
  if (rec.includes('매수')) badgeClass = 'recommendation-badge--buy';
  else if (rec.includes('매도')) badgeClass = 'recommendation-badge--sell';
  else if (rec.includes('기다리기') || rec.includes('보유')) badgeClass = 'recommendation-badge--hold';

  const headDiv = document.createElement('div'); headDiv.className = 'analysis-head';
  const badge = document.createElement('div'); badge.className = `recommendation-badge ${badgeClass}`; badge.textContent = rec;
  const ts = document.createElement('div'); ts.className = 'analysis-timestamp'; ts.textContent = formatDateTime(data.analyzed_at || new Date().toISOString());
  headDiv.appendChild(badge); headDiv.appendChild(ts); container.appendChild(headDiv);

  const overallBlock = document.createElement('div');
  overallBlock.className = 'analysis-block';
  const overallTitle = document.createElement('h4');
  overallTitle.className = 'analysis-block-title';
  overallTitle.textContent = '종합 분석';
  overallBlock.appendChild(overallTitle);
  const overallText = document.createElement('p');
  overallText.className = 'overall-summary-text';
  overallText.textContent = data.overall_summary || '-';
  overallBlock.appendChild(overallText);
  container.appendChild(overallBlock);

  if (scrollTo) container.scrollIntoView({ behavior: 'smooth', block: 'start' });
}