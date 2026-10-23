// assets/app.js
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const SUPABASE_URL = 'https://hexykwjjkkozbeaqziem.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhleHlrd2pqa2tvemJlYXF6aWVtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE3OTk0MzUsImV4cCI6MjEwNzM3NTQzNX0.r4m4TY8dkkb19PKmMqdDH3_SicTUpt2DoXeDVSE1M3g';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});

const ALLOWED_NAMES = ['박필립', '윤혜영'];
const BATCH_ALLOWED_USER = '박필립';
const BATCH_TOP_COUNT = 10;
const BATCH_RANDOM_COUNT = 10;
const BATCH_DELAY_MS = 2500;
const HIDDEN_POLL_MS = 1000;

let currentUser = null, currentQuote = null, transactions = [], editingTxId = null;
let currentScreen = 'holdings';
let countdown = 5, countdownInterval = null, isRefreshing = false;
let isAnalyzingMain = false;
let isBatching = false;
let lastSessionUserId = null; // ★ 중복 초기화 방지용

const priceCache = new Map();
const analysisCache = new Map();

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const BORDER_COLORS = ['#ef4444', '#f97316', '#f59e0b', '#84cc16', '#10b981', '#06b6d4', '#3b82f6', '#6366f1', '#8b5cf6', '#d946ef', '#ec4899', '#f43f5e'];
function getBorderColor(ticker) {
  if (!ticker || typeof ticker !== 'string') return '#9ca3af'; // ★ 방어 코드
  let hash = 0;
  for (let i = 0; i < ticker.length; i++) hash = ticker.charCodeAt(i) + ((hash << 5) - hash);
  return BORDER_COLORS[Math.abs(hash) % BORDER_COLORS.length];
}

async function init() {
  renderLoginButtons(); setupLogoutButton(); setupRefreshButton(); setupNavigation();
  setupSearch(); setupAnalyze(); setupTransactionForm(); setupVisibility(); setupBatchButton();

  supabase.auth.onAuthStateChange((_event, session) => handleAuthState(session));
  const { data: { session } } = await supabase.auth.getSession();
  handleAuthState(session);
}

