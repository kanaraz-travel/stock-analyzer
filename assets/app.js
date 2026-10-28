// assets/app.js
import {
  supabase, state, $, $$,
  ALLOWED_NAMES, BATCH_ALLOWED_USER,
  getMarketStatusClient, updateMarketStatusBadge, updateDataStatusBadge,
  computeHoldings
} from './core.js';
import {
  initHoldings, loadHoldings, refreshHoldingsView,
  renderHoldingsList, renderHoldingsSummary, renderOverSellWarning
} from './holdings.js';
import { initSearch, refreshQuoteSilently } from './search.js';
import {
  initAnalysis,
  renderAnalysisResult, renderInlineAnalysisResult
} from './analysis.js';

let isLoggingOut = false;

async function init() {
  renderLoginButtons();
  setupLogoutButton();
  setupRefreshButton();
  setupNavigation();
  initHoldings();
  initSearch();
  initAnalysis();
  setupVisibility();

  supabase.auth.onAuthStateChange(async (event, session) => {
    console.log(`[Auth Event] ${event}`, session?.user?.email);
    if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION') await handleAuthState(session);
    else if (event === 'SIGNED_OUT') await handleAuthState(null);
  });

  const { data: { session } } = await supabase.auth.getSession();
  if (session && !state.currentUser) await handleAuthState(session);
}

async function handleAuthState(session) {
  const newUserId = session?.user?.id || null;
  if (newUserId === state.currentUser?.id && state.isInitDone) return;
  state.currentUser = session?.user || null;
  state.isInitDone = false;

  if (state.currentUser) {
    $('#screen-login').hidden = true; $('#app-shell').hidden = false;
    const name = mapEmailToName(state.currentUser.email) || state.currentUser.email || '';
    $('#current-user-name').textContent = name;
    const batchBtn = $('#batch-build-btn');
    if (batchBtn) batchBtn.hidden = (name !== BATCH_ALLOWED_USER);
    switchScreen('holdings');
    updateMarketStatusBadge(getMarketStatusClient());
    try { await loadHoldings(); }
    catch (e) { console.error('초기 데이터 로드 실패:', e); }
    finally { state.isInitDone = true; startCountdown(); }
  } else {
    $('#screen-login').hidden = false; $('#app-shell').hidden = true;
    resetState(); stopCountdown();
    state.isInitDone = true;
  }
}

function mapEmailToName(email) {
  if (!email) return '';
  const map = { 'philip@kanaraz-travel.test': '박필립', 'hyeyoung@kanaraz-travel.test': '윤혜영' };
  return map[email.toLowerCase()] || '';
}

function resetState() {
  stopCountdown();
  state.currentQuote = null; state.transactions = []; state.editingTxId = null;
  state.priceCache.clear(); state.analysisCache.clear();
  state.isAnalyzingMain = false; state.isBatching = false;
  $('#quote-card').hidden = true; $('#analysis-result').hidden = true;
  $('#ticker-input').value = ''; $('#search-error').hidden = true;
  const candidatesEl = document.getElementById('search-candidates');
  if (candidatesEl) candidatesEl.hidden = true;
  $('#transaction-form').reset(); $('#tx-id').value = ''; $('#tx-error').hidden = true;
  $('#tx-form-title').textContent = '거래 등록';
  $('#tx-submit-btn').textContent = '거래 저장';
  $('#tx-cancel-btn').hidden = true;
  $('#holdings-list').innerHTML = '<p class="empty-text">아직 등록된 거래가 없습니다.</p>';
  const w = document.getElementById('over-sell-warning'); if (w) w.remove();
  ['#total-cost', '#total-value', '#total-pnl', '#realized-pnl'].forEach((id) => { const el = $(id); if (el) el.textContent = '-'; });
  $$('.login-name-btn').forEach((b) => (b.disabled = false));
  $('#login-error').hidden = true; $('#login-loading').hidden = true;
  const dataBadge = $('#data-status-badge');
  if (dataBadge) { dataBadge.textContent = '데이터 상태 확인 중'; dataBadge.className = 'badge badge--muted'; }
  const batchBtn = $('#batch-build-btn');
  if (batchBtn) { batchBtn.hidden = true; batchBtn.disabled = false; batchBtn.textContent = '이력 쌓기'; }
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
  const btn = $('#logout-btn'); if (!btn) return;
  btn.onclick = async (e) => {
    if (e) e.preventDefault();
    if (isLoggingOut) return;
    if (state.isBatching) { alert('이력 쌓기가 진행 중입니다. 완료 후 로그아웃해 주세요.'); return; }
    if (!confirm('로그아웃하시겠습니까?')) return;
    isLoggingOut = true;
    stopCountdown();
    try {
      const { error } = await supabase.auth.signOut();
      if (error && error.message !== 'session_not_found') console.error('Logout error:', error);
    } catch (e) {
      if (e.message !== 'session_not_found') console.error(e);
    } finally { isLoggingOut = false; }
  };
}

