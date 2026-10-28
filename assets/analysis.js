// assets/analysis.js
import { supabase, state, $, computeHoldings } from './core.js';
import { renderAnalysisResult, renderInlineAnalysisResult } from './analysis_ui.js';

let batchState = 'idle';
let failedStocks = [];

export function initAnalysis() {
  const analyzeBtn = $('#analyze-btn');
  if (analyzeBtn) {
    analyzeBtn.addEventListener('click', () => runAnalysis(
      state.currentQuote?.ticker, state.currentQuote?.stock_name, state.currentQuote?.price, 'main'
    ));
  }
  const batchBtn = $('#batch-build-btn');
  if (batchBtn) {
    batchBtn.parentNode.style.position = 'relative';
    batchBtn.addEventListener('click', () => {
      if (batchState === 'idle') runBatchAnalysis();
      else if (batchState === 'result') showFailures();
      else if (batchState === 'failures') resetBatchButton();
    });
  }
}

async function getValidSession() {
  let { data: { session }, error } = await supabase.auth.getSession();
  if (error || !session) throw new Error('로그인 세션이 없습니다. 다시 로그인해 주세요.');
  const now = Math.floor(Date.now() / 1000);
  const isExpiringSoon = session.expires_at && (session.expires_at - now < 60);
  if (isExpiringSoon || !session.refresh_token) {
    const { data: refreshData, error: refreshError } = await supabase.auth.refreshSession();
    if (refreshError || !refreshData.session) {
      await supabase.auth.signOut();
      throw new Error('세션이 만료되었습니다. 다시 로그인해 주세요.');
    }
    return refreshData.session;
  }
  return session;
}

