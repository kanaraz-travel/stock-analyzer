// assets/app.js
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { 
  initHoldings, loadHoldings, refreshHoldingsView,
  computeHoldings, renderHoldingsList, renderHoldingsSummary, renderOverSellWarning
} from './holdings.js';
import { initSearch, refreshQuoteSilently } from './search.js';
import { initAnalysis, renderAnalysisResult, renderInlineAnalysisResult } from './analysis.js';

const SUPABASE_URL = 'https://hexykwjjkkozbeaqziem.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhleHlrd2pqa2tvemJlYXF6aWVtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE3OTk0MzUsImV4cCI6MjEwNzM3NTQzNX0.r4m4TY8dkkb19PKmMqdDH3_SicTUpt2DoXeDVSE1M3g';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});

export const state = {
  currentUser: null,
  currentQuote: null,
  transactions: [],
  editingTxId: null,
  currentScreen: 'holdings',
  countdown: 5,
  countdownInterval: null,
  isRefreshing: false,
  isAnalyzingMain: false,
  isBatching: false,
  priceCache: new Map(),
  analysisCache: new Map(),
  isInitDone: false,
};

export const ALLOWED_NAMES = ['박필립', '윤혜영'];
export const BATCH_ALLOWED_USER = '박필립';
export const BATCH_TOP_COUNT = 10;
export const BATCH_RANDOM_COUNT = 10;
export const BATCH_DELAY_MS = 2500;
export const HIDDEN_POLL_MS = 1000;

export const $ = (sel) => document.querySelector(sel);
export const $$ = (sel) => document.querySelectorAll(sel);

const BORDER_COLORS = ['#ef4444', '#f97316', '#f59e0b', '#84cc16', '#10b981', '#06b6d4', '#3b82f6', '#6366f1', '#8b5cf6', '#d946ef', '#ec4899', '#f43f5e'];

export function getBorderColor(ticker) {
  if (!ticker || typeof ticker !== 'string') return '#9ca3af';
  let hash = 0;
  for (let i = 0; i < ticker.length; i++) hash = ticker.charCodeAt(i) + ((hash << 5) - hash);
  return BORDER_COLORS[Math.abs(hash) % BORDER_COLORS.length];
}

