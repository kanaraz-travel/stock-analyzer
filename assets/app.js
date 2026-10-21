// assets/app.js
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const SUPABASE_URL = 'https://hexykwjjkkozbeaqziem.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhleHlrd2pqa2tvemJlYXF6aWVtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE3OTk0MzUsImV4cCI6MjEwNzM3NTQzNX0.r4m4TY8dkkb19PKmMqdDH3_SicTUpt2DoXeDVSE1M3g';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});

const ALLOWED_NAMES = ['박필립', '윤혜영'];
let currentUser = null, currentQuote = null, transactions = [], editingTxId = null;
let currentScreen = 'holdings';

let countdown = 5;
let countdownInterval = null;
let isRefreshing = false;

// ★ 백그라운드 분석 상태 관리
let isAnalyzingMain = false;
let pendingAnalysisTicker = null; 
const priceCache = new Map();
const analysisCache = new Map();

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// 보유 주식 테두리 색상
const BORDER_COLORS = ['#ef4444', '#f97316', '#f59e0b', '#84cc16', '#10b981', '#06b6d4', '#3b82f6', '#6366f1', '#8b5cf6', '#d946ef', '#ec4899', '#f43f5e'];
function getBorderColor(ticker) {
  let hash = 0;
  for (let i = 0; i < ticker.length; i++) hash = ticker.charCodeAt(i) + ((hash << 5) - hash);
  return BORDER_COLORS[Math.abs(hash) % BORDER_COLORS.length];
}

async function init() {
  renderLoginButtons(); setupLogoutButton(); setupRefreshButton(); setupNavigation(); setupAccordions();
  setupSearch(); setupAnalyze(); setupTransactionForm(); setupVisibility();

  supabase.auth.onAuthStateChange((_event, session) => handleAuthState(session));
  const { data: { session } } = await supabase.auth.getSession();
  handleAuthState(session);
}

async function handleAuthState(session) {
  currentUser = session?.user || null;
  if (currentUser) {
    $('#screen-login').hidden = true; $('#app-shell').hidden = false;
    $('#current-user-name').textContent = mapEmailToName(currentUser.email) || currentUser.email || '';
    
    switchScreen('holdings'); 
    updateMarketStatusBadge(getMarketStatusClient());

    await loadHoldings(); 
    startCountdown();
  } else {
    $('#screen-login').hidden = false; $('#app-shell').hidden = true; resetState();
    stopCountdown();
  }
}

function mapEmailToName(email) {
  if (!email) return '';
  const map = { 'philip@kanaraz-travel.test': '박필립', 'hyeyoung@kanaraz-travel.test': '윤혜영' };
  return map[email.toLowerCase()] || '';
}

function resetState() {
  stopCountdown(); currentQuote = null; transactions = []; editingTxId = null;
  priceCache.clear(); analysisCache.clear();
  isAnalyzingMain = false; pendingAnalysisTicker = null;
  $('#quote-card').hidden = true; $('#analysis-result').hidden = true;
  $('#ticker-input').value = ''; $('#search-error').hidden = true;
  $('#transaction-form').reset(); $('#tx-id').value = ''; $('#tx-error').hidden = true;
  setTxFormMode(null); $('#holdings-list').innerHTML = '<p class="empty-text">아직 등록된 거래가 없습니다.</p>';
  ['#total-cost', '#total-value', '#total-pnl', '#realized-pnl'].forEach((id) => { $(id).textContent = '-'; });
  $$('.login-name-btn').forEach((b) => (b.disabled = false));
  $('#login-error').hidden = true; $('#login-loading').hidden = true;

  const dataBadge = $('#data-status-badge');
  dataBadge.textContent = '데이터 상태 확인 중';
  dataBadge.className = 'badge badge--muted';
}

function renderLoginButtons() {
  const container = $('#login-buttons'); container.innerHTML = '';
  ALLOWED_NAMES.forEach((name) => {
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'btn btn--primary btn--block login-name-btn'; btn.textContent = name;
    btn.addEventListener('click', () => handleLogin(name)); container.appendChild(btn);
  });
}

