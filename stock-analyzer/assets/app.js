// assets/app.js
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

// ------------------------------------------------------------
// Supabase 클라이언트 (기존 해외여행 가계부 프로젝트 재사용)
// ------------------------------------------------------------
const SUPABASE_URL = window.__SUPABASE_URL__ || 'https://YOUR_PROJECT.supabase.co';
const SUPABASE_ANON_KEY = window.__SUPABASE_ANON_KEY__ || 'YOUR_ANON_KEY';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  },
});

// 허용 사용자 (서버와 동일한 순서로 표시)
const ALLOWED_NAMES = ['박필립', '윤혜영'];

// ------------------------------------------------------------
// 상태
// ------------------------------------------------------------
let currentUser = null;
let currentQuote = null;
let transactions = [];
let refreshTimer = null;
let editingTxId = null;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ------------------------------------------------------------
// 초기화
// ------------------------------------------------------------
async function init() {
  renderLoginButtons();
  setupLogoutButton();
  setupNavigation();
  setupAccordions();
  setupSearch();
  setupAnalyze();
  setupTransactionForm();
  setupVisibility();

  supabase.auth.onAuthStateChange((_event, session) => {
    handleAuthState(session);
  });

  const { data: { session } } = await supabase.auth.getSession();
  handleAuthState(session);
}

async function handleAuthState(session) {
  currentUser = session?.user || null;

  const loginScreen = $('#screen-login');
  const appShell = $('#app-shell');

  if (currentUser) {
    loginScreen.hidden = true;
    appShell.hidden = false;

    // 사용자 표시 이름 (이메일 → 이름 매핑)
    const displayName = mapEmailToName(currentUser.email) || currentUser.email || '';
    $('#current-user-name').textContent = displayName;

    await loadHoldings();
  } else {
    loginScreen.hidden = false;
    appShell.hidden = true;
    resetState();
  }
}

function mapEmailToName(email) {
  if (!email) return '';
  const map = {
    'philip@kanaraz-travel.test': '박필립',
    'hyeyoung@kanaraz-travel.test': '윤혜영',
  };
  return map[email.toLowerCase()] || '';
}

function resetState() {
  stopAutoRefresh();
  currentQuote = null;
  transactions = [];
  editingTxId = null;
  $('#quote-card').hidden = true;
  $('#analysis-result').hidden = true;
  $('#ticker-input').value = '';
  $('#search-error').hidden = true;
  $('#transaction-form').reset();
  $('#tx-id').value = '';
  $('#tx-error').hidden = true;
  setTxFormMode(null);
  $('#holdings-list').innerHTML = '<p class="empty-text">아직 등록된 거래가 없습니다.</p>';
  ['#total-cost', '#total-value', '#total-pnl', '#total-pnl-rate'].forEach((id) => {
    $(id).textContent = '-';
  });
}

// ------------------------------------------------------------
// 로그인 (이름 선택 버튼 → /api/login → verifyOtp)
// ------------------------------------------------------------
function renderLoginButtons() {
  const container = $('#login-buttons');
  container.innerHTML = '';

  ALLOWED_NAMES.forEach((name) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn--primary btn--block login-name-btn';
    btn.textContent = name;
    btn.addEventListener('click', () => handleLogin(name));
    container.appendChild(btn);
  });
}

async function handleLogin(name) {
  const errorEl = $('#login-error');
  const loadingEl = $('#login-loading');
  const buttons = $$('.login-name-btn');

  errorEl.hidden = true;
  loadingEl.hidden = false;
  buttons.forEach((b) => (b.disabled = true));

  try {
    // 1) 서버에서 매직링크 토큰 발급
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });

    let data = {};
    try {
      data = await res.json();
    } catch {
      throw new Error('서버 응답을 해석할 수 없습니다.');
    }

    if (!res.ok) {
      throw new Error(data.error || '로그인에 실패했습니다.');
    }

    if (!data.token_hash) {
      throw new Error('로그인 토큰이 없습니다.');
    }

    // 2) 매직링크 토큰으로 세션 교환 (SDK가 자동 저장)
    const { error: verifyError } = await supabase.auth.verifyOtp({
      type: 'magiclink',
      token_hash: data.token_hash,
    });

    if (verifyError) {
      throw new Error(mapAuthError(verifyError.message));
    }

    // onAuthStateChange가 화면 전환을 처리
  } catch (err) {
    errorEl.textContent = err.message || '로그인에 실패했습니다.';
    errorEl.hidden = false;
    buttons.forEach((b) => (b.disabled = false));
  } finally {
    loadingEl.hidden = true;
  }
}

