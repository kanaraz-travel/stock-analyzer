// assets/app.js
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const SUPABASE_URL = 'https://hexykwjjkkozbeaqziem.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhleHlrd2pqa2tvemJlYXF6aWVtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE3OTk0MzUsImV4cCI6MjEwNzM3NTQzNX0.r4m4TY8dkkb19PKmMqdDH3_SicTUpt2DoXeDVSE1M3g';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});

const ALLOWED_NAMES = ['박필립', '윤혜영'];
let currentUser = null, currentQuote = null, transactions = [], refreshTimer = null, editingTxId = null;
let selectedSellTarget = null; // 매도 분석용 선택된 종목

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

async function init() {
  renderLoginButtons(); setupLogoutButton(); setupNavigation(); setupAccordions();
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
    await loadHoldings();
  } else {
    $('#screen-login').hidden = false; $('#app-shell').hidden = true; resetState();
  }
}

function mapEmailToName(email) {
  if (!email) return '';
  const map = { 'philip@kanaraz-travel.test': '박필립', 'hyeyoung@kanaraz-travel.test': '윤혜영' };
  return map[email.toLowerCase()] || '';
}

function resetState() {
  stopAutoRefresh(); currentQuote = null; selectedSellTarget = null; transactions = []; editingTxId = null;
  $('#quote-card').hidden = true; $('#analysis-result').hidden = true;
  $('#sell-quote-card').hidden = true; $('#sell-analysis-result').hidden = true;
  $('#ticker-input').value = ''; $('#search-error').hidden = true;
  $('#transaction-form').reset(); $('#tx-id').value = ''; $('#tx-error').hidden = true;
  setTxFormMode(null); $('#holdings-list').innerHTML = '<p class="empty-text">아직 등록된 거래가 없습니다.</p>';
  $('#sell-target-list').innerHTML = '<p class="empty-text">보유 중인 종목이 없습니다.</p>';
  ['#total-cost', '#total-value', '#total-pnl', '#realized-pnl'].forEach((id) => { $(id).textContent = '-'; });
  $$('.login-name-btn').forEach((b) => (b.disabled = false));
  $('#login-error').hidden = true; $('#login-loading').hidden = true;
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

function setupLogoutButton() { $('#logout-btn').addEventListener('click', async () => { if (!confirm('로그아웃하시겠습니까?')) return; stopAutoRefresh(); await supabase.auth.signOut(); }); }

function setupNavigation() {
  $$('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.screen;
      $$('.nav-btn').forEach((b) => b.classList.toggle('nav-btn--active', b === btn));
      $('#screen-buy').classList.toggle('screen--active', target === 'buy');
      $('#screen-holdings').classList.toggle('screen--active', target === 'holdings');
      $('#screen-sell').classList.toggle('screen--active', target === 'sell');
      
      if (target === 'holdings' || target === 'sell') loadHoldings();
    });
  });
}

function setupAccordions() { $$('.accordion-trigger').forEach((trigger) => { trigger.addEventListener('click', () => { const expanded = trigger.getAttribute('aria-expanded') === 'true'; trigger.setAttribute('aria-expanded', String(!expanded)); }); }); }
function setupSearch() { $('#search-btn').addEventListener('click', handleSearch); $('#ticker-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') handleSearch(); }); }