export function formatNumber(n) { return Number(n).toLocaleString('ko-KR', { maximumFractionDigits: 6 }); }
export function formatCurrency(n) { return Number(n).toLocaleString('ko-KR', { maximumFractionDigits: 0 }) + '원'; }
export function formatDateTime(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '-';
  return d.toLocaleString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function getMarketStatusClient() {
  const now = new Date(); const kstTime = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const day = kstTime.getUTCDay(); const timeVal = kstTime.getUTCHours() * 100 + kstTime.getUTCMinutes();
  if (day === 0 || day === 6) return '휴장 (주말)';
  if (timeVal >= 900 && timeVal < 1530) return '정규장 09:00~15:30';
  if (timeVal >= 1530 && timeVal < 1600) return '장 마감 (대기)';
  if (timeVal >= 1600 && timeVal <= 2000) return '애프터마켓 16:00~20:00';
  return '장마감';
}

export function updateMarketStatusBadge(statusText) {
  const badge = $('#market-status-badge'); if (!badge) return;
  badge.textContent = statusText;
  if (statusText.includes('정규장')) badge.className = 'badge badge--status-green';
  else if (statusText.includes('애프터마켓') || statusText.includes('시간외')) badge.className = 'badge badge--status-blue';
  else badge.className = 'badge badge--status-gray';
}

export function updateDataStatusBadge(status) {
  const badge = $('#data-status-badge'); if (!badge) return;
  if (!status) { badge.textContent = '데이터 상태 확인 중'; badge.className = 'badge badge--muted'; return; }
  if (status === 'ERROR') { badge.textContent = '연결 끊김'; badge.className = 'badge badge--status-gray'; }
  else if (status === 'DELAYED') { badge.textContent = '지연'; badge.className = 'badge badge--status-orange'; }
  else if (status === 'STALE') { badge.textContent = '오래된 데이터'; badge.className = 'badge badge--status-orange'; }
  else { badge.textContent = '연결 원활'; badge.className = 'badge badge--status-green'; }
}

// ★ 자동 이력 쌓기 배지 폴링 로직
let autoBatchInterval = null;

function setupAutoBatchBadge() {
  if (autoBatchInterval) clearInterval(autoBatchInterval);
  pollAutoBatchStatus();
  autoBatchInterval = setInterval(pollAutoBatchStatus, 30000); // 30초마다 폴링
}

async function pollAutoBatchStatus() {
  if (document.hidden) return;

  try {
    const res = await fetch('/api/cron-status');
    if (!res.ok) throw new Error('상태 조회 실패');
    const data = await res.json();
    renderAutoBatchBadge(data);
  } catch (e) {
    renderAutoBatchBadge({ status: 'failed' });
  }
}

function renderAutoBatchBadge(data) {
  const badge = $('#auto-batch-badge');
  if (!badge) return;

  const now = Date.now();
  const nextRun = data.next_run_at ? new Date(data.next_run_at).getTime() : 0;
  const isDelayed = data.status === 'idle' && (now > nextRun + 10 * 60 * 1000); // 예정 +10분 지연

  let text = '', className = '';

  if (data.status === 'running') {
    text = '자동 중...'; className = 'badge--status-orange';
  } else if (data.status === 'failed' || isDelayed) {
    text = '자동 끊김'; className = 'badge--status-gray';
  } else {
    text = '자동 원활'; className = 'badge--status-green';
  }

  badge.textContent = text;
  badge.className = `badge ${className}`;
  badge.style.cursor = 'pointer';
  
  badge.onclick = (e) => {
    e.stopPropagation();
    showAutoBatchTooltip(badge, data);
  };
}

function showAutoBatchTooltip(anchor, data) {
  let tooltip = document.getElementById('auto-batch-tooltip');
  if (tooltip) tooltip.remove();

  tooltip = document.createElement('div');
  tooltip.id = 'auto-batch-tooltip';
  tooltip.style.cssText = `
    position:absolute; top:40px; right:0; z-index:100;
    background:#1e293b; color:#fff; padding:12px; border-radius:8px;
    font-size:12px; line-height:1.5; box-shadow:0 4px 6px rgba(0,0,0,0.3); width:220px;
  `;

  const formatTime = (iso) => iso ? new Date(iso).toLocaleString('ko-KR', { hour: '2-digit', minute: '2-digit' }) : '-';

  tooltip.innerHTML = `
    <div style="font-weight:bold; margin-bottom:8px; border-bottom:1px solid #475569; padding-bottom:4px;">자동 이력 쌓기</div>
    <div>다음 실행: <span style="color:#38bdf8;">${formatTime(data.next_run_at)}</span></div>
    <div>마지막 실행: ${formatTime(data.last_run_at)}</div>
    <div>결과: 성공 ${data.succeeded || 0} / 실패 ${data.failed || 0}</div>
  `;

  anchor.parentNode.style.position = 'relative';
  anchor.parentNode.appendChild(tooltip);

  setTimeout(() => {
    document.addEventListener('click', function closeTooltip() {
      tooltip.remove();
      document.removeEventListener('click', closeTooltip);
    });
  }, 0);
}

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
    if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION') {
      await handleAuthState(session);
      setupAutoBatchBadge(); // ★ 로그인 시 배지 폴링 시작
    } else if (event === 'SIGNED_OUT') {
      await handleAuthState(null);
      if (autoBatchInterval) clearInterval(autoBatchInterval); // ★ 로그아웃 시 중지
    }
  });

  const { data: { session } } = await supabase.auth.getSession();
  if (session && !state.currentUser) {
    await handleAuthState(session);
  }
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
  stopCountdown(); state.currentQuote = null; state.transactions = []; state.editingTxId = null;
  state.priceCache.clear(); state.analysisCache.clear();
  state.isAnalyzingMain = false; state.isBatching = false;
  $('#quote-card').hidden = true; $('#analysis-result').hidden = true;
  $('#ticker-input').value = ''; $('#search-error').hidden = true;
  const candidatesEl = document.getElementById('search-candidates');
  if (candidatesEl) candidatesEl.hidden = true;
  $('#transaction-form').reset(); $('#tx-id').value = ''; $('#tx-error').hidden = true;
  $('#tx-form-title').textContent = '거래 등록'; $('#tx-submit-btn').textContent = '거래 저장'; $('#tx-cancel-btn').hidden = true;
  $('#holdings-list').innerHTML = '<p class="empty-text">아직 등록된 거래가 없습니다.</p>';
  const w = document.getElementById('over-sell-warning'); if (w) w.remove();
  ['#total-cost', '#total-value', '#total-pnl', '#realized-pnl'].forEach((id) => { $(id).textContent = '-'; });
  $$('.login-name-btn').forEach((b) => (b.disabled = false));
  $('#login-error').hidden = true; $('#login-loading').hidden = true;
  
  const dataBadge = $('#data-status-badge');
  dataBadge.textContent = '데이터 상태 확인 중';
  dataBadge.className = 'badge badge--muted';

  const autoBadge = $('#auto-batch-badge');
  if (autoBadge) { autoBadge.textContent = '자동 대기'; autoBadge.className = 'badge badge--muted'; }
  
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

