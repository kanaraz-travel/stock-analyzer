import {
  supabase, state, $, $$,
  ALLOWED_NAMES, BATCH_ALLOWED_USER,
  getMarketStatusClient, updateMarketStatusBadge, updateDataStatusBadge,
  computeHoldings
} from './core.js';
import { initHoldings, loadHoldings, refreshHoldingsView } from './holdings.js';
import { renderHoldingsList, renderHoldingsSummary, renderOverSellWarning } from './holdings_ui.js';
import { initSearch, refreshQuoteSilently } from './search.js';
import { initAnalysis, runAnalysis } from './analysis.js';
import { renderAnalysisResult, renderInlineAnalysisResult } from './analysis_ui.js';
import { initAutoBatchBadge, stopAutoBatchBadge } from './auto_badge.js';

let isLoggingOut = false;

async function init() {
  renderLoginButtons();
  setupLogoutButton();
  setupRefreshButton();
  setupNavigation();
  setupSettingsModal();
  initHoldings();
  initSearch();
  initAnalysis();
  setupVisibility();

  supabase.auth.onAuthStateChange(async (event, session) => {
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
    const isBatchAllowed = (name === BATCH_ALLOWED_USER);
    const batchBtn = $('#batch-build-btn');
    if (batchBtn) batchBtn.hidden = !isBatchAllowed;
    const autoBadge = $('#auto-batch-badge');
    if (autoBadge) {
      if (isBatchAllowed) { autoBadge.hidden = false; initAutoBatchBadge(); }
      else { autoBadge.hidden = true; stopAutoBatchBadge(); }
    }
    switchScreen('holdings');
    updateMarketStatusBadge(getMarketStatusClient());
    try { await loadHoldings(); } catch (e) { console.error('초기 데이터 로드 실패:', e); }
    finally { state.isInitDone = true; startCountdown(); }
  } else {
    $('#screen-login').hidden = false; $('#app-shell').hidden = true;
    resetState(); stopCountdown(); state.isInitDone = true;
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
  const candidatesEl = document.getElementById('search-candidates'); if (candidatesEl) candidatesEl.hidden = true;
  $('#transaction-form').reset(); $('#tx-id').value = ''; $('#tx-error').hidden = true;
  $('#tx-form-title').textContent = '거래 등록'; $('#tx-submit-btn').textContent = '거래 저장'; $('#tx-cancel-btn').hidden = true;
  $('#holdings-list').innerHTML = '<p class="empty-text">아직 등록된 거래가 없습니다.</p>';
  const w = document.getElementById('over-sell-warning'); if (w) w.remove();
  ['#total-cost', '#total-value', '#total-pnl', '#realized-pnl'].forEach((id) => { const el = $(id); if (el) el.textContent = '-'; });
  $$('.login-name-btn').forEach((b) => (b.disabled = false));
  $('#login-error').hidden = true; $('#login-loading').hidden = true;
  const pwdWrap = $('#login-password-wrap'); if (pwdWrap) pwdWrap.hidden = true;
  const pwdInput = $('#login-password'); if (pwdInput) pwdInput.value = '';
  const dataBadge = $('#data-status-badge');
  if (dataBadge) { dataBadge.textContent = '데이터 상태 확인 중'; dataBadge.className = 'badge badge--muted'; }
  const batchBtn = $('#batch-build-btn');
  if (batchBtn) { batchBtn.hidden = true; batchBtn.disabled = false; batchBtn.textContent = '이력 쌓기'; }
  stopAutoBatchBadge();
  const autoBadge = $('#auto-batch-badge');
  if (autoBadge) { autoBadge.hidden = true; autoBadge.textContent = '자동 대기'; autoBadge.className = 'badge badge--muted'; }
}

function renderLoginButtons() {
  const container = $('#login-buttons'); if (!container) return;
  container.innerHTML = '';
  const passwordWrap = $('#login-password-wrap');
  const passwordInput = $('#login-password');
  const submitBtn = $('#login-submit');
  let selectedName = null;

  ALLOWED_NAMES.forEach((name) => {
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'btn btn--primary btn--block login-name-btn'; btn.textContent = name;
    btn.addEventListener('click', () => {
      selectedName = name;
      $$('.login-name-btn').forEach(b => b.classList.remove('login-name-btn--selected'));
      btn.classList.add('login-name-btn--selected');
      if (passwordWrap) passwordWrap.hidden = false;
      if (passwordInput) { passwordInput.value = ''; passwordInput.focus(); }
    });
    container.appendChild(btn);
  });

  if (submitBtn) {
    submitBtn.onclick = () => {
      if (!selectedName) { showLoginError('이름을 먼저 선택해 주세요.'); return; }
      handleLogin(selectedName, passwordInput?.value || '');
    };
  }
  if (passwordInput) {
    passwordInput.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); submitBtn?.click(); } };
  }
}

async function handleLogin(name, password) {
  const errorEl = $('#login-error'), loadingEl = $('#login-loading');
  const buttons = $$('.login-name-btn, #login-submit, #login-password');
  if (errorEl) errorEl.hidden = true;
  if (!password) { showLoginError('비밀번호를 입력해 주세요.'); return; }
  if (loadingEl) loadingEl.hidden = false;
  buttons.forEach((b) => (b.disabled = true));
  try {
    const res = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, password }) });
    let data = {}; try { data = await res.json(); } catch { throw new Error('서버 응답을 해석할 수 없습니다.'); }
    if (!res.ok) throw new Error(data.error || '로그인에 실패했습니다.');
    if (!data.token_hash) throw new Error('로그인 토큰이 없습니다.');
    const { error: verifyError } = await supabase.auth.verifyOtp({ type: 'magiclink', token_hash: data.token_hash });
    if (verifyError) throw new Error(mapAuthError(verifyError.message));
    const pwd = $('#login-password'); if (pwd) pwd.value = '';
    const wrap = $('#login-password-wrap'); if (wrap) wrap.hidden = true;
  } catch (err) { showLoginError(err.message || '로그인에 실패했습니다.'); }
  finally { if (loadingEl) loadingEl.hidden = true; buttons.forEach((b) => (b.disabled = false)); }
}