async function handleAuthState(session) {
  const newUserId = session?.user?.id || null;
  
  // ★ 동일 세션으로 중복 호출되는 것 방지 (Race Condition 해결)
  if (newUserId === lastSessionUserId) {
    return;
  }
  lastSessionUserId = newUserId;
  currentUser = session?.user || null;

  if (currentUser) {
    $('#screen-login').hidden = true; $('#app-shell').hidden = false;
    const name = mapEmailToName(currentUser.email) || currentUser.email || '';
    $('#current-user-name').textContent = name;

    const batchBtn = $('#batch-build-btn');
    if (batchBtn) batchBtn.hidden = (name !== BATCH_ALLOWED_USER);

    switchScreen('holdings');
    updateMarketStatusBadge(getMarketStatusClient());
    
    // 데이터 로드
    await loadHoldings();
    
    startCountdown();
  } else {
    $('#screen-login').hidden = false; $('#app-shell').hidden = true;
    resetState(); stopCountdown();
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
  isAnalyzingMain = false; isBatching = false;
  $('#quote-card').hidden = true; $('#analysis-result').hidden = true;
  $('#ticker-input').value = ''; $('#search-error').hidden = true;
  $('#transaction-form').reset(); $('#tx-id').value = ''; $('#tx-error').hidden = true;
  setTxFormMode(null); $('#holdings-list').innerHTML = '<p class="empty-text">아직 등록된 거래가 없습니다.</p>';
  const w = document.getElementById('over-sell-warning'); if (w) w.remove();
  ['#total-cost', '#total-value', '#total-pnl', '#realized-pnl'].forEach((id) => { $(id).textContent = '-'; });
  $$('.login-name-btn').forEach((b) => (b.disabled = false));
  $('#login-error').hidden = true; $('#login-loading').hidden = true;
  const dataBadge = $('#data-status-badge');
  dataBadge.textContent = '데이터 상태 확인 중';
  dataBadge.className = 'badge badge--muted';
  const batchBtn = $('#batch-build-btn');
  if (batchBtn) {
    batchBtn.hidden = true;
    batchBtn.disabled = false;
    batchBtn.textContent = '이력 쌓기';
  }
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

function setupLogoutButton() {
  $('#logout-btn').addEventListener('click', async () => {
    if (isBatching) { alert('이력 쌓기가 진행 중입니다. 완료 후 로그아웃해 주세요.'); return; }
    if (!confirm('로그아웃하시겠습니까?')) return;
    stopCountdown(); await supabase.auth.signOut();
  });
}

function startCountdown() {
  stopCountdown(); countdown = 5; updateRefreshButton();
  countdownInterval = setInterval(() => {
    if (document.hidden) return;
    if (countdown > 0) countdown--;
    if (countdown === 0) { clearInterval(countdownInterval); countdownInterval = null; }
    updateRefreshButton();
  }, 1000);
}

function stopCountdown() {
  if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
  updateRefreshButton();
}

function updateRefreshButton() {
  const btn = $('#refresh-btn'); if (!btn) return;
  if (isRefreshing) { btn.textContent = '새로고침 중...'; btn.disabled = true; }
  else if (countdown > 0) { btn.textContent = `새로고침 (${countdown})`; btn.disabled = true; }
  else { btn.textContent = '새로고침'; btn.disabled = false; }
}

function setupRefreshButton() {
  $('#refresh-btn').addEventListener('click', async () => {
    if (isRefreshing || countdown > 0 || isBatching) return;
    isRefreshing = true; stopCountdown(); updateRefreshButton();
    try { await performRefresh(); } finally { isRefreshing = false; startCountdown(); }
  });
}

async function performRefresh() {
  if (currentScreen === 'analysis') { if (currentQuote) await refreshQuoteSilently(currentQuote.ticker); }
  else if (currentScreen === 'holdings') { await refreshHoldingsView(); }
}

function setupVisibility() { document.addEventListener('visibilitychange', () => updateRefreshButton()); }

function getMarketStatusClient() {
  const now = new Date(); const kstTime = new Date(now.getTime() + 9 * 60 * 60 * 1000);
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
  else if (statusText.includes('애프터마켓') || statusText.includes('시간외')) badge.className = 'badge badge--status-blue';
  else badge.className = 'badge badge--status-gray';
}

function updateDataStatusBadge(status) {
  const badge = $('#data-status-badge');
  if (status === 'LATEST' || status === 'OK' || status === 'MARKET_OPEN') {
    badge.textContent = '연결 원활';
    badge.className = 'badge badge--status-green';
  } else if (status === 'AFTER_HOURS') {
    badge.textContent = '시간외 단일가';
    badge.className = 'badge badge--status-blue';
  } else if (status === 'AFTER_MARKET') {
    badge.textContent = '애프터마켓';
    badge.className = 'badge badge--status-blue';
  } else if (status === 'DELAYED') {
    badge.textContent = '지연';
    badge.className = 'badge badge--status-orange';
  } else if (status === 'STALE') {
    badge.textContent = '오래된 데이터';
    badge.className = 'badge badge--status-orange';
  } else if (status === 'MARKET_CLOSED') {
    badge.textContent = '장마감';
    badge.className = 'badge badge--status-gray';
  } else if (status === 'UNKNOWN') {
    badge.textContent = '상태 확인 불가';
    badge.className = 'badge badge--status-gray';
  } else {
    badge.textContent = '연결 끊김';
    badge.className = 'badge badge--status-gray';
  }
}

function switchScreen(target) {
  currentScreen = target;
  $$('.nav-btn').forEach((b) => b.classList.toggle('nav-btn--active', b.dataset.screen === target));
  $('#screen-analysis').classList.toggle('screen--active', target === 'analysis');
  $('#screen-holdings').classList.toggle('screen--active', target === 'holdings');
  if (target === 'analysis') {
    restoreAnalysisResults();
    if (isAnalyzingMain) { $('#analyze-btn').disabled = true; $('#analyze-btn').textContent = '분석 중…'; }
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
        if (inlineResult) renderInlineAnalysisResult(analysisCache.get(tx.ticker), card, false);
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
        renderOverSellWarning(holdingsData.overSells || []);
      }
    });
  });
}