export async function runAnalysis(ticker, name, price, targetType = 'main', cardElement = null) {
  if (!ticker) return;
  const isSilent = targetType === 'batch';
  if (!isSilent && targetType === 'inline' && !cardElement) return;
  if (!isSilent && targetType === 'main' && state.isAnalyzingMain) return;

  let btn = null, originalText = '';
  if (!isSilent) {
    btn = targetType === 'main' ? $('#analyze-btn') : cardElement.querySelector('.btn-ai-analyze');
    if (btn) {
      originalText = btn.textContent.trim();
      if (originalText.includes('분석 중')) originalText = targetType === 'main' ? '분석' : 'AI 분석하기';
      btn.disabled = true; btn.textContent = '분석 중…';
    }
    if (targetType === 'main') {
      state.isAnalyzingMain = true;
      $('#analysis-result').hidden = true;
    } else {
      const inlineResult = cardElement.querySelector('.holding-inline-result');
      if (inlineResult) { inlineResult.hidden = true; inlineResult.innerHTML = ''; }
    }
  }

  try {
    const session = await getValidSession();

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
          quantity: result.qty, avg_cost: result.avgCost,
          return_rate: ((actualPrice - result.avgCost) / result.avgCost) * 100,
          total_cost: result.totalCost,
          first_buy_date: buys.length > 0 ? buys[0].trade_date : null,
          last_buy_date: buys.length > 0 ? buys[buys.length - 1].trade_date : null,
          last_sell_date: sells.length > 0 ? sells[sells.length - 1].trade_date : null,
        };
      }
    }

    let newsItems = [], historyData = {};
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
      current_volume: currentVolume, avg_volume_20: avgVolume20,
      ratio_5d: (currentVolume && avgVolume20 && avgVolume20 > 0) ? (currentVolume / avgVolume20) : null,
    };

    const payload = {
      ticker, stock_name: name || ticker, analysis_type: holdingsData ? 'sell' : 'buy',
      price_data: {
        current_price: actualPrice, quote_as_of: freshQuote?.quote_as_of ?? null,
        server_time: freshQuote?.server_time ?? null, quote_time_source: freshQuote?.quote_time_source ?? 'UNKNOWN',
        market_status: freshQuote?.market_status ?? null, price_source: priceSource,
        change_rate: actualChangeRate, return_1m: historyData?.return_1m ?? null,
        ma20_disparity: historyData?.ma20_disparity ?? null, w52_hgpr: w52Hgpr, w52_lwpr: w52Lwpr,
        is_after_hours_quote: false, quote_note: freshQuote?.quote_note ?? null,
      },
      volume_data: volumeData, news_items: newsItems, holdings_data: holdingsData
    };

    let res = await fetch('/api/analyze', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify(payload)
    });

    if (res.status === 401) {
      console.warn('[runAnalysis] 401 Unauthorized. 토큰 갱신 시도...');
      await new Promise(r => setTimeout(r, 1000));
      const { data: { session: retrySession } } = await supabase.auth.refreshSession();
      if (retrySession) {
        res = await fetch('/api/analyze', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${retrySession.access_token}` }, body: JSON.stringify(payload) });
      } else {
        await supabase.auth.signOut();
        throw new Error('인증이 만료되었습니다. 다시 로그인해 주세요.');
      }
    }

    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch (e) {
      console.error('서버 응답이 JSON이 아닙니다:', text.slice(0, 200));
      throw new Error(`서버 오류가 발생했습니다. (Status: ${res.status})`);
    }

    if (!res.ok) throw new Error((data.error || '분석 실패') + (Array.isArray(data.details) ? `\n${data.details.join('\n')}` : ''));

    data.analyzed_at = new Date().toISOString();
    state.analysisCache.set(ticker, data);

    if (!isSilent) {
      if (targetType === 'main') {
        if (state.currentQuote?.ticker === ticker) renderAnalysisResult(data, state.currentScreen === 'analysis');
      } else {
        renderInlineAnalysisResult(data, cardElement, true);
      }
    }
    return data;
  } catch (err) {
    if (!isSilent) alert(err.message || '분석에 실패했습니다.');
    throw err;
  } finally {
    if (!isSilent && btn) {
      btn.disabled = false; btn.textContent = originalText || (targetType === 'main' ? '분석' : 'AI 분석하기');
      if (targetType === 'main') state.isAnalyzingMain = false;
    }
  }
}

async function runBatchAnalysis() {
  const name = $('#current-user-name').textContent;
  if (name !== '박필립') { alert(`박필립 계정에서만 사용할 수 있습니다.`); return; }
  if (state.isBatching) return;

  const btn = $('#batch-build-btn');
  btn.disabled = true; btn.textContent = '인기 종목 불러오는 중...';

  state.isBatching = true; failedStocks = [];
  let succeeded = 0, failed = 0, consecutiveFallbacks = 0, authFailed = false;

  try {
    try { await getValidSession(); } catch (e) { alert('세션이 만료되었습니다. 다시 로그인해 주세요.'); await supabase.auth.signOut(); return; }

    const res = await fetch('/api/popular?exclude_preferred=1');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '인기 종목을 불러오지 못했습니다.');
    const items = Array.isArray(data.items) ? data.items : [];
    if (items.length === 0) throw new Error('인기 종목이 없습니다.');

    for (let i = 0; i < items.length; i++) {
      if (authFailed) break;
      const stock = items[i];
      btn.textContent = `이력 쌓기 ${i + 1}/${items.length} · ${stock.name}`;

      try {
        const result = await runAnalysis(stock.ticker, stock.name, null, 'batch');
        if (result && result.fallback) {
          failedStocks.push(`${stock.name}(${result.fallback_reason})`);
          failed++; consecutiveFallbacks++;
          if (consecutiveFallbacks >= 3) {
            btn.textContent = `연속 폴백 ${consecutiveFallbacks}회로 중단`;
            alert(`연속으로 분석이 실패하여 중단합니다.\n최근 사유: ${result.fallback_message || result.fallback_reason}`);
            break;
          }
        } else if (result && result.saved === false) {
          failedStocks.push(`${stock.name}(저장 실패)`); failed++; consecutiveFallbacks = 0;
        } else { succeeded++; consecutiveFallbacks = 0; }
      } catch (e) {
        if (e.message.includes('인증') || e.message.includes('세션')) {
          alert('세션이 만료되어 이력 쌓기를 중단합니다.'); authFailed = true; break;
        }
        failedStocks.push(`${stock.name}(${e.message.slice(0, 40)})`); failed++; consecutiveFallbacks = 0;
      }
      if (i < items.length - 1 && !authFailed) await new Promise(r => setTimeout(r, 2500));
    }
    if (!authFailed) { btn.textContent = `완료 (성공 ${succeeded} / 실패 ${failed})`; btn.disabled = false; batchState = 'result'; }
  } catch (err) {
    alert(err.message || '이력 쌓기에 실패했습니다.'); resetBatchButton();
  } finally { state.isBatching = false; }
}

function showFailures() {
  const btn = $('#batch-build-btn');
  if (failedStocks.length === 0) { alert('모든 종목 분석에 성공했습니다!'); resetBatchButton(); return; }
  let tooltip = document.getElementById('batch-tooltip');
  if (!tooltip) {
    tooltip = document.createElement('div'); tooltip.id = 'batch-tooltip'; tooltip.className = 'batch-tooltip'; btn.parentNode.appendChild(tooltip);
  }
  tooltip.textContent = `실패한 종목 (${failedStocks.length}건):\n${failedStocks.join(', ')}`;
  tooltip.hidden = false; btn.textContent = '닫기'; batchState = 'failures';
}

function resetBatchButton() {
  const tooltip = document.getElementById('batch-tooltip'); if (tooltip) tooltip.remove();
  const btn = $('#batch-build-btn'); btn.textContent = '이력 쌓기'; btn.disabled = false; batchState = 'idle';
}