function mapAuthError(msg) {
  const m = (msg || '').toLowerCase();
  if (m.includes('expired') || m.includes('invalid')) {
    return '로그인 링크가 만료되었습니다. 다시 시도해 주세요.';
  }
  if (m.includes('rate limit') || m.includes('too many')) {
    return '시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.';
  }
  if (m.includes('network') || m.includes('fetch')) {
    return '네트워크 오류가 발생했습니다. 연결을 확인해 주세요.';
  }
  return msg || '로그인에 실패했습니다.';
}

function setupLogoutButton() {
  $('#logout-btn').addEventListener('click', async () => {
    if (!confirm('로그아웃하시겠습니까?')) return;
    stopAutoRefresh();
    await supabase.auth.signOut();
  });
}

// ------------------------------------------------------------
// 화면 전환
// ------------------------------------------------------------
function setupNavigation() {
  $$('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.screen;
      $$('.nav-btn').forEach((b) => b.classList.toggle('nav-btn--active', b === btn));
      $('#screen-analysis').classList.toggle('screen--active', target === 'analysis');
      $('#screen-holdings').classList.toggle('screen--active', target === 'holdings');
      if (target === 'holdings') loadHoldings();
    });
  });
}

// ------------------------------------------------------------
// 아코디언
// ------------------------------------------------------------
function setupAccordions() {
  $$('.accordion-trigger').forEach((trigger) => {
    trigger.addEventListener('click', () => {
      const expanded = trigger.getAttribute('aria-expanded') === 'true';
      trigger.setAttribute('aria-expanded', String(!expanded));
    });
  });
}

// ------------------------------------------------------------
// 종목 검색 + 시세
// ------------------------------------------------------------
function setupSearch() {
  $('#search-btn').addEventListener('click', handleSearch);
  $('#ticker-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleSearch();
  });
}