async function handleLogin(name) {
  const errorEl = $('#login-error'), loadingEl = $('#login-loading'), buttons = $$('.login-name-btn');
  errorEl.hidden = true; loadingEl.hidden = false; buttons.forEach((b) => (b.disabled = true));
  try {
    const res = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
    let data = {}; try { data = await res.json(); } catch { throw new Error('서버 응답을 해석할 수 없습니다.'); }
    if (!res.ok) throw new Error(data.error || '로그인에 실패했습니다.');
    if (!data.token_hash) throw new Error('로그인 토큰이 없습니다.');
    const { error: verifyError } = await supabase.auth.verifyOtp({ type: 'magiclink', token_hash: data.token_hash });
    if (verifyError) throw new Error(mapAuthError(verifyError.message));
  } catch (err) {
    errorEl.textContent = err.message || '로그인에 실패했습니다.'; errorEl.hidden = false;
    buttons.forEach((b) => (b.disabled = false));
  } finally { loadingEl.hidden = true; }
}

function mapAuthError(msg) {
  const m = (msg || '').toLowerCase();
  if (m.includes('expired') || m.includes('invalid')) return '로그인 링크가 만료되었습니다. 다시 시도해 주세요.';
  if (m.includes('rate limit') || m.includes('too many')) return '시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.';
  if (m.includes('network') || m.includes('fetch')) return '네트워크 오류가 발생했습니다. 연결을 확인해 주세요.';
  return msg || '로그인에 실패했습니다.';
}

function setupLogoutButton() { $('#logout-btn').addEventListener('click', async () => { if (!confirm('로그아웃하시겠습니까?')) return; stopCountdown(); await supabase.auth.signOut(); }); }

function startCountdown() {
  stopCountdown(); countdown = 5; updateRefreshButton();
  countdownInterval = setInterval(() => {
    if (document.hidden) return;
    if (countdown > 0) countdown--;
    if (countdown === 0) { clearInterval(countdownInterval); countdownInterval = null; }
    updateRefreshButton();
  }, 1000);
}

function stopCountdown() { if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; } updateRefreshButton(); }

function updateRefreshButton() {
  const btn = $('#refresh-btn'); if (!btn) return;
  if (isRefreshing) { btn.textContent = '새로고침 중...'; btn.disabled = true; }
  else if (countdown > 0) { btn.textContent = `새로고침 (${countdown})`; btn.disabled = true; }
  else { btn.textContent = '새로고침'; btn.disabled = false; }
}

function setupRefreshButton() {
  $('#refresh-btn').addEventListener('click', async () => {
    if (isRefreshing || countdown > 0) return;
    isRefreshing = true; stopCountdown(); updateRefreshButton();
    try { await performRefresh(); } finally { isRefreshing = false; startCountdown(); }
  });
}

async function performRefresh() {
  if (currentScreen === 'analysis') { 
    if (currentQuote) await refreshQuoteSilently(currentQuote.ticker);
  }
  else if (currentScreen === 'holdings') { await refreshHoldingsView(); }
}

function setupVisibility() { document.addEventListener('visibilitychange', () => updateRefreshButton()); }

function getMarketStatusClient() {
  const now = new Date(); const kstTime = new Date(now.getTime() + (9 * 60 * 60 * 1000));
  const day = kstTime.getUTCDay(); const timeVal = kstTime.getUTCHours() * 100 + kstTime.getUTCMinutes();
  if (day === 0 || day === 6) return '휴장 (주말)';
  if (timeVal >= 900 && timeVal < 1530) return '정규장 09:00~15:30';
  if (timeVal >= 1530 && timeVal < 1600) return '장 마감 (대기)';
  if (timeVal >= 1600 && timeVal <= 2000) return '애프터마켓 16:00~20:00';
  return '장마감';
}

function updateMarketStatusBadge(statusText) {
  const badge = $('#market-status-badge'); badge.textContent = statusText;
  if (statusText.includes('정규장')) badge.className = 'badge badge--status-green';
  else if (statusText.includes('애프터마켓')) badge.className = 'badge badge--status-orange';
  else badge.className = 'badge badge--status-gray';
}

function updateDataStatusBadge(status) {
  const badge = $('#data-status-badge');
  if (status === 'LATEST') { badge.textContent = '연결 원활'; badge.className = 'badge badge--status-green'; }
  else if (status === 'DELAYED') { badge.textContent = '지연'; badge.className = 'badge badge--status-orange'; }
  else { badge.textContent = '연결 끊김'; badge.className = 'badge badge--status-gray'; }
}

function switchScreen(target) {
  currentScreen = target;
  $$('.nav-btn').forEach((b) => b.classList.toggle('nav-btn--active', b.dataset.screen === target));
  $('#screen-analysis').classList.toggle('screen--active', target === 'analysis');
  $('#screen-holdings').classList.toggle('screen--active', target === 'holdings');
  
  if (target === 'analysis') {
    restoreAnalysisResults();
    if (isAnalyzingMain) {
      // 분석 중이면 버튼 상태 복원
      $('#analyze-btn').disabled = true;
      $('#analyze-btn').textContent = '분석 중…';
    }
  }
}