function setupSearch() {
  $('#search-btn').addEventListener('click', handleSearch);
  $('#ticker-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') handleSearch(); });
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
    currentQuote = data;
    if (data.price > 0) priceCache.set(data.ticker, data.price);
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

  if (analysisCache.has(q.ticker)) {
    renderAnalysisResult(analysisCache.get(q.ticker), false);
  } else {
    $('#analysis-result').hidden = true;
  }
}

async function refreshQuoteSilently(ticker) {
  try {
    const res = await fetch(`/api/quote?ticker=${encodeURIComponent(ticker)}`);
    if (!res.ok) { updateDataStatusBadge('ERROR'); return; }
    const data = await res.json();
    if (currentQuote?.ticker === ticker) {
      if (data.price > 0) priceCache.set(ticker, data.price);
      currentQuote = data;
      renderQuote(data);
      updateMarketStatusBadge(data.market_status);
      updateDataStatusBadge(data.data_status);
    }
  } catch { updateDataStatusBadge('ERROR'); }
}

async function loadHoldings() {
  if (!currentUser) return;
  // ★ session에서 user_id를 명시적으로 필터링하여 RLS 의존성 제거
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return;

  const { data, error } = await supabase
    .from('stock_transactions')
    .select('*')
    .eq('user_id', session.user.id)
    .order('trade_date', { ascending: true })
    .order('created_at', { ascending: true });

  if (error) { 
    console.error('loadHoldings error:', error.message); 
    // 에러 발생 시 화면에 안내 (기존 데이터 유지)
    return; 
  }
  
  transactions = data || [];
  await refreshHoldingsView();
}

async function refreshHoldingsView(holdingsData) {
  if (!holdingsData) holdingsData = computeHoldings(transactions);
  const { currentHoldings, overSells } = holdingsData;

  renderOverSellWarning(overSells || []);

  let totalCost = 0, totalCurrentValue = 0;
  const currentPriceMap = new Map();
  
  if (currentHoldings.length === 0) {
    renderHoldingsList([], currentPriceMap);
    renderHoldingsSummary(holdingsData, 0, 0);
    return;
  }

  let anySuccess = false;
  let lastSuccessfulStatus = null;

  for (const h of currentHoldings) {
    totalCost += h.totalCost;
    let price = null;
    try {
      const res = await fetch(`/api/quote?ticker=${h.ticker}`);
      if (res.ok) {
        const q = await res.json();
        anySuccess = true;
        lastSuccessfulStatus = q.data_status;
        if (currentPriceMap.size === 0) updateMarketStatusBadge(q.market_status);
        if (q.price != null && q.price > 0) { price = q.price; priceCache.set(h.ticker, q.price); }
      } else {
        // ★ 502 등 실패 시 로깅
        console.warn(`[refreshHoldingsView] quote ${h.ticker} failed: HTTP ${res.status}`);
      }
    } catch (e) { 
      console.warn(`[refreshHoldingsView] quote ${h.ticker} exception:`, e.message);
    }

    if (price == null) price = priceCache.get(h.ticker) || null;

    currentPriceMap.set(h.ticker, price);
    totalCurrentValue += (price || h.avgCost) * h.qty;
    await new Promise(r => setTimeout(r, 500));
  }

  if (anySuccess && lastSuccessfulStatus) updateDataStatusBadge(lastSuccessfulStatus);

  renderHoldingsList(currentHoldings, currentPriceMap);
  renderHoldingsSummary(holdingsData, totalCost, totalCurrentValue);
}