async function handleSearch() {
  const query = $('#ticker-input').value.trim(), errorEl = $('#search-error');
  errorEl.hidden = true;
  if (!query) { errorEl.textContent = '종목명 또는 종목코드를 입력해 주세요.'; errorEl.hidden = false; return; }
  const btn = $('#search-btn'); btn.disabled = true; btn.textContent = '조회 중…';
  try {
    const res = await fetch(`/api/quote?ticker=${encodeURIComponent(query)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '시세를 가져오지 못했습니다.');
    currentQuote = data; renderQuote(data); updateMarketBadges(data); startAutoRefresh();
  } catch (err) {
    errorEl.textContent = err.message || '시세를 가져오지 못했습니다. 잠시 후 다시 확인해 주세요.';
    errorEl.hidden = false; $('#quote-card').hidden = true; $('#analysis-result').hidden = true; stopAutoRefresh();
  } finally { btn.disabled = false; btn.textContent = '조회'; }
}

function renderQuote(q) {
  $('#quote-card').hidden = false;
  $('#stock-name').textContent = q.stock_name || q.ticker; $('#stock-ticker').textContent = q.ticker;
  $('#current-price').textContent = q.price != null ? formatNumber(q.price) + '원' : '-';
  const changeEl = $('#change-rate');
  if (q.change_rate != null) {
    const sign = q.change_rate > 0 ? '+' : '';
    changeEl.textContent = `${sign}${q.change_rate.toFixed(2)}%`;
    changeEl.className = 'change-rate ' + (q.change_rate > 0 ? 'positive' : q.change_rate < 0 ? 'negative' : '');
  } else { changeEl.textContent = '-'; changeEl.className = 'change-rate'; }
  $('#quote-as-of').textContent = `시세 시각: ${q.quote_as_of ? formatDateTime(q.quote_as_of) : '-'}`;
  $('#quote-provider').textContent = `출처: ${q.provider || '-'}`; $('#analysis-result').hidden = true;
}

function updateMarketBadges(q) {
  $('#market-status-badge').textContent = q.market_status || '상태 확인 중';
  const dataBadge = $('#data-status-badge');
  if (q.data_status === 'LATEST') { dataBadge.textContent = '방금 조회된 시세'; dataBadge.className = 'badge badge--positive'; }
  else if (q.data_status === 'DELAYED') { dataBadge.textContent = '지연된 시세'; dataBadge.className = 'badge badge--warning'; }
  else { dataBadge.textContent = '일부 정보 부족'; dataBadge.className = 'badge badge--muted'; }
}

function startAutoRefresh() {
  stopAutoRefresh();
  refreshTimer = setInterval(() => {
    if (document.hidden || !currentQuote?.ticker) return;
    if ($('#ticker-input').value.trim() !== currentQuote.ticker && $('#ticker-input').value.trim() !== currentQuote.stock_name) return;
    refreshQuoteSilently(currentQuote.ticker);
  }, 45000);
}
function stopAutoRefresh() { if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; } }
async function refreshQuoteSilently(ticker) {
  try {
    const res = await fetch(`/api/quote?ticker=${encodeURIComponent(ticker)}`);
    if (!res.ok) return;
    const data = await res.json();
    if (currentQuote?.ticker === ticker) { currentQuote = data; renderQuote(data); updateMarketBadges(data); }
  } catch {}
}
function setupVisibility() { document.addEventListener('visibilitychange', () => { if (document.hidden) stopAutoRefresh(); else if (currentQuote) startAutoRefresh(); }); }

// ------------------------------------------------------------
// 매수 분석
// ------------------------------------------------------------
function setupAnalyze() { $('#analyze-btn').addEventListener('click', () => runAnalysis('buy')); $('#sell-analyze-btn').addEventListener('click', () => runAnalysis('sell')); }

async function runAnalysis(type) {
  const targetTicker = type === 'sell' ? selectedSellTarget?.ticker : currentQuote?.ticker;
  const targetName = type === 'sell' ? selectedSellTarget?.stock_name : currentQuote?.stock_name;
  const targetPrice = type === 'sell' ? selectedSellTarget?.current_price : currentQuote?.price;

  if (!targetTicker) return;

  const { data: { session } } = await supabase.auth.getSession();
  if (!session) { alert('로그인이 필요합니다.'); return; }

  const btn = type === 'sell' ? $('#sell-analyze-btn') : $('#analyze-btn');
  const resultContainer = type === 'sell' ? $('#sell-analysis-result') : $('#analysis-result');
  
  btn.disabled = true; btn.textContent = '분석 중…'; resultContainer.hidden = true;

  try {
    const payload = {
      ticker: targetTicker, stock_name: targetName || targetTicker, analysis_type: type,
      price_data: { current_price: targetPrice, quote_as_of: new Date().toISOString(), return_1d: null, return_5d: null, return_20d: null, volatility_20d: null, quote_is_stale: false },
      volume_data: null, news_items: [],
    };

    if (type === 'sell' && selectedSellTarget) {
      payload.holdings_data = {
        avg_cost: selectedSellTarget.avgCost,
        quantity: selectedSellTarget.qty,
        return_rate: ((targetPrice - selectedSellTarget.avgCost) / selectedSellTarget.avgCost) * 100
      };
    }

    const res = await fetch('/api/analyze', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.access_token}` }, body: JSON.stringify(payload) });
    const data = await res.json(); if (!res.ok) throw new Error(data.error || '분석에 실패했습니다.');
    
    renderAnalysisResult(data, type);
    fetchNewsSilently(targetTicker, type);
  } catch (err) { alert(err.message || '분석에 실패했습니다.'); }
  finally { btn.disabled = false; btn.textContent = type === 'sell' ? 'AI 매도 분석하기' : '매수 분석하기'; }
}