export function startCountdown() {
  stopCountdown(); state.countdown = 5; updateRefreshButton();
  state.countdownInterval = setInterval(() => {
    if (document.hidden) return;
    if (state.countdown > 0) state.countdown--;
    if (state.countdown === 0) { clearInterval(state.countdownInterval); state.countdownInterval = null; }
    updateRefreshButton();
  }, 1000);
}

export function stopCountdown() {
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
  $('#refresh-btn').addEventListener('click', async () => {
    if (state.isRefreshing || state.countdown > 0 || state.isBatching) return;
    state.isRefreshing = true; stopCountdown(); updateRefreshButton();
    try { await performRefresh(); } finally { state.isRefreshing = false; startCountdown(); }
  });
}

async function performRefresh() {
  if (state.currentScreen === 'analysis') { if (state.currentQuote) await refreshQuoteSilently(state.currentQuote.ticker); }
  else if (state.currentScreen === 'holdings') { await refreshHoldingsView(); }
}

function setupVisibility() {
  document.addEventListener('visibilitychange', () => {
    updateRefreshButton();
    if (!document.hidden) pollAutoBatchStatus(); // 탭 복귀 시 즉시 갱신
  });
}

function switchScreen(target) {
  state.currentScreen = target;
  $$('.nav-btn').forEach((b) => b.classList.toggle('nav-btn--active', b.dataset.screen === target));
  $('#screen-analysis').classList.toggle('screen--active', target === 'analysis');
  $('#screen-holdings').classList.toggle('screen--active', target === 'holdings');
  if (target === 'analysis') {
    $('#analysis-result').hidden = true;
    restoreAnalysisResults();
    if (state.isAnalyzingMain) { $('#analyze-btn').disabled = true; $('#analyze-btn').textContent = '분석 중…'; }
  }
}

function restoreAnalysisResults() {
  if (state.currentQuote && state.analysisCache.has(state.currentQuote.ticker)) {
    if (window.renderAnalysisResult) {
      window.renderAnalysisResult(state.analysisCache.get(state.currentQuote.ticker), false);
    }
  }
  state.transactions.forEach(tx => {
    if (state.analysisCache.has(tx.ticker)) {
      const card = document.querySelector(`.holding-card[data-ticker="${tx.ticker}"]`);
      if (card) {
        const inlineResult = card.querySelector('.holding-inline-result');
        if (inlineResult && window.renderInlineAnalysisResult) {
          window.renderInlineAnalysisResult(state.analysisCache.get(tx.ticker), card, false);
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