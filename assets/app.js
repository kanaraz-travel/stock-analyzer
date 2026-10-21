// assets/app.js
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const SUPABASE_URL = 'https://hexykwjjkkozbeaqziem.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhleHlrd2pqa2tvemJlYXF6aWVtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE3OTk0MzUsImV4cCI6MjEwNzM3NTQzNX0.r4m4TY8dkkb19PKmMqdDH3_SicTUpt2DoXeDVSE1M3g';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});

const ALLOWED_NAMES = ['박필립', '윤혜영'];
let currentUser = null, currentQuote = null, transactions = [], editingTxId = null;
let selectedSellTarget = null;
let currentScreen = 'holdings'; // 초기 진입 탭 변경

let countdown = 5;
let countdownInterval = null;
let isRefreshing = false;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

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
    
    // 초기 화면을 '내 보유 주식'으로 강제 설정
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
  stopCountdown(); currentQuote = null; selectedSellTarget = null; transactions = []; editingTxId = null;
  $('#quote-card').hidden = true; $('#analysis-result').hidden = true;
  $('#sell-quote-card').hidden = true; $('#sell-analysis-result').hidden = true;
  $('#ticker-input').value = ''; $('#search-error').hidden = true;
  $('#transaction-form').reset(); $('#tx-id').value = ''; $('#tx-error').hidden = true;
  setTxFormMode(null); $('#holdings-list').innerHTML = '<p class="empty-text">아직 등록된 거래가 없습니다.</p>';
  $('#sell-target-list').innerHTML = '<p class="empty-text">보유 중인 종목이 없습니다.</p>';
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

// ------------------------------------------------------------
// 5초 카운트다운 및 새로고침
// ------------------------------------------------------------
function startCountdown() {
  stopCountdown();
  countdown = 5;
  updateRefreshButton();
  
  countdownInterval = setInterval(() => {
    if (document.hidden) return;
    if (countdown > 0) countdown--;
    if (countdown === 0) {
      clearInterval(countdownInterval);
      countdownInterval = null;
    }
    updateRefreshButton();
  }, 1000);
}

function stopCountdown() {
  if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
  updateRefreshButton();
}

function updateRefreshButton() {
  const btn = $('#refresh-btn');
  if (!btn) return;
  
  if (isRefreshing) {
    btn.textContent = '새로고침 중...';
    btn.disabled = true;
  } else if (countdown > 0) {
    btn.textContent = `새로고침 (${countdown})`;
    btn.disabled = true;
  } else {
    btn.textContent = '새로고침';
    btn.disabled = false;
  }
}

function setupRefreshButton() {
  $('#refresh-btn').addEventListener('click', async () => {
    if (isRefreshing || countdown > 0) return;
    isRefreshing = true;
    stopCountdown();
    updateRefreshButton();
    try {
      await performRefresh();
    } finally {
      isRefreshing = false;
      startCountdown();
    }
  });
}

async function performRefresh() {
  if (currentScreen === 'buy') {
    if (currentQuote) {
      await refreshQuoteSilently(currentQuote.ticker);
    }
  } else if (currentScreen === 'holdings') {
    await refreshHoldingsView();
  } else if (currentScreen === 'sell') {
    await refreshSellView();
  }
}

function setupVisibility() {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) updateRefreshButton();
    else updateRefreshButton();
  });
}

// ------------------------------------------------------------
// 시장 상태 및 배지 업데이트
// ------------------------------------------------------------
function getMarketStatusClient() {
  const now = new Date();
  const kstTime = new Date(now.getTime() + (9 * 60 * 60 * 1000));
  const day = kstTime.getUTCDay();
  const timeVal = kstTime.getUTCHours() * 100 + kstTime.getUTCMinutes();
  
  if (day === 0 || day === 6) return '휴장 (주말)';
  if (timeVal >= 900 && timeVal < 1530) return '정규장 09:00~15:30';
  if (timeVal >= 1530 && timeVal < 1600) return '장 마감 (대기)';
  if (timeVal >= 1600 && timeVal <= 2000) return '애프터마켓 16:00~20:00';
  return '장마감';
}

function updateMarketStatusBadge(statusText) {
  const badge = $('#market-status-badge');
  badge.textContent = statusText;
  
  if (statusText.includes('정규장')) badge.className = 'badge badge--positive';
  else if (statusText.includes('애프터마켓')) badge.className = 'badge badge--warning';
  else badge.className = 'badge badge--muted';
}

function updateDataStatusBadge(status) {
  const badge = $('#data-status-badge');
  if (status === 'LATEST') { badge.textContent = '연결 원활'; badge.className = 'badge badge--positive'; }
  else if (status === 'DELAYED') { badge.textContent = '지연'; badge.className = 'badge badge--warning'; }
  else { badge.textContent = '연결 끊김'; badge.className = 'badge badge--muted'; }
}

// ------------------------------------------------------------
// 네비게이션 (탭 전환)
// ------------------------------------------------------------
function switchScreen(target) {
  currentScreen = target;
  $$('.nav-btn').forEach((b) => b.classList.toggle('nav-btn--active', b.dataset.screen === target));
  $('#screen-buy').classList.toggle('screen--active', target === 'buy');
  $('#screen-holdings').classList.toggle('screen--active', target === 'holdings');
  $('#screen-sell').classList.toggle('screen--active', target === 'sell');
}

function setupNavigation() {
  $$('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const target = btn.dataset.screen;
      switchScreen(target);
      
      if (target === 'holdings') {
        const holdingsData = computeHoldings(transactions);
        renderHoldingsList(holdingsData.currentHoldings);
      } else if (target === 'sell') {
        const holdingsData = computeHoldings(transactions);
        const priceMap = new Map();
        if (selectedSellTarget) priceMap.set(selectedSellTarget