function renderAnalysisResult(data, type) {
  const isSell = type === 'sell';
  const prefix = isSell ? 'sell-' : '';
  
  $(`#${prefix}analysis-result`).hidden = false;
  const badge = $(`#${prefix}recommendation-badge`); badge.textContent = data.recommendation || '판단 보류'; badge.className = 'recommendation-badge';
  
  const rec = data.recommendation || '';
  if (rec.includes('매수')) badge.classList.add('recommendation-badge--buy');
  else if (rec.includes('매도')) badge.classList.add('recommendation-badge--sell');
  else if (rec.includes('기다리기') || rec.includes('보유')) badge.classList.add('recommendation-badge--hold');
  else badge.classList.add('recommendation-badge--pending');

  $(`#${prefix}analysis-timestamp`).textContent = `분석 시각: ${formatDateTime(new Date().toISOString())}`;
  $(`#${prefix}overall-summary`).textContent = data.overall_summary || '-';

  $(`#${prefix}price-flow-summary`).textContent = data.price_flow_summary || '데이터가 부족합니다.';
  $(`#${prefix}volume-summary`).textContent = data.volume_summary || '데이터가 부족합니다.';
  $(`#${prefix}news-summary`).textContent = data.news_summary || '확인된 뉴스가 없습니다.';
  $(`#${prefix}price-tip`).textContent = data.price_tip || '참고용입니다.';
  $(`#${prefix}volume-tip`).textContent = data.volume_tip || '참고용입니다.';
  
  $(`#${prefix}ai-fallback-note`).hidden = !data.fallback;
  if (data.fallback && data.debug) console.warn('AI Fallback 발생 원인:', data.debug);
  renderNewsList(data.news_items || [], type);
}

async function fetchNewsSilently(ticker, type) {
  try {
    const res = await fetch(`/api/news?ticker=${encodeURIComponent(ticker)}`);
    if (!res.ok) return;
    const data = await res.json();
    if (Array.isArray(data.items) && data.items.length > 0) {
      renderNewsList(data.items, type);
      if(type === 'buy') $('#news-delay-note').hidden = !data.delayed;
    }
  } catch {}
}

function renderNewsList(items, type) {
  const list = $(type === 'sell' ? '#sell-news-list' : '#news-list');
  list.innerHTML = '';
  if (!Array.isArray(items) || items.length === 0) { const li = document.createElement('li'); li.className = 'note-text'; li.textContent = '표시할 뉴스/공시가 없습니다.'; list.appendChild(li); return; }
  items.slice(0, 5).forEach((item) => {
    const li = document.createElement('li');
    if (item.url) { const a = document.createElement('a'); a.className = 'news-title'; a.href = item.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = item.title || '제목 없음'; li.appendChild(a); }
    else { const span = document.createElement('span'); span.className = 'news-title'; span.textContent = item.title || '제목 없음'; li.appendChild(span); }
    const meta = document.createElement('div'); meta.className = 'news-meta'; meta.textContent = `${item.source_name || '출처 미상'} · ${item.published_at ? formatDateTime(item.published_at) : '시각 미상'}`; li.appendChild(meta);
    list.appendChild(li);
  });
}