function restoreAnalysisResults() {
  if (currentQuote && analysisCache.has(currentQuote.ticker)) {
    renderAnalysisResult(analysisCache.get(currentQuote.ticker), false);
  }
  
  transactions.forEach(tx => {
    if (analysisCache.has(tx.ticker)) {
      const card = document.querySelector(`.holding-card[data-ticker="${tx.ticker}"]`);
      if (card) {
        const inlineResult = card.querySelector('.holding-inline-result');
        if (inlineResult) {
          renderInlineAnalysisResult(analysisCache.get(tx.ticker), card, false);
        }
      }
    }
  });
}

function setupNavigation() {
  $$('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const target = btn.dataset.screen; switchScreen(target);
      
      if (target === 'holdings') { 
        const holdingsData = computeHoldings(transactions);
        let totalCost = 0, totalCurrentValue = 0;
        holdingsData.currentHoldings.forEach(h => {
          totalCost += h.totalCost;
          const price = priceCache.get(h.ticker) || h.avgCost;
          totalCurrentValue += price * h.qty;
        });
        renderHoldingsList(holdingsData.currentHoldings, priceCache);
        renderHoldingsSummary(holdingsData, totalCost, totalCurrentValue); 
      }
    });
  });
}

function setupSearch() { $('#search-btn').addEventListener('click', handleSearch); $('#ticker-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') handleSearch(); }); }

async function handleSearch() {
  const query = $('#ticker-input').value.trim(), errorEl = $('#search-error'); errorEl.hidden = true;
  if (!query) { errorEl.textContent = '종목명을 입력해 주세요.'; errorEl.hidden = false; return; }
  const btn = $('#search-btn'); btn.disabled = true; btn.textContent = '조회 중';
  try {
    const res = await fetch(`/api/quote?ticker=${encodeURIComponent(query)}`); const data = await res.json();
    if (!res.ok) throw new Error(data.error || '시세를 가져오지 못했습니다.');
    if (data.price == null) throw new Error('종목의 시세 정보가 없습니다.');
    
    currentQuote = data; 
    if (data.price > 0) priceCache.set(data.ticker, data.price); 
    
    renderQuote(data); updateMarketStatusBadge(data.market_status); updateDataStatusBadge(data.data_status);
  } catch (err) {
    errorEl.textContent = err.message || '시세를 가져오지 못했습니다. 잠시 후 다시 확인해 주세요.'; errorEl.hidden = false; $('#quote-card').hidden = true; $('#analysis-result').hidden = true;
    updateDataStatusBadge('ERROR');
  } finally { btn.disabled = false; btn.textContent = '조회'; }
}

function renderQuote(q) {
  $('#quote-card').hidden = false; $('#stock-name').textContent = q.stock_name || q.ticker;
  $('#current-price').textContent = q.price != null && q.price > 0 ? formatNumber(q.price) + '원' : '-';
  const changeEl = $('#change-rate');
  if (q.change_rate != null) {
    const sign = q.change_rate > 0 ? '+' : '';
    changeEl.textContent = `${sign}${q.change_rate.toFixed(2)}%`;
    changeEl.className = 'change-rate ' + (q.change_rate > 0 ? 'positive' : q.change_rate < 0 ? 'negative' : '');
  } else { changeEl.textContent = '-'; changeEl.className = 'change-rate'; }
  $('#quote-as-of').textContent = `시세 시각: ${q.quote_as_of ? formatDateTime(q.quote_as_of) : '-'}`;
  $('#quote-provider').textContent = `출처: ${q.provider || '-'}`; 
  
  if (analysisCache.has(q.ticker)) {
    renderAnalysisResult(analysisCache.get(q.ticker), false);
  } else {
    $('#analysis-result').hidden = true;
  }
}

async function refreshQuoteSilently(ticker) {
  try {
    const res = await fetch(`/api/quote?ticker=${encodeURIComponent(ticker)}`);
    if (!res.ok) { 
      console.warn(`[시세조회 실패] ${ticker}: ${res.status}`);
      updateDataStatusBadge('ERROR'); 
      return; 
    }
    const data = await res.json();
    if (currentQuote?.ticker === ticker) { 
      if (data.price > 0) priceCache.set(ticker, data.price); 
      currentQuote = data; renderQuote(data); updateMarketStatusBadge(data.market_status); updateDataStatusBadge(data.data_status); 
    }
  } catch (err) { 
    console.error(`[시세조회 에러] ${ticker}:`, err);
    updateDataStatusBadge('ERROR'); 
  }
}

function setupAccordions() { 
  $$('.accordion-trigger').forEach((trigger) => { 
    trigger.addEventListener('click', () => { 
      const expanded = trigger.getAttribute('aria-expanded') === 'true'; 
      trigger.setAttribute('aria-expanded', String(!expanded)); 
    }); 
  }); 
}

async function loadHoldings() {
  if (!currentUser) return;
  const { data, error } = await supabase.from('stock_transactions').select('*').order('trade_date', { ascending: true }).order('created_at', { ascending: true });
  if (error) { console.error('loadHoldings error:', error.message); return; }
  transactions = data || []; 
  await refreshHoldingsView();
}

async function refreshHoldingsView(holdingsData) {
  if (!holdingsData) holdingsData = computeHoldings(transactions);
  const { currentHoldings } = holdingsData;
  let totalCost = 0, totalCurrentValue = 0;
  const currentPriceMap = new Map();
  
  if (currentHoldings.length === 0) { 
    renderHoldingsList([], currentPriceMap);
    renderHoldingsSummary(holdingsData, 0, 0); 
    return; 
  }

  for (const h of currentHoldings) {
    totalCost += h.totalCost;
    let price = null;
    try {
      const res = await fetch(`/api/quote?ticker=${h.ticker}`);
      if (res.ok) { 
        const q = await res.json(); 
        if (currentPriceMap.size === 0) { updateMarketStatusBadge(q.market_status); updateDataStatusBadge(q.data_status); }
        if (q.price != null && q.price > 0) { 
          price = q.price;
          priceCache.set(h.ticker, q.price); 
        }
      }
    } catch (err) { 
      console.error(`[시세조회 에러] ${h.stock_name}(${h.ticker}):`, err);
      updateDataStatusBadge('ERROR'); 
    }
    
    if (!price) price = priceCache.get(h.ticker) || h.avgCost;
    
    currentPriceMap.set(h.ticker, price);
    totalCurrentValue += price * h.qty;
    await new Promise(r => setTimeout(r, 300));
  }
  
  renderHoldingsList(currentHoldings, currentPriceMap);
  renderHoldingsSummary(holdingsData, totalCost, totalCurrentValue);
}

function setupAnalyze() { $('#analyze-btn').addEventListener('click', () => runAnalysis(currentQuote?.ticker, currentQuote?.stock_name, currentQuote?.price, 'main')); }

async function runAnalysis(ticker, name, price, targetType = 'main', cardElement = null) {
  if (!ticker) return;

  const btn = targetType === 'main' ? $('#analyze-btn') : cardElement.querySelector('.btn-ai-analyze');
  const originalText = btn.textContent;
  btn.disabled = true; btn.textContent = '분석 중…';
  
  // ★ 메인 분석 상태 저장
  if (targetType === 'main') {
    isAnalyzingMain = true;
    pendingAnalysisTicker = ticker;
    $('#analysis-result').hidden = true;
  } else {
    const inlineResult = cardElement.querySelector('.holding-inline-result');
    if (inlineResult) { inlineResult.hidden = true; inlineResult.innerHTML = ''; }
  }

  try {
    let { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      alert('로그인 세션이 없습니다. 다시 로그인해 주세요.');
      await supabase.auth.signOut();
      return;
    }

    let holdingsData = null;
    const txForTicker = transactions.filter(t => t.ticker === ticker);
    if (txForTicker.length > 0) {
      const result = computeHoldings(txForTicker).currentHoldings[0];
      if (result && result.qty > 0) {
        holdingsData = {
          quantity: result.qty,
          avg_cost: result.avgCost,
          return_rate: ((price - result.avgCost) / result.avgCost) * 100,
          total_cost: result.totalCost
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
    } catch (fetchErr) {
      console.warn('뉴스/과거데이터 로드 실패:', fetchErr);
    }

    const currentVolume = currentQuote?.volume ?? null;
    const avgVolume20 = historyData?.avg_volume_20 ?? null;
    const volumeData = {
      current_volume: currentVolume,
      avg_volume_20: avgVolume20,
      ratio_5d: (currentVolume && avgVolume20) ? (currentVolume / avgVolume20) : null,
    };

    const payload = {
      ticker, 
      stock_name: name || ticker, 
      analysis_type: holdingsData ? 'sell' : 'buy',
      price_data: { 
        current_price: price, 
        quote_as_of: new Date().toISOString(), 
        change_rate: currentQuote?.change_rate ?? null,
        return_1m: historyData?.return_1m ?? null,
        ma20_disparity: historyData?.ma20_disparity ?? null,
        w52_hgpr: currentQuote?.w52_hgpr ?? null,
        w52_lwpr: currentQuote?.w52_lwpr ?? null,
        return_1d: null, return_5d: null, return_20d: null, volatility_20d: null, quote_is_stale: false 
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
      const { data: { session: retrySession }, error: refreshError } = await supabase.auth.refreshSession();
      
      if (refreshError || !retrySession) {
        const { data: { session: lastSession } } = await supabase.auth.getSession();
        if (lastSession && lastSession.access_token !== session.access_token) {
          res = await fetch('/api/analyze', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${lastSession.access_token}` }, body: JSON.stringify(payload) });
        } else {
          alert('세션이 만료되었습니다. 다시 로그인해 주세요.');
          await supabase.auth.signOut();
          return;
        }
      } else {
        res = await fetch('/api/analyze', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${retrySession.access_token}` }, body: JSON.stringify(payload) });
      }
    }

    const data = await res.json(); 
    if (!res.ok) throw new Error(data.error || '분석에 실패했습니다.');
    
    analysisCache.set(ticker, data);
    
    if (targetType === 'main') {
      renderAnalysisResult(data, true); 
    } else {
      renderInlineAnalysisResult(data, cardElement, true);
    }
  } catch (err) { 
    alert(err.message || '분석에 실패했습니다.'); 
  }
  finally { 
    btn.disabled = false; btn.textContent = originalText; 
    if (targetType === 'main') {
      isAnalyzingMain = false;
      pendingAnalysisTicker = null;
    }
  }
}

// ★ 메인 분석 결과 렌더링 (인라인 스타일 통일)
function renderAnalysisResult(data, scrollTo = true) {
  $('#analysis-result').hidden = false;
  const badge = $('#recommendation-badge'); badge.textContent = data.recommendation || '판단 보류'; badge.className = 'recommendation-badge';
  const rec = data.recommendation || '';
  if (rec.includes('매수')) badge.classList.add('recommendation-badge--buy');
  else if (rec.includes('매도')) badge.classList.add('recommendation-badge--sell');
  else if (rec.includes('기다리기') || rec.includes('보유')) badge.classList.add('recommendation-badge--hold');
  else badge.classList.add('recommendation-badge--pending');
  $('#analysis-timestamp').textContent = `분석 시각: ${formatDateTime(new Date().toISOString())}`;
  $('#overall-summary').textContent = data.overall_summary || '-';
  $('#price-flow-summary').textContent = data.price_flow_summary || '-';
  $('#volume-summary').textContent = data.volume_summary || '-';
  $('#news-summary').textContent = data.news_summary || '-';
  
  $('#ai-fallback-note').hidden = !data.fallback;
  if (data.fallback && data.debug) console.warn('AI Fallback 발생 원인:', data.debug);
  
  renderNewsList(data.sources || []);
  
  if (scrollTo) {
    $('#analysis-result').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function renderInlineAnalysisResult(data, cardElement, scrollTo = true) {
  const container = cardElement.querySelector('.holding-inline-result');
  if (!container) return;
  container.hidden = false;

  const rec = data.recommendation || '판단 보류';
  let badgeClass = 'recommendation-badge--pending';
  if (rec.includes('매수')) badgeClass = 'recommendation-badge--buy';
  else if (rec.includes('매도')) badgeClass = 'recommendation-badge--sell';
  else if (rec.includes('기다리기') || rec.includes('보유')) badgeClass = 'recommendation-badge--hold';

  container.innerHTML = `
    <div class="analysis-head">
      <div class="recommendation-badge ${badgeClass}">${rec}</div>
      <div class="analysis-timestamp">${formatDateTime(new Date().toISOString())}</div>
    </div>
    <p class="overall-summary" style="font-size:14px; margin-bottom:8px;">${data.overall_summary || '-'}</p>
    
    <div style="font-size:13px; line-height:1.6; color:var(--text);">
      <p><strong>가격 분석:</strong> ${data.price_flow_summary || '-'}</p>
      <p><strong>거래량 분석:</strong> ${data.volume_summary || '-'}</p>
      <p><strong>최근 뉴스:</strong> ${data.news_summary || '-'}</p>
    </div>
    ${data.fallback ? `<p class="note-text" style="font-size:11px; margin-top:8px;">AI 일일 한도 초과로 기본 분석을 표시합니다.</p>` : ''}
  `;
  
  if (scrollTo) {
    container.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function renderNewsList(sources) {
  const list = $('#news-list'); list.innerHTML = '';
  if (!Array.isArray(sources) || sources.length === 0) { 
    const li = document.createElement('li'); 
    li.className = 'note-text'; 
    li.textContent = '표시할 뉴스/공시가 없습니다.'; 
    list.appendChild(li); 
    return; 
  }
  sources.slice(0, 5).forEach((item) => {
    const li = document.createElement('li');
    if (item.url) { 
      const a = document.createElement('a'); a.className = 'news-title'; a.href = item.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = item.title || '제목 없음'; li.appendChild(a); 
    }
    else { 
      const span = document.createElement('span'); span.className = 'news-title'; span.textContent = item.title || '제목 없음'; li.appendChild(span); 
    }
    list.appendChild(li);
  });
}

function computeHoldings(txs) {
  const map = new Map(); let totalRealizedPnl = 0, totalRealizedCost = 0;
  for (const tx of txs) {
    if (!map.has(tx.ticker)) { map.set(tx.ticker, { ticker: tx.ticker, stock_name: tx.stock_name, qty: 0, avgCost: 0, totalCost: 0, transactions: [] }); }
    const h = map.get(tx.ticker); h.transactions.push(tx);
    const q = Number(tx.quantity), p = Number(tx.unit_price);
    if (tx.transaction_type === 'BUY') { h.totalCost += q * p; h.qty += q; h.avgCost = h.qty > 0 ? h.totalCost / h.qty : 0; }
    else if (tx.transaction_type === 'SELL') {
      const sellQty = Math.min(q, h.qty); const costOfSold = sellQty * h.avgCost; const revenue = sellQty * p;
      totalRealizedPnl += (revenue - costOfSold); totalRealizedCost += costOfSold;
      h.totalCost -= costOfSold; h.qty -= sellQty; h.avgCost = h.qty > 0 ? h.totalCost / h.qty : 0;
    }
  }
  return { currentHoldings: Array.from(map.values()).filter((h) => h.qty > 0), totalRealizedPnl, totalRealizedCost };
}

function renderHoldingsSummary(holdingsData, totalCost, totalCurrentValue) {
  const { totalRealizedPnl, totalRealizedCost } = holdingsData;
  const unrealizedPnl = totalCurrentValue - totalCost; const unrealizedRate = totalCost > 0 ? (unrealizedPnl / totalCost) * 100 : 0;
  const realizedRate = totalRealizedCost > 0 ? (totalRealizedPnl / totalRealizedCost) * 100 : 0;
  $('#total-cost').textContent = formatCurrency(totalCost);
  $('#total-value').innerHTML = `${formatCurrency(totalCurrentValue)} <span class="summary-rate ${unrealizedRate > 0 ? 'positive' : unrealizedRate < 0 ? 'negative' : ''}">(${unrealizedRate > 0 ? '+' : ''}${unrealizedRate.toFixed(2)}%)</span>`;
  $('#total-pnl').innerHTML = `<span class="${unrealizedPnl > 0 ? 'positive' : unrealizedPnl < 0 ? 'negative' : ''}">${formatCurrency(unrealizedPnl)} (${unrealizedRate > 0 ? '+' : ''}${unrealizedRate.toFixed(2)}%)</span>`;
  $('#realized-pnl').innerHTML = `<span class="${totalRealizedPnl > 0 ? 'positive' : totalRealizedPnl < 0 ? 'negative' : ''}">${formatCurrency(totalRealizedPnl)} (${realizedRate > 0 ? '+' : ''}${realizedRate.toFixed(2)}%)</span>`;
}

function renderHoldingsList(holdings, priceMap) {
  const list = $('#holdings-list'); list.innerHTML = '';
  if (holdings.length === 0) { const p = document.createElement('p'); p.className = 'empty-text'; p.textContent = '아직 등록된 거래가 없습니다.'; list.appendChild(p); return; }
  
  holdings.forEach((h) => {
    const currentPrice = priceMap.get(h.ticker) || h.avgCost;
    const valuation = currentPrice * h.qty;
    const pnl = valuation - h.totalCost;
    const returnRate = h.totalCost > 0 ? (pnl / h.totalCost) * 100 : 0;
    const pnlClass = pnl > 0 ? 'positive' : pnl < 0 ? 'negative' : '';

    const card = document.createElement('div'); card.className = 'holding-card';
    card.setAttribute('data-ticker', h.ticker);
    card.style.borderColor = getBorderColor(h.ticker);
    card.style.borderWidth = '2px';
    
    const header = document.createElement('div'); header.className = 'holding-header';
    const nameEl = document.createElement('h3'); nameEl.className = 'holding-name'; nameEl.textContent = h.stock_name;
    const qtyEl = document.createElement('span'); qtyEl.className = 'holding-qty'; qtyEl.textContent = `${formatNumber(h.qty)}주`;
    header.appendChild(nameEl); header.appendChild(qtyEl); card.appendChild(header);

    const grid = document.createElement('div'); grid.className = 'holding-grid';
    grid.innerHTML = `
      <div class="holding-data"><span class="dt">매수 원가</span><span class="dd">${formatCurrency(h.totalCost)}</span></div>
      <div class="holding-data"><span class="dt">평가 금액</span><span class="dd">${formatCurrency(valuation)}</span></div>
      <div class="holding-data"><span class="dt">평균 매수가</span><span class="dd">${formatCurrency(h.avgCost)}</span></div>
      <div class="holding-data"><span class="dt">현재가</span><span class="dd">${formatCurrency(currentPrice)}</span></div>
      <div class="holding-data"><span class="dt">평가 손익</span><span class="dd ${pnlClass}">${formatCurrency(pnl)}</span></div>
      <div class="holding-data"><span class="dt">수익률</span><span class="dd ${pnlClass}">${returnRate > 0 ? '+' : ''}${returnRate.toFixed(2)}%</span></div>
    `;
    card.appendChild(grid);

    const actionRow = document.createElement('div');
    actionRow.className = 'holding-actions';
    
    const aiBtn = document.createElement('button');
    aiBtn.type = 'button';
    aiBtn.className = 'btn btn--primary btn--half btn-ai-analyze';
    aiBtn.textContent = 'AI 분석하기';
    aiBtn.addEventListener('click', () => runAnalysis(h.ticker, h.stock_name, currentPrice, 'inline', card));
    actionRow.appendChild(aiBtn);

    const toggle = document.createElement('button'); 
    toggle.type = 'button'; 
    toggle.className = 'tx-toggle btn--half'; 
    toggle.setAttribute('aria-expanded', 'false'); 
    toggle.textContent = `거래 내역 (${h.transactions.length}건)`; 
    actionRow.appendChild(toggle);
    
    card.appendChild(actionRow);

    const inlineResult = document.createElement('div');
    inlineResult.className = 'holding-inline-result';
    inlineResult.hidden = true;
    card.appendChild(inlineResult);
    
    if (analysisCache.has(h.ticker)) {
      renderInlineAnalysisResult(analysisCache.get(h.ticker), card, false);
    }

    const txList = document.createElement('div'); txList.className = 'tx-list'; txList.hidden = true; h.transactions.forEach((tx) => { txList.appendChild(renderTransactionRow(tx)); }); card.appendChild(txList);
    
    toggle.addEventListener('click', () => { const expanded = toggle.getAttribute('aria-expanded') === 'true'; toggle.setAttribute('aria-expanded', String(!expanded)); txList.hidden = expanded; toggle.textContent = expanded ? `거래 내역 (${h.transactions.length}건)` : '거래 내역 숨기기'; });
    list.appendChild(card);
  });
}

function renderTransactionRow(tx) {
  const row = document.createElement('div'); row.className = 'tx-row'; const main = document.createElement('div'); main.className = 'tx-main';
  const typeClass = tx.transaction_type === 'BUY' ? 'tx-type-buy' : 'tx-type-sell'; const typeLabel = tx.transaction_type === 'BUY' ? '매수' : '매도';
  main.innerHTML = `<div><span class="${typeClass}">${typeLabel}</span> ${formatNumber(tx.quantity)}주 × ${formatCurrency(tx.unit_price)}</div><div class="tx-date">${escapeHtml(tx.trade_date)}</div>`; row.appendChild(main);
  const actions = document.createElement('div'); actions.className = 'tx-actions';
  const editBtn = document.createElement('button'); editBtn.type = 'button'; editBtn.className = 'tx-action-btn'; editBtn.textContent = '수정'; editBtn.addEventListener('click', () => editTransaction(tx.id)); actions.appendChild(editBtn);
  const delBtn = document.createElement('button'); delBtn.type = 'button'; delBtn.className = 'tx-action-btn tx-action-btn--danger'; delBtn.textContent = '삭제'; delBtn.addEventListener('click', () => deleteTransaction(tx.id)); actions.appendChild(delBtn);
  row.appendChild(actions); return row;
}

function setupTransactionForm() { $('#transaction-form').addEventListener('submit', (e) => { e.preventDefault(); saveTransaction(); }); $('#tx-cancel-btn').addEventListener('click', resetTxForm); }
function setTxFormMode(tx) { editingTxId = tx?.id || null; $('#tx-id').value = tx?.id || ''; $('#tx-form-title').textContent = tx ? '거래 수정' : '거래 등록'; $('#tx-submit-btn').textContent = tx ? '수정 저장' : '거래 저장'; $('#tx-cancel-btn').hidden = !tx; }
function resetTxForm() { $('#transaction-form').reset(); $('#tx-id').value = ''; $('#tx-error').hidden = true; setTxFormMode(null); }
function showTxError(msg) { const el = $('#tx-error'); el.textContent = msg; el.hidden = false; }

async function saveTransaction() {
  $('#tx-error').hidden = true;
  const { data: { session } } = await supabase.auth.getSession(); if (!session) return showTxError('로그인이 필요합니다.');
  const rawName = $('#tx-stock-name').value.trim(), type = $('#tx-type').value, tradeDate = $('#tx-date').value;
  const price = parseFloat($('#tx-price').value), qty = parseFloat($('#tx-qty').value);
  if (!rawName) return showTxError('종목명을 입력하세요.'); if (!tradeDate) return showTxError('거래일을 입력하세요.');
  if (!(price > 0) || !(qty > 0)) return showTxError('단가와 수량은 0보다 커야 합니다.');
  const btn = $('#tx-submit-btn'); btn.disabled = true; btn.textContent = '종목 확인 중…';
  try {
    const nameOnly = rawName.replace(/\(.*?\)/g, '').trim();
    const res = await fetch(`/api/quote?ticker=${encodeURIComponent(nameOnly)}`); const qData = await res.json();
    if (!res.ok) throw new Error(qData.error || '종목을 찾을 수 없습니다.');
    const payload = { user_id: session.user.id, ticker: qData.ticker, stock_name: qData.stock_name || nameOnly, transaction_type: type, trade_date: tradeDate, unit_price: price, quantity: qty };
    if (type === 'SELL') { const ok = await canSell(payload.ticker, qty, editingTxId); if (!ok) throw new Error('매도 수량이 현재 보유 수량보다 많습니다.'); }
    btn.textContent = editingTxId ? '수정 중…' : '저장 중…'; let error;
    if (editingTxId) { const { user_id, ...updateFields } = payload; ({ error } = await supabase.from('stock_transactions').update(updateFields).eq('id', editingTxId).eq('user_id', session.user.id)); }
    else { ({ error } = await supabase.from('stock_transactions').insert(payload)); }
    if (error) throw error; resetTxForm(); await loadHoldings();
  } catch (err) { showTxError(err.message || '거래 저장에 실패했습니다.'); }
  finally { btn.disabled = false; btn.textContent = editingTxId ? '수정 저장' : '거래 저장'; }
}

async function canSell(ticker, quantity, excludeId = null) {
  const { data, error } = await supabase.from('stock_transactions').select('id, transaction_type, quantity').eq('ticker', ticker);
  if (error) return false; let net = 0;
  for (const tx of data || []) { if (excludeId && tx.id === excludeId) continue; if (tx.transaction_type === 'BUY') net += Number(tx.quantity); else net -= Number(tx.quantity); }
  return quantity <= net + 1e-9;
}

async function editTransaction(id) {
  const { data: { session } } = await supabase.auth.getSession(); if (!session) return;
  const { data, error } = await supabase.from('stock_transactions').select('*').eq('id', id).eq('user_id', session.user.id).single();
  if (error || !data) { alert('거래를 불러올 수 없습니다.'); return; }
  $('#tx-stock-name').value = data.stock_name; $('#tx-type').value = data.transaction_type; $('#tx-date').value = data.trade_date; $('#tx-price').value = data.unit_price; $('#tx-qty').value = data.quantity;
  setTxFormMode(data); $('#tx-form-title').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function deleteTransaction(id) {
  if (!confirm('이 거래를 삭제하시겠습니까?')) return;
  const { data: { session } } = await supabase.auth.getSession(); if (!session) return;
  const { error } = await supabase.from('stock_transactions').delete().eq('id', id).eq('user_id', session.user.id);
  if (error) { alert('삭제에 실패했습니다: ' + error.message); return; } await loadHoldings();
}

function formatNumber(n) { return Number(n).toLocaleString('ko-KR', { maximumFractionDigits: 6 }); }
function formatCurrency(n) { return Number(n).toLocaleString('ko-KR', { maximumFractionDigits: 0 }) + '원'; }
function formatDateTime(iso) { if (!iso) return '-'; const d = new Date(iso); return d.toLocaleString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); }
function escapeHtml(str) { if (str == null) return ''; return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

init();