async function handleSearch() {
  const ticker = $('#ticker-input').value.trim();
  const errorEl = $('#search-error');
  errorEl.hidden = true;

  if (!/^\d{6}$/.test(ticker)) {
    errorEl.textContent = '종목코드는 6자리 숫자여야 합니다.';
    errorEl.hidden = false;
    return;
  }

  const btn = $('#search-btn');
  btn.disabled = true;
  btn.textContent = '조회 중…';

  try {
    const res = await fetch(`/api/quote?ticker=${encodeURIComponent(ticker)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '시세를 가져오지 못했습니다.');

    currentQuote = data;
    renderQuote(data);
    updateMarketBadges(data);
    startAutoRefresh();
  } catch (err) {
    errorEl.textContent = err.message || '시세를 가져오지 못했습니다. 잠시 후 다시 확인해 주세요.';
    errorEl.hidden = false;
    $('#quote-card').hidden = true;
    $('#analysis-result').hidden = true;
    stopAutoRefresh();
  } finally {
    btn.disabled = false;
    btn.textContent = '조회';
  }
}

function renderQuote(q) {
  $('#quote-card').hidden = false;
  $('#stock-name').textContent = q.stock_name || q.ticker;
  $('#stock-ticker').textContent = q.ticker;

  $('#current-price').textContent = q.price != null ? formatNumber(q.price) + '원' : '-';

  const changeEl = $('#change-rate');
  if (q.change_rate != null) {
    const sign = q.change_rate > 0 ? '+' : '';
    changeEl.textContent = `${sign}${q.change_rate.toFixed(2)}%`;
    changeEl.className =
      'change-rate ' +
      (q.change_rate > 0 ? 'positive' : q.change_rate < 0 ? 'negative' : '');
  } else {
    changeEl.textContent = '-';
    changeEl.className = 'change-rate';
  }

  $('#quote-as-of').textContent = `시세 시각: ${
    q.quote_as_of ? formatDateTime(q.quote_as_of) : '-'
  }`;
  $('#quote-provider').textContent = `출처: ${q.provider || '-'}`;
  $('#analysis-result').hidden = true;
}

function updateMarketBadges(q) {
  const market = $('#market-status-badge');
  market.textContent =
    q.market_status === 'OPEN' ? '장중' : q.market_status || '상태 미확인';

  const dataBadge = $('#data-status-badge');
  if (q.data_status === 'LATEST') {
    dataBadge.textContent = '최신';
    dataBadge.className = 'badge badge--positive';
  } else if (q.data_status === 'DELAYED') {
    dataBadge.textContent = '지연';
    dataBadge.className = 'badge badge--warning';
  } else {
    dataBadge.textContent = '일부 정보 부족';
    dataBadge.className = 'badge badge--muted';
  }
}

// ------------------------------------------------------------
// 자동 갱신 (탭 활성 시에만 45초 간격)
// ------------------------------------------------------------
function startAutoRefresh() {
  stopAutoRefresh();
  refreshTimer = setInterval(() => {
    if (document.hidden) return;
    if (!currentQuote?.ticker) return;
    if ($('#ticker-input').value.trim() !== currentQuote.ticker) return;
    refreshQuoteSilently(currentQuote.ticker);
  }, 45000);
}

function stopAutoRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

async function refreshQuoteSilently(ticker) {
  try {
    const res = await fetch(`/api/quote?ticker=${encodeURIComponent(ticker)}`);
    if (!res.ok) return;
    const data = await res.json();
    if (currentQuote?.ticker === ticker) {
      currentQuote = data;
      renderQuote(data);
      updateMarketBadges(data);
    }
  } catch {
    /* 다음 사이클에 재시도 */
  }
}

function setupVisibility() {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopAutoRefresh();
    else if (currentQuote) startAutoRefresh();
  });
}

// ------------------------------------------------------------
// 분석
// ------------------------------------------------------------
function setupAnalyze() {
  $('#analyze-btn').addEventListener('click', runAnalysis);
}

async function runAnalysis() {
  if (!currentQuote) return;

  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    alert('로그인이 필요합니다.');
    return;
  }

  const btn = $('#analyze-btn');
  btn.disabled = true;
  btn.textContent = '분석 중…';
  $('#analysis-result').hidden = true;

  try {
    const payload = {
      ticker: currentQuote.ticker,
      stock_name: currentQuote.stock_name || currentQuote.ticker,
      price_data: {
        current_price: currentQuote.price,
        quote_as_of: currentQuote.quote_as_of,
        return_1d:
          currentQuote.change_rate != null ? currentQuote.change_rate / 100 : null,
        return_5d: null,
        return_20d: null,
        volatility_20d: null,
        quote_is_stale: false,
      },
      volume_data: null,
      news_items: [],
    };

    const res = await fetch('/api/analyze', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '분석에 실패했습니다.');

    renderAnalysis(data);
    fetchNewsSilently(currentQuote.ticker);
  } catch (err) {
    alert(err.message || '분석에 실패했습니다.');
  } finally {
    btn.disabled = false;
    btn.textContent = '분석하기';
  }
}

function renderAnalysis(data) {
  $('#analysis-result').hidden = false;

  const badge = $('#recommendation-badge');
  badge.textContent = data.recommendation || '판단 보류';
  badge.className = 'recommendation-badge';

  const rec = data.recommendation || '';
  if (rec.includes('매수')) badge.classList.add('recommendation-badge--buy');
  else if (rec.includes('매도')) badge.classList.add('recommendation-badge--sell');
  else if (rec.includes('기다리기')) badge.classList.add('recommendation-badge--hold');
  else badge.classList.add('recommendation-badge--pending');

  $('#analysis-timestamp').textContent = `분석 시각: ${formatDateTime(
    new Date().toISOString()
  )}`;
  $('#overall-summary').textContent = data.overall_summary || '-';

  if (data.scenario) {
    $('#scenario-box').hidden = false;
    $('#scenario-text').textContent = data.scenario;
  } else {
    $('#scenario-box').hidden = true;
  }

  $('#price-flow-summary').textContent = data.price_flow_summary || '데이터가 부족합니다.';
  $('#volume-summary').textContent = data.volume_summary || '데이터가 부족합니다.';
  $('#news-summary').textContent = data.news_summary || '확인된 뉴스가 없습니다.';

  const tip =
    data.tip || '이 분석은 참고용이며, 투자 결정은 본인의 판단과 책임 하에 이루어져야 합니다.';
  $('#price-tip').textContent = tip;
  $('#volume-tip').textContent = tip;

  $('#ai-fallback-note').hidden = !data.fallback;

  renderNewsList(data.news_items || []);
}

async function fetchNewsSilently(ticker) {
  try {
    const res = await fetch(`/api/news?ticker=${encodeURIComponent(ticker)}`);
    if (!res.ok) return;
    const data = await res.json();
    if (Array.isArray(data.items) && data.items.length > 0) {
      renderNewsList(data.items);
      $('#news-delay-note').hidden = !data.delayed;
    }
  } catch {
    /* /api/news 미구현 시 무시 */
  }
}

function renderNewsList(items) {
  const list = $('#news-list');
  list.innerHTML = '';

  if (!Array.isArray(items) || items.length === 0) {
    const li = document.createElement('li');
    li.className = 'note-text';
    li.textContent = '표시할 뉴스/공시가 없습니다.';
    list.appendChild(li);
    return;
  }

  items.slice(0, 5).forEach((item) => {
    const li = document.createElement('li');

    if (item.url) {
      const a = document.createElement('a');
      a.className = 'news-title';
      a.href = item.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = item.title || '제목 없음';
      li.appendChild(a);
    } else {
      const span = document.createElement('span');
      span.className = 'news-title';
      span.textContent = item.title || '제목 없음';
      li.appendChild(span);
    }

    const meta = document.createElement('div');
    meta.className = 'news-meta';
    meta.textContent = `${item.source_name || '출처 미상'} · ${
      item.published_at ? formatDateTime(item.published_at) : '시각 미상'
    }`;
    li.appendChild(meta);

    if (item.impact_label) {
      const impact = document.createElement('span');
      impact.className = 'news-impact';
      if (item.impact_label.includes('긍정')) impact.classList.add('news-impact--pos');
      if (item.impact_label.includes('부정')) impact.classList.add('news-impact--neg');
      impact.textContent = item.impact_label;
      li.appendChild(impact);
    }

    list.appendChild(li);
  });
}

// ------------------------------------------------------------
// 거래 내역 (CRUD)
// ------------------------------------------------------------
function setupTransactionForm() {
  $('#transaction-form').addEventListener('submit', (e) => {
    e.preventDefault();
    saveTransaction();
  });
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
  $('#tx-id').value = '';
  $('#tx-error').hidden = true;
  setTxFormMode(null);
}

function showTxError(msg) {
  const el = $('#tx-error');
  el.textContent = msg;
  el.hidden = false;
}

async function saveTransaction() {
  $('#tx-error').hidden = true;

  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return showTxError('로그인이 필요합니다.');

  const payload = {
    user_id: session.user.id,
    ticker: $('#tx-ticker').value.trim(),
    stock_name: $('#tx-stock-name').value.trim(),
    transaction_type: $('#tx-type').value,
    trade_date: $('#tx-date').value,
    unit_price: parseFloat($('#tx-price').value),
    quantity: parseFloat($('#tx-qty').value),
    fee: $('#tx-fee').value ? parseFloat($('#tx-fee').value) : null,
    tax: $('#tx-tax').value ? parseFloat($('#tx-tax').value) : null,
    memo: $('#tx-memo').value.trim() || null,
  };

  if (!/^\d{6}$/.test(payload.ticker)) return showTxError('종목코드는 6자리 숫자여야 합니다.');
  if (!payload.stock_name) return showTxError('종목명을 입력하세요.');
  if (!payload.trade_date) return showTxError('거래일을 입력하세요.');
  if (!(payload.unit_price > 0) || !(payload.quantity > 0))
    return showTxError('단가와 수량은 0보다 커야 합니다.');
  if (payload.fee != null && payload.fee < 0) return showTxError('수수료는 0 이상이어야 합니다.');
  if (payload.tax != null && payload.tax < 0) return showTxError('세금은 0 이상이어야 합니다.');

  if (payload.transaction_type === 'SELL') {
    const ok = await canSell(payload.ticker, payload.quantity, editingTxId);
    if (!ok) return showTxError('매도 수량이 현재 보유 수량보다 많습니다.');
  }

  const btn = $('#tx-submit-btn');
  btn.disabled = true;
  btn.textContent = editingTxId ? '수정 중…' : '저장 중…';

  try {
    let error;
    if (editingTxId) {
      const { user_id, ...updateFields } = payload;
      ({ error } = await supabase
        .from('stock_transactions')
        .update(updateFields)
        .eq('id', editingTxId)
        .eq('user_id', session.user.id));
    } else {
      ({ error } = await supabase.from('stock_transactions').insert(payload));
    }
    if (error) throw error;

    resetTxForm();
    await loadHoldings();
  } catch (err) {
    showTxError(err.message || '거래 저장에 실패했습니다.');
  } finally {
    btn.disabled = false;
    btn.textContent = editingTxId ? '수정 저장' : '거래 저장';
  }
}

async function canSell(ticker, quantity, excludeId = null) {
  const { data, error } = await supabase
    .from('stock_transactions')
    .select('id, transaction_type, quantity')
    .eq('ticker', ticker);

  if (error) return false;

  let net = 0;
  for (const tx of data || []) {
    if (excludeId && tx.id === excludeId) continue;
    if (tx.transaction_type === 'BUY') net += Number(tx.quantity);
    else net -= Number(tx.quantity);
  }
  return quantity <= net + 1e-9;
}

async function editTransaction(id) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return;

  const { data, error } = await supabase
    .from('stock_transactions')
    .select('*')
    .eq('id', id)
    .eq('user_id', session.user.id)
    .single();

  if (error || !data) {
    alert('거래를 불러올 수 없습니다.');
    return;
  }

  $('#tx-ticker').value = data.ticker;
  $('#tx-stock-name').value = data.stock_name;
  $('#tx-type').value = data.transaction_type;
  $('#tx-date').value = data.trade_date;
  $('#tx-price').value = data.unit_price;
  $('#tx-qty').value = data.quantity;
  $('#tx-fee').value = data.fee ?? '';
  $('#tx-tax').value = data.tax ?? '';
  $('#tx-memo').value = data.memo ?? '';

  setTxFormMode(data);
  $('#tx-form-title').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function deleteTransaction(id) {
  if (!confirm('이 거래를 삭제하시겠습니까?')) return;

  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return;

  const { error } = await supabase
    .from('stock_transactions')
    .delete()
    .eq('id', id)
    .eq('user_id', session.user.id);

  if (error) {
    alert('삭제에 실패했습니다: ' + error.message);
    return;
  }
  await loadHoldings();
}

// ------------------------------------------------------------
// 보유 계산 (이동평균단가 방식)
// ------------------------------------------------------------
async function loadHoldings() {
  if (!currentUser) return;

  const { data, error } = await supabase
    .from('stock_transactions')
    .select('*')
    .order('trade_date', { ascending: true })
    .order('created_at', { ascending: true });

  if (error) {
    console.error('loadHoldings error:', error.message);
    return;
  }

  transactions = data || [];
  const holdings = computeHoldings(transactions);
  renderHoldingsSummary(holdings);
  renderHoldingsList(holdings);
}

function computeHoldings(txs) {
  const map = new Map();

  for (const tx of txs) {
    if (!map.has(tx.ticker)) {
      map.set(tx.ticker, {
        ticker: tx.ticker,
        stock_name: tx.stock_name,
        qty: 0,
        avgCost: 0,
        totalCost: 0,
        transactions: [],
      });
    }
    const h = map.get(tx.ticker);
    h.transactions.push(tx);

    const q = Number(tx.quantity);
    const p = Number(tx.unit_price);
    const fee = Number(tx.fee) || 0;

    if (tx.transaction_type === 'BUY') {
      h.totalCost += q * p + fee;
      h.qty += q;
      h.avgCost = h.qty > 0 ? h.totalCost / h.qty : 0;
    } else if (tx.transaction_type === 'SELL') {
      const sellQty = Math.min(q, h.qty);
      h.totalCost -= sellQty * h.avgCost;
      h.qty -= sellQty;
      h.avgCost = h.qty > 0 ? h.totalCost / h.qty : 0;
    }
  }

  return Array.from(map.values()).filter((h) => h.qty > 0);
}

function renderHoldingsSummary(holdings) {
  let totalCost = 0;
  holdings.forEach((h) => {
    totalCost += h.totalCost;
  });

  $('#total-cost').textContent = formatCurrency(totalCost);
  $('#total-value').textContent = holdings.length > 0 ? '현재가 조회 필요' : '-';
  $('#total-pnl').textContent = '-';
  $('#total-pnl-rate').textContent = '-';
}

function renderHoldingsList(holdings) {
  const list = $('#holdings-list');
  list.innerHTML = '';

  if (holdings.length === 0) {
    const p = document.createElement('p');
    p.className = 'empty-text';
    p.textContent = '아직 등록된 거래가 없습니다.';
    list.appendChild(p);
    return;
  }

  holdings.forEach((h) => {
    const card = document.createElement('div');
    card.className = 'holding-card';

    const header = document.createElement('div');
    header.className = 'holding-header';
    const left = document.createElement('div');
    const nameEl = document.createElement('h3');
    nameEl.className = 'holding-name';
    nameEl.textContent = h.stock_name;
    const tickerEl = document.createElement('p');
    tickerEl.className = 'holding-ticker';
    tickerEl.textContent = h.ticker;
    left.appendChild(nameEl);
    left.appendChild(tickerEl);
    header.appendChild(left);

    const qtyEl = document.createElement('div');
    qtyEl.className = 'holding-qty';
    qtyEl.textContent = `${formatNumber(h.qty)}주`;
    header.appendChild(qtyEl);
    card.appendChild(header);

    const meta = document.createElement('dl');
    meta.className = 'holding-meta';
    meta.innerHTML = `
      <div><dt>평균 매수가</dt><dd>${formatCurrency(h.avgCost)}</dd></div>
      <div><dt>매수 원가</dt><dd>${formatCurrency(h.totalCost)}</dd></div>
    `;
    card.appendChild(meta);

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'tx-toggle';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.textContent = `거래 내역 보기 (${h.transactions.length}건)`;
    card.appendChild(toggle);

    const txList = document.createElement('div');
    txList.className = 'tx-list';
    txList.hidden = true;
    h.transactions.forEach((tx) => {
      txList.appendChild(renderTransactionRow(tx));
    });
    card.appendChild(txList);

    toggle.addEventListener('click', () => {
      const expanded = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', String(!expanded));
      txList.hidden = expanded;
      toggle.textContent = expanded
        ? `거래 내역 보기 (${h.transactions.length}건)`
        : '거래 내역 숨기기';
    });

    list.appendChild(card);
  });
}

function renderTransactionRow(tx) {
  const row = document.createElement('div');
  row.className = 'tx-row';

  const main = document.createElement('div');
  main.className = 'tx-main';

  const typeClass = tx.transaction_type === 'BUY' ? 'tx-type-buy' : 'tx-type-sell';
  const typeLabel = tx.transaction_type === 'BUY' ? '매수' : '매도';

  main.innerHTML = `
    <div>
      <span class="${typeClass}">${typeLabel}</span>
      ${formatNumber(tx.quantity)}주 × ${formatCurrency(tx.unit_price)}
    </div>
    <div class="tx-date">
      ${escapeHtml(tx.trade_date)}${tx.memo ? ` · ${escapeHtml(tx.memo)}` : ''}
    </div>
  `;
  row.appendChild(main);

  const actions = document.createElement('div');
  actions.className = 'tx-actions';

  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'tx-action-btn';
  editBtn.textContent = '수정';
  editBtn.addEventListener('click', () => editTransaction(tx.id));
  actions.appendChild(editBtn);

  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'tx-action-btn tx-action-btn--danger';
  delBtn.textContent = '삭제';
  delBtn.addEventListener('click', () => deleteTransaction(tx.id));
  actions.appendChild(delBtn);

  row.appendChild(actions);
  return row;
}

// ------------------------------------------------------------
// 유틸
// ------------------------------------------------------------
function formatNumber(n) {
  return Number(n).toLocaleString('ko-KR', { maximumFractionDigits: 6 });
}

function formatCurrency(n) {
  return Number(n).toLocaleString('ko-KR', { maximumFractionDigits: 0 }) + '원';
}

function formatDateTime(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  return d.toLocaleString('ko-KR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ------------------------------------------------------------
// 시작
// ------------------------------------------------------------
init();