function startCountdown() {
  stopCountdown(); state.countdown = 5; updateRefreshButton();
  state.countdownInterval = setInterval(() => {
    if (document.hidden) return;
    if (state.countdown > 0) state.countdown--;
    if (state.countdown === 0) { clearInterval(state.countdownInterval); state.countdownInterval = null; }
    updateRefreshButton();
  }, 1000);
}

function stopCountdown() {
  if (state.countdownInterval) { clearInterval(state.countdownInterval); state.countdownInterval = null; }
  updateRefreshButton();
}

function updateRefreshButton() {
  const btn = $('#refresh-btn'); if (!btn) return;
  if (state.isRefreshing) { btn.textContent = '새로고침 중...'; btn.disabled = true; }
  else if (state.countdown > 0) { btn.textContent = `새로고침 (${state.countdown})`; btn.disabled = true; }
  else { btn.textContent = '새로고침'; btn.disabled = false; }
}

function setupRefreshButton() {
  const btn = $('#refresh-btn'); if (!btn) return;
  btn.addEventListener('click', async () => {
    if (state.isRefreshing || state.countdown > 0 || state.isBatching) return;
    state.isRefreshing = true; stopCountdown(); updateRefreshButton();
    try { await performRefresh(); }
    finally { state.isRefreshing = false; startCountdown(); }
  });
}

async function performRefresh() {
  if (state.currentScreen === 'analysis') {
    if (state.currentQuote) await refreshQuoteSilently(state.currentQuote.ticker);
  } else if (state.currentScreen === 'holdings') {
    await refreshHoldingsView();
  }
}

function setupVisibility() { document.addEventListener('visibilitychange', () => updateRefreshButton()); }

function switchScreen(target) {
  state.currentScreen = target;
  $$('.nav-btn').forEach((b) => b.classList.toggle('nav-btn--active', b.dataset.screen === target));
  $('#screen-analysis').classList.toggle('screen--active', target === 'analysis');
  $('#screen-holdings').classList.toggle('screen--active', target === 'holdings');
  if (target === 'analysis') {
    $('#analysis-result').hidden = true;
    restoreAnalysisResults();
    const analyzeBtn = $('#analyze-btn');
    if (state.isAnalyzingMain && analyzeBtn) {
      analyzeBtn.disabled = true; analyzeBtn.textContent = '분석 중…';
    }
  }
}

function restoreAnalysisResults() {
  if (state.currentQuote && state.analysisCache.has(state.currentQuote.ticker)) {
    renderAnalysisResult(state.analysisCache.get(state.currentQuote.ticker), false);
  }
  state.transactions.forEach(tx => {
    if (state.analysisCache.has(tx.ticker)) {
      const card = document.querySelector(`.holding-card[data-ticker="${tx.ticker}"]`);
      if (card) renderInlineAnalysisResult(state.analysisCache.get(tx.ticker), card, false);
    }
  });
}

function setupNavigation() {
  $$('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const target = btn.dataset.screen; switchScreen(target);
      if (target === 'holdings') {
        const holdingsData = computeHoldings(state.transactions);
        let totalCost = 0, totalCurrentValue = 0;
        holdingsData.currentHoldings.forEach(h => {
          totalCost += h.totalCost;
          const price = state.priceCache.get(h.ticker) || h.avgCost;
          totalCurrentValue += price * h.qty;
        });
        renderHoldingsList(holdingsData.currentHoldings, state.priceCache, holdingsData.closedHoldings);
        renderHoldingsSummary(holdingsData, totalCost, totalCurrentValue);
        renderOverSellWarning(holdingsData.overSells || []);
      }
    });
  });
}

init();