// ------------------------------------------------------------
// 보유 주식 (DB, 요약, 매도 타겟)
// ------------------------------------------------------------
async function loadHoldings() {
  if (!currentUser) return;
  const { data, error } = await supabase.from('stock_transactions').select('*').order('trade_date', { ascending: true }).order('created_at', { ascending: true });
  if (error) { console.error('loadHoldings error:', error.message); return; }
  
  transactions = data || []; 
  const holdingsData = computeHoldings(transactions);
  
  renderHoldingsList(holdingsData.currentHoldings);
  await renderHoldingsSummary(holdingsData);
  renderSellTargets(holdingsData.currentHoldings); // 매도 분석용 리스트 렌더링
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

async function renderHoldingsSummary(holdingsData) {
  const { currentHoldings, totalRealizedPnl, totalRealizedCost } = holdingsData; let totalCost = 0, totalCurrentValue = 0;
  
  // ★ 502 방지를 위해 동시 요청 대신 순차적(Sequential) 요청
  for (const h of currentHoldings) {
    totalCost += h.totalCost;
    try {
      const res = await fetch(`/api/quote?ticker=${h.ticker}`);
      if (res.ok) { const q = await res.json(); if (q.price != null) { totalCurrentValue += q.price * h.qty; continue; } }
    } catch {}
    totalCurrentValue += h.totalCost; // 실패 시 원가로 대체
    await new Promise(r => setTimeout(r, 150)); // 과부하 방지 딜레이
  }

  const unrealizedPnl = totalCurrentValue - totalCost;
  const unrealizedRate = totalCost > 0 ? (unrealizedPnl / totalCost) * 100 : 0;
  const realizedRate = totalRealizedCost > 0 ? (totalRealizedPnl / totalRealizedCost) * 100 : 0;

  $('#total-cost').textContent = formatCurrency(totalCost);
  $('#total-value').innerHTML = `${formatCurrency(totalCurrentValue)} <span class="summary-rate ${unrealizedRate > 0 ? 'positive' : unrealizedRate < 0 ? 'negative' : ''}">(${unrealizedRate > 0 ? '+' : ''}${unrealizedRate.toFixed(2)}%)</span>`;
  $('#total-pnl').innerHTML = `<span class="${unrealizedPnl > 0 ? 'positive' : unrealizedPnl < 0 ? 'negative' : ''}">${formatCurrency(unrealizedPnl)} (${unrealizedRate > 0 ? '+' : ''}${unrealizedRate.toFixed(2)}%)</span>`;
  $('#realized-pnl').innerHTML = `<span class="${totalRealizedPnl > 0 ? 'positive' : totalRealizedPnl < 0 ? 'negative' : ''}">${formatCurrency(totalRealizedPnl)} (${realizedRate > 0 ? '+' : ''}${realizedRate.toFixed(2)}%)</span>`;
}

function renderHoldingsList(holdings) {
  const list = $('#holdings-list'); list.innerHTML = '';
  if (holdings.length === 0) { const p = document.createElement('p'); p.className = 'empty-text'; p.textContent = '아직 등록된 거래가 없습니다.'; list.appendChild(p); return; }
  holdings.forEach((h) => {
    const card = document.createElement('div'); card.className = 'holding-card';
    const header = document.createElement('div'); header.className = 'holding-header';
    const left = document.createElement('div'); const nameEl = document.createElement('h3'); nameEl.className = 'holding-name'; nameEl.textContent = `${h.stock_name} (${h.ticker})`; left.appendChild(nameEl);
    header.appendChild(left);
    const qtyEl = document.createElement('div'); qtyEl.className = 'holding-qty'; qtyEl.textContent = `${formatNumber(h.qty)}주`; header.appendChild(qtyEl); card.appendChild(header);
    const meta = document.createElement('dl'); meta.className = 'holding-meta'; meta.innerHTML = `<div><dt>평균 매수가</dt><dd>${formatCurrency(h.avgCost)}</dd></div><div><dt>매수 원가</dt><dd>${formatCurrency(h.totalCost)}</dd></div>`; card.appendChild(meta);
    const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'tx-toggle'; toggle.setAttribute('aria-expanded', 'false'); toggle.textContent = `거래 내역 보기 (${h.transactions.length}건)`; card.appendChild(toggle);
    const txList = document.createElement('div'); txList.className = 'tx-list'; txList.hidden = true; h.transactions.forEach((tx) => { txList.appendChild(renderTransactionRow(tx)); }); card.appendChild(txList);
    toggle.addEventListener('click', () => { const expanded = toggle.getAttribute('aria-expanded') === 'true'; toggle.setAttribute('aria-expanded', String(!expanded)); txList.hidden = expanded; toggle.textContent = expanded ? `거래 내역 보기 (${h.transactions.length}건)` : '거래 내역 숨기기'; });
    list.appendChild(card);
  });
}

// ★ 매도 분석 탭용 타겟 리스트 렌더링
async function renderSellTargets(holdings) {
  const list = $('#sell-target-list'); list.innerHTML = '';
  if (holdings.length === 0) { list.innerHTML = '<p class="empty-text">보유 중인 종목이 없습니다.</p>'; return; }

  for (const h of holdings) {
    let currentPrice = h.avgCost; // 기본값 원가
    try {
      const res = await fetch(`/api/quote?ticker=${h.ticker}`);
      if (res.ok) { const q = await res.json(); if (q.price != null) currentPrice = q.price; }
    } catch {}
    
    const returnRate = ((currentPrice - h.avgCost) / h.avgCost) * 100;
    const pnlClass = returnRate > 0 ? 'pos' : returnRate < 0 ? 'neg' : '';
    
    const item = document.createElement('div');
    item.className = 'sell-target-item';
    item.innerHTML = `
      <div class="sell-target-info">
        <span class="sell-target-name">${h.stock_name} (${h.ticker})</span>
        <span class="sell-target-pnl ${pnlClass}">수익률: ${returnRate > 0 ? '+' : ''}${returnRate.toFixed(2)}%</span>
      </div>
      <span class="btn btn--primary" style="padding: 8px 12px; font-size: 13px;">선택</span>
    `;
    item.addEventListener('click', () => {
      $$('.sell-target-item').forEach(el => el.classList.remove('active'));
      item.classList.add('active');
      selectSellTarget(h, currentPrice);
    });
    list.appendChild(item);
    
    // 선택 상태 초기화 방지
    if (selectedSellTarget && selectedSellTarget.ticker === h.ticker) {
      item.classList.add('active');
      selectSellTarget(h, currentPrice);
    }
  }
}

function selectSellTarget(holding, currentPrice) {
  selectedSellTarget = { ...holding, current_price: currentPrice };
  $('#sell-quote-card').hidden = false;
  $('#sell-analysis-result').hidden = true;
  
  $('#sell-stock-name').textContent = holding.stock_name;
  $('#sell-stock-ticker').textContent = holding.ticker;
  $('#sell-current-price').textContent = formatNumber(currentPrice) + '원';
  $('#sell-avg-cost').textContent = formatCurrency(holding.avgCost);
  
  const returnRate = ((currentPrice - holding.avgCost) / holding.avgCost) * 100;
  const rateEl = $('#sell-return-rate');
  rateEl.textContent = `${returnRate > 0 ? '+' : ''}${returnRate.toFixed(2)}%`;
  rateEl.className = returnRate > 0 ? 'positive' : returnRate < 0 ? 'negative' : '';
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

// ------------------------------------------------------------
// 거래 등록 폼 (CRUD)
// ------------------------------------------------------------
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