function renderOverSellWarning(overSells) {
  const existing = document.getElementById('over-sell-warning');
  if (existing) existing.remove();
  if (!overSells || overSells.length === 0) return;

  const warn = document.createElement('div');
  warn.id = 'over-sell-warning';
  warn.style.cssText = 'background:#fef3c7;border:1px solid #f59e0b;border-radius:12px;padding:12px;margin-bottom:12px;font-size:12px;color:#92400e;line-height:1.5;';

  const title = document.createElement('div');
  title.style.fontWeight = '700';
  title.style.marginBottom = '6px';
  title.textContent = `⚠️ 초과 매도 거래 ${overSells.length}건 감지`;
  warn.appendChild(title);

  const desc = document.createElement('div');
  desc.style.fontSize = '11px';
  desc.style.marginBottom = '8px';
  desc.textContent = '매도 시점에 보유 수량이 부족한 거래가 있습니다. 손익이 부정확하므로 해당 거래를 수정하거나 삭제해 주세요.';
  warn.appendChild(desc);

  overSells.forEach(o => {
    const line = document.createElement('div');
    line.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:8px;padding:4px 0;border-top:1px solid #fcd34d;';
    const text = document.createElement('span');
    text.textContent = `${o.stock_name}(${o.trade_date}): ${o.attempted}주 매도 / 보유 ${o.available}주`;
    line.appendChild(text);

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.style.cssText = 'background:#fff;border:1px solid #92400e;border-radius:6px;padding:2px 8px;font-size:11px;color:#92400e;cursor:pointer;white-space:nowrap;';
    editBtn.textContent = '수정';
    editBtn.addEventListener('click', () => {
      switchScreen('holdings');
      editTransaction(o.tx_id);
    });
    line.appendChild(editBtn);

    warn.appendChild(line);
  });

  const summaryCard = document.querySelector('#screen-holdings .card');
  if (summaryCard && summaryCard.parentNode) {
    summaryCard.parentNode.insertBefore(warn, summaryCard);
  }
}

function setupAnalyze() {
  $('#analyze-btn').addEventListener('click', () => runAnalysis(currentQuote?.ticker, currentQuote?.stock_name, currentQuote?.price, 'main'));
}

async function runAnalysis(ticker, name, price, targetType = 'main', cardElement = null) {
  if (!ticker) return;
  const isSilent = targetType === 'batch';

  let btn = null;
  let originalText = '';
  if (!isSilent) {
    btn = targetType === 'main' ? $('#analyze-btn') : cardElement.querySelector('.btn-ai-analyze');
    originalText = btn.textContent;
    btn.disabled = true; btn.textContent = '분석 중…';
    if (targetType === 'main') { isAnalyzingMain = true; $('#analysis-result').hidden = true; }
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
    const txForTicker = transactions.filter(t => t.ticker === ticker);
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
    analysisCache.set(ticker, data);

    if (isSilent) {
      // 배치 모드: UI 렌더링 없이 캐시만 저장
    } else if (targetType === 'main') {
      renderAnalysisResult(data, currentScreen === 'analysis');
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
      if (targetType === 'main') isAnalyzingMain = false;
    }
  }
}

function setupBatchButton() {
  const btn = $('#batch-build-btn');
  if (!btn) return;
  btn.addEventListener('click', runBatchAnalysis);
}

async function waitWhileHidden(btn, currentIdx, total) {
  while (document.hidden) {
    btn.textContent = `일시정지 중 (탭 복귀 시 재개) ${currentIdx}/${total}`;
    await new Promise(r => setTimeout(r, HIDDEN_POLL_MS));
  }
}