function showLoginError(msg) { const el = $('#login-error'); if (el) { el.textContent = msg; el.hidden = false; } }

function mapAuthError(msg) {
  const m = (msg || '').toLowerCase();
  if (m.includes('expired') || m.includes('invalid')) return '로그인 링크가 만료되었습니다. 다시 시도해 주세요.';
  if (m.includes('rate limit') || m.includes('too many')) return '시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.';
  if (m.includes('network') || m.includes('fetch')) return '네트워크 오류가 발생했습니다. 연결을 확인해 주세요.';
  return msg || '로그인에 실패했습니다.';
}

function setupSettingsModal() {
  const openBtn = $('#settings-btn'); const modal = $('#settings-modal');
  if (!openBtn || !modal) return;
  const closeBtns = modal.querySelectorAll('[data-close]');
  const form = $('#password-form');
  const errEl = $('#password-error');
  const okEl = $('#password-ok');
  const submitBtn = $('#password-submit');

  openBtn.addEventListener('click', () => {
    modal.hidden = false; if (errEl) errEl.hidden = true; if (okEl) okEl.hidden = true;
    form.reset(); const cur = $('#current-password'); if (cur) cur.focus();
  });
  closeBtns.forEach(b => b.addEventListener('click', () => { modal.hidden = true; }));
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.hidden = true; });
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (errEl) errEl.hidden = true; if (okEl) okEl.hidden = true;
    const cur = $('#current-password').value; const nw = $('#new-password').value; const nw2 = $('#new-password-confirm').value;
    if (nw.length < 6) { showPwdError('새 비밀번호는 6자 이상이어야 합니다.'); return; }
    if (nw !== nw2) { showPwdError('새 비밀번호 확인이 일치하지 않습니다.'); return; }
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = '변경 중…'; }
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('세션이 없습니다. 다시 로그인해 주세요.');
      const res = await fetch('/api/account', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.access_token}` }, body: JSON.stringify({ current_password: cur, new_password: nw }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '변경에 실패했습니다.');
      if (okEl) { okEl.textContent = '✓ 비밀번호가 변경되었습니다.'; okEl.hidden = false; }
      form.reset();
    } catch (err) { showPwdError(err.message || '변경에 실패했습니다.'); }
    finally { if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = '변경'; } }
  });
  function showPwdError(msg) { if (errEl) { errEl.textContent = msg; errEl.hidden = false; } }
}

function setupLogoutButton() {
  const btn = $('#logout-btn'); if (!btn) return;
  btn.onclick = async (e) => {
    if (e) e.preventDefault(); if (isLoggingOut) return;
    if (state.isBatching) { alert('이력 쌓기가 진행 중입니다. 완료 후 로그아웃해 주세요.'); return; }
    if (!confirm('로그아웃하시겠습니까?')) return;
    isLoggingOut = true; stopCountdown();
    try { const { error } = await supabase.auth.signOut(); if (error && error.message !== 'session_not_found') console.error('Logout error:', error); }
    catch (e) { if (e.message !== 'session_not_found') console.error(e); }
    finally { isLoggingOut = false; }
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
function stopCountdown() { if (state.countdownInterval) { clearInterval(state.countdownInterval); state.countdownInterval = null; } updateRefreshButton(); }
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
    try { await performRefresh(); } finally { state.isRefreshing = false; startCountdown(); }
  });
}
async function performRefresh() {
  if (state.currentScreen === 'analysis') { if (state.currentQuote) await refreshQuoteSilently(state.currentQuote.ticker); }
  else if (state.currentScreen === 'holdings') { await refreshHoldingsView(); }
}
function setupVisibility() { document.addEventListener('visibilitychange', () => updateRefreshButton()); }
function switchScreen(target) {
  state.currentScreen = target;
  $$('.nav-btn').forEach((b) => b.classList.toggle('nav-btn--active', b.dataset.screen === target));
  $('#screen-analysis').classList.toggle('screen--active', target === 'analysis');
  $('#screen-holdings').classList.toggle('screen--active', target === 'holdings');
  if (target === 'analysis') {
    $('#analysis-result').hidden = true; restoreAnalysisResults();
    const analyzeBtn = $('#analyze-btn'); if (state.isAnalyzingMain && analyzeBtn) { analyzeBtn.disabled = true; analyzeBtn.textContent = '분석 중…'; }
  }
}
function restoreAnalysisResults() {
  if (state.currentQuote && state.analysisCache.has(state.currentQuote.ticker)) { renderAnalysisResult(state.analysisCache.get(state.currentQuote.ticker), false); }
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
          totalCost += h.totalCost; const price = state.priceCache.get(h.ticker) || h.avgCost; totalCurrentValue += price * h.qty;
        });
        renderHoldingsList(holdingsData.currentHoldings, state.priceCache, holdingsData.closedHoldings);
        renderHoldingsSummary(holdingsData, totalCost, totalCurrentValue);
        renderOverSellWarning(holdingsData.overSells || []);
      }
    });
  });
}
init();