async function runBatchAnalysis() {
  const userName = mapEmailToName(currentUser?.email);
  if (userName !== BATCH_ALLOWED_USER) {
    alert(`${BATCH_ALLOWED_USER} 계정에서만 사용할 수 있습니다.`);
    return;
  }
  if (isBatching) return;

  const btn = $('#batch-build-btn');
  const originalText = btn.textContent;

  isBatching = true;
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

    const topN = items.slice(0, Math.min(BATCH_TOP_COUNT, items.length));
    const pool = items.slice(BATCH_TOP_COUNT);
    const shuffled = [...pool].sort(() => Math.random() - 0.5);
    const randomN = shuffled.slice(0, Math.min(BATCH_RANDOM_COUNT, shuffled.length));

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
        await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
      }
    }

    btn.textContent = `완료 (성공 ${succeeded} / 실패 ${failed})`;
    await new Promise(r => setTimeout(r, 4000));
  } catch (err) {
    console.error('[batch] error:', err);
    alert(err.message || '이력 쌓기에 실패했습니다.');
  } finally {
    isBatching = false;
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

  if (scrollTo && currentScreen === 'analysis') $('#analysis-result').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderInlineAnalysisResult(data, cardElement, scrollTo = true) {
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

function computeHoldings(txs) {
  const map = new Map();
  let totalRealizedPnl = 0, totalRealizedCost = 0;
  const overSells = [];
  const overSellTickers = new Set();

  const sorted = [...txs].sort((a, b) => {
    const da = a.trade_date || '';
    const db = b.trade_date || '';
    if (da !== db) return da < db ? -1 : 1;
    return (a.created_at || '').localeCompare(b.created_at || '');
  });

  for (const tx of sorted) {
    // ★ ticker나 stock_name이 없는 비정상 데이터 방어
    if (!tx.ticker || typeof tx.ticker !== 'string' || !tx.stock_name) {
      console.warn('[computeHoldings] invalid transaction skipped:', tx);
      continue;
    }

    if (!map.has(tx.ticker)) {
      map.set(tx.ticker, {
        ticker: tx.ticker, stock_name: tx.stock_name,
        qty: 0, avgCost: 0, totalCost: 0, transactions: [],
        hasOverSell: false,
      });
    }
    const h = map.get(tx.ticker);
    h.transactions.push(tx);
    const q = Number(tx.quantity), p = Number(tx.unit_price);

    if (tx.transaction_type === 'BUY') {
      h.totalCost += q * p;
      h.qty += q;
      h.avgCost = h.qty > 0 ? h.totalCost / h.qty : 0;
    } else if (tx.transaction_type === 'SELL') {
      if (q > h.qty + 1e-9) {
        overSells.push({
          tx_id: tx.id,
          ticker: tx.ticker,
          stock_name: tx.stock_name,
          trade_date: tx.trade_date,
          attempted: q,
          available: h.qty,
        });
        h.hasOverSell = true;
        overSellTickers.add(tx.ticker);
      }
      const sellQty = Math.min(q, h.qty);
      const costOfSold = sellQty * h.avgCost;
      const revenue = sellQty * p;
      totalRealizedPnl += (revenue - costOfSold);
      totalRealizedCost += costOfSold;
      h.totalCost -= costOfSold;
      h.qty -= sellQty;
      h.avgCost = h.qty > 0 ? h.totalCost / h.qty : 0;
    }
  }

  return {
    currentHoldings: Array.from(map.values()).filter((h) => h.qty > 0),
    totalRealizedPnl, totalRealizedCost,
    overSells,
    overSellTickers: Array.from(overSellTickers),
    hasAnyOverSell: overSells.length > 0,
  };
}

function renderHoldingsSummary(holdingsData, totalCost, totalCurrentValue) {
  const { totalRealizedPnl, totalRealizedCost, hasAnyOverSell } = holdingsData;

  $('#total-cost').textContent = formatCurrency(totalCost);

  if (hasAnyOverSell) {
    $('#total-value').innerHTML = `<span style="color:#92400e;">산출 불가</span>`;
    $('#total-pnl').innerHTML = `<span style="color:#92400e;">산출 불가 (초과 매도)</span>`;
    $('#realized-pnl').innerHTML = `<span style="color:#92400e;">산출 불가 (초과 매도)</span>`;
    return;
  }

  const unrealizedPnl = totalCurrentValue - totalCost;
  const unrealizedRate = totalCost > 0 ? (unrealizedPnl / totalCost) * 100 : 0;
  const realizedRate = totalRealizedCost > 0 ? (totalRealizedPnl / totalRealizedCost) * 100 : 0;

  $('#total-value').innerHTML = `${formatCurrency(totalCurrentValue)} <span class="summary-rate ${unrealizedRate > 0 ? 'positive' : unrealizedRate < 0 ? 'negative' : ''}">(${unrealizedRate > 0 ? '+' : ''}${unrealizedRate.toFixed(2)}%)</span>`;
  $('#total-pnl').innerHTML = `<span class="${unrealizedPnl > 0 ? 'positive' : unrealizedPnl < 0 ? 'negative' : ''}">${formatCurrency(unrealizedPnl)} (${unrealizedRate > 0 ? '+' : ''}${unrealizedRate.toFixed(2)}%)</span>`;
  $('#realized-pnl').innerHTML = `<span class="${totalRealizedPnl > 0 ? 'positive' : totalRealizedPnl < 0 ? 'negative' : ''}">${formatCurrency(totalRealizedPnl)} (${realizedRate > 0 ? '+' : ''}${realizedRate.toFixed(2)}%)</span>`;
}

function renderHoldingsList(holdings, priceMap) {
  const list = $('#holdings-list'); list.innerHTML = '';
  if (holdings.length === 0) {
    const p = document.createElement('p'); p.className = 'empty-text'; p.textContent = '아직 등록된 거래가 없습니다.';
    list.appendChild(p); return;
  }
  holdings.forEach((h) => {
    // ★ 렌더링 직전 데이터 방어 코드
    if (!h.ticker || !h.stock_name) {
      console.warn('[renderHoldingsList] invalid holding skipped:', h);
      return;
    }

    const cachedPrice = priceMap.get(h.ticker);
    const isFallback = cachedPrice == null || !Number.isFinite(cachedPrice) || cachedPrice <= 0;
    const currentPrice = isFallback ? h.avgCost : cachedPrice;

    const valuation = currentPrice * h.qty;
    const pnl = isFallback ? null : (valuation - h.totalCost);
    const returnRate = (isFallback || h.totalCost <= 0) ? null : (pnl / h.totalCost) * 100;
    const pnlClass = (pnl == null) ? '' : (pnl > 0 ? 'positive' : pnl < 0 ? 'negative' : '');

    const card = document.createElement('div');
    card.className = 'holding-card';
    card.setAttribute('data-ticker', h.ticker);
    card.style.borderColor = getBorderColor(h.ticker);
    card.style.borderWidth = '2px';

    const header = document.createElement('div'); header.className = 'holding-header';
    const nameEl = document.createElement('h3'); nameEl.className = 'holding-name'; nameEl.textContent = h.stock_name;
    const qtyEl = document.createElement('span'); qtyEl.className = 'holding-qty'; qtyEl.textContent = `${formatNumber(h.qty)}주`;
    header.appendChild(nameEl); header.appendChild(qtyEl); card.appendChild(header);

    const grid = document.createElement('div'); grid.className = 'holding-grid';
    const priceLabel = isFallback ? `${formatCurrency(currentPrice)} (대체가격)` : formatCurrency(currentPrice);
    const valuationLabel = isFallback ? `${formatCurrency(valuation)} (임시)` : formatCurrency(valuation);
    const pnlLabel = (pnl == null) ? '산출 불가' : formatCurrency(pnl);
    const returnLabel = (returnRate == null) ? '산출 불가' : `${returnRate > 0 ? '+' : ''}${returnRate.toFixed(2)}%`;

    grid.innerHTML = `
      <div class="holding-data"><span class="dt">매수 원가</span><span class="dd">${formatCurrency(h.totalCost)}</span></div>
      <div class="holding-data"><span class="dt">평가 금액</span><span class="dd">${valuationLabel}</span></div>
      <div class="holding-data"><span class="dt">평균 매수가</span><span class="dd">${formatCurrency(h.avgCost)}</span></div>
      <div class="holding-data"><span class="dt">현재가</span><span class="dd">${priceLabel}</span></div>
      <div class="holding-data"><span class="dt">평가 손익</span><span class="dd ${pnlClass}">${pnlLabel}</span></div>
      <div class="holding-data"><span class="dt">수익률</span><span class="dd ${pnlClass}">${returnLabel}</span></div>
    `;
    card.appendChild(grid);

    const actionRow = document.createElement('div'); actionRow.className = 'holding-actions';
    const aiBtn = document.createElement('button');
    aiBtn.type = 'button'; aiBtn.className = 'btn btn--primary btn--half btn-ai-analyze'; aiBtn.textContent = 'AI 분석하기';
    aiBtn.disabled = isFallback;
    if (isFallback) aiBtn.title = '현재가를 확인할 수 없어 분석할 수 없습니다.';
    aiBtn.addEventListener('click', () => runAnalysis(h.ticker, h.stock_name, currentPrice, 'inline', card));
    actionRow.appendChild(aiBtn);
    const toggle = document.createElement('button');
    toggle.type = 'button'; toggle.className = 'tx-toggle btn--half';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.textContent = `거래 내역 (${h.transactions.length}건)`;
    actionRow.appendChild(toggle);
    card.appendChild(actionRow);

    const inlineResult = document.createElement('div');
    inlineResult.className = 'holding-inline-result';
    inlineResult.hidden = true;
    card.appendChild(inlineResult);
    if (analysisCache.has(h.ticker)) renderInlineAnalysisResult(analysisCache.get(h.ticker), card, false);

    const txList = document.createElement('div');
    txList.className = 'tx-list'; txList.hidden = true;
    h.transactions.forEach((tx) => { txList.appendChild(renderTransactionRow(tx)); });
    card.appendChild(txList);

    toggle.addEventListener('click', () => {
      const expanded = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', String(!expanded));
      txList.hidden = expanded;
      toggle.textContent = expanded ? `거래 내역 (${h.transactions.length}건)` : '거래 내역 숨기기';
    });
    list.appendChild(card);
  });
}

function renderTransactionRow(tx) {
  const row = document.createElement('div'); row.className = 'tx-row';
  const main = document.createElement('div'); main.className = 'tx-main';
  const typeClass = tx.transaction_type === 'BUY' ? 'tx-type-buy' : 'tx-type-sell';
  const typeLabel = tx.transaction_type === 'BUY' ? '매수' : '매도';
  const qSpan = document.createElement('span'); qSpan.className = typeClass; qSpan.textContent = typeLabel;
  const detail = document.createElement('span'); detail.textContent = ` ${formatNumber(tx.quantity)}주 × ${formatCurrency(tx.unit_price)}`;
  const qLine = document.createElement('div');
  qLine.appendChild(qSpan); qLine.appendChild(detail);
  main.appendChild(qLine);
  const dateLine = document.createElement('div'); dateLine.className = 'tx-date'; dateLine.textContent = tx.trade_date || '-';
  main.appendChild(dateLine);
  row.appendChild(main);

  const actions = document.createElement('div'); actions.className = 'tx-actions';
  const editBtn = document.createElement('button');
  editBtn.type = 'button'; editBtn.className = 'tx-action-btn'; editBtn.textContent = '수정';
  editBtn.addEventListener('click', () => editTransaction(tx.id));
  actions.appendChild(editBtn);
  const delBtn = document.createElement('button');
  delBtn.type = 'button'; delBtn.className = 'tx-action-btn tx-action-btn--danger'; delBtn.textContent = '삭제';
  delBtn.addEventListener('click', () => deleteTransaction(tx.id));
  actions.appendChild(delBtn);
  row.appendChild(actions);
  return row;
}

function setupTransactionForm() {
  $('#transaction-form').addEventListener('submit', (e) => { e.preventDefault(); saveTransaction(); });
  $('#tx-cancel-btn').addEventListener('click', resetTxForm);
}
function setTxFormMode(tx) {
  editingTxId = tx?.id || null;
  $('#tx-id').value = tx?.id || '';
  $('#tx-form-title').textContent = tx ? '거래 수정' : '거래 등록';
  $('#tx-submit-btn').textContent = tx ? '수정 저장' : '거래 저장';
  $('#tx-cancel-btn').hidden = !tx;
}
function resetTxForm() {
  $('#transaction-form').reset();
  $('#tx-id').value = ''; $('#tx-error').hidden = true;
  setTxFormMode(null);
}
function showTxError(msg) { const el = $('#tx-error'); el.textContent = msg; el.hidden = false; }

async function saveTransaction() {
  $('#tx-error').hidden = true;
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return showTxError('로그인이 필요합니다.');
  const rawName = $('#tx-stock-name').value.trim(), type = $('#tx-type').value, tradeDate = $('#tx-date').value;
  const price = parseFloat($('#tx-price').value), qty = parseFloat($('#tx-qty').value);
  if (!rawName) return showTxError('종목명을 입력하세요.');
  if (!tradeDate) return showTxError('거래일을 입력하세요.');
  if (!Number.isFinite(price) || price <= 0) return showTxError('단가는 0보다 큰 숫자여야 합니다.');
  if (!Number.isFinite(qty) || qty <= 0) return showTxError('수량은 0보다 큰 숫자여야 합니다.');

  const btn = $('#tx-submit-btn'); btn.disabled = true; btn.textContent = '종목 확인 중…';
  try {
    const nameOnly = rawName.replace(/\(.*?\)/g, '').trim();
    const res = await fetch(`/api/quote?ticker=${encodeURIComponent(nameOnly)}`);
    const qData = await res.json();
    if (!res.ok) throw new Error(qData.error || '종목을 찾을 수 없습니다.');

    const normIn = nameOnly.replace(/\s+/g, '').toLowerCase();
    const normResolved = String(qData.stock_name || '').replace(/\s+/g, '').toLowerCase();
    if (normIn !== normResolved && !confirm(`'${nameOnly}' → ${qData.stock_name}(${qData.ticker})로 저장할까요?`)) {
      throw new Error('거래 저장을 취소했습니다.');
    }

    if (type === 'SELL') {
      const ok = await canSell(qData.ticker, qty, tradeDate, editingTxId);
      if (!ok) throw new Error(`${tradeDate} 시점의 보유 수량을 초과하는 매도입니다.`);
    }

    const payload = {
      user_id: session.user.id, ticker: qData.ticker,
      stock_name: qData.stock_name || nameOnly,
      transaction_type: type, trade_date: tradeDate,
      unit_price: price, quantity: qty,
    };

    btn.textContent = editingTxId ? '수정 중…' : '저장 중…';
    let error;
    if (editingTxId) {
      const { user_id, ...updateFields } = payload;
      ({ error } = await supabase.from('stock_transactions').update(updateFields).eq('id', editingTxId).eq('user_id', session.user.id));
    } else {
      ({ error } = await supabase.from('stock_transactions').insert(payload));
    }
    if (error) throw error;
    resetTxForm();
    await loadHoldings();
  } catch (err) { showTxError(err.message || '거래 저장에 실패했습니다.'); }
  finally { btn.disabled = false; btn.textContent = editingTxId ? '수정 저장' : '거래 저장'; }
}

async function canSell(ticker, quantity, sellDate, excludeId = null) {
  const { data, error } = await supabase
    .from('stock_transactions')
    .select('id, transaction_type, quantity, trade_date, created_at')
    .eq('ticker', ticker)
    .eq('user_id', currentUser?.id || '');
  if (error) return false;

  let excludeCreatedAt = null;
  if (excludeId) {
    const found = (data || []).find(tx => tx.id === excludeId);
    if (found) excludeCreatedAt = found.created_at;
  }

  let net = 0;
  for (const tx of data || []) {
    if (excludeId && tx.id === excludeId) continue;
    if (tx.trade_date < sellDate) { /* 이전 날짜: 항상 집계 */ }
    else if (tx.trade_date === sellDate) {
      if (excludeCreatedAt && tx.created_at && tx.created_at >= excludeCreatedAt) continue;
    } else { continue; }
    if (tx.transaction_type === 'BUY') net += Number(tx.quantity);
    else net -= Number(tx.quantity);
  }

  return quantity <= net + 1e-9;
}

async function editTransaction(id) {
  const { data: { session } } = await supabase.auth.getSession(); if (!session) return;
  const { data, error } = await supabase.from('stock_transactions').select('*').eq('id', id).eq('user_id', session.user.id).single();
  if (error || !data) { alert('거래를 불러올 수 없습니다.'); return; }
  $('#tx-stock-name').value = data.stock_name;
  $('#tx-type').value = data.transaction_type;
  $('#tx-date').value = data.trade_date;
  $('#tx-price').value = data.unit_price;
  $('#tx-qty').value = data.quantity;
  setTxFormMode(data);
  $('#tx-form-title').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function deleteTransaction(id) {
  if (!confirm('이 거래를 삭제하시겠습니까?')) return;
  const { data: { session } } = await supabase.auth.getSession(); if (!session) return;
  const { error } = await supabase.from('stock_transactions').delete().eq('id', id).eq('user_id', session.user.id);
  if (error) { alert('삭제에 실패했습니다: ' + error.message); return; }
  await loadHoldings();
}

function formatNumber(n) { return Number(n).toLocaleString('ko-KR', { maximumFractionDigits: 6 }); }
function formatCurrency(n) { return Number(n).toLocaleString('ko-KR', { maximumFractionDigits: 0 }) + '원'; }
function formatDateTime(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '-';
  return d.toLocaleString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

init();