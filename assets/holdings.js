// assets/holdings.js
import {
  supabase, state, $,
  updateDataStatusBadge, computeHoldings
} from './core.js';
import { 
  renderHoldingsList, renderHoldingsSummary, renderOverSellWarning 
} from './holdings_ui.js';

export function initHoldings() {
  $('#transaction-form').addEventListener('submit', (e) => { e.preventDefault(); saveTransaction(); });
  $('#tx-cancel-btn').addEventListener('click', resetTxForm);

  // ★ 이벤트 위임: 동적으로 생성되는 수정/삭제 버튼 처리
  $('#holdings-list').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const action = btn.getAttribute('data-action');
    const id = btn.getAttribute('data-id');
    if (action === 'edit') editTransaction(id);
    else if (action === 'delete') deleteTransaction(id);
  });
  
  // 초과 매도 경고창의 수정 버튼 처리
  const screenHoldings = document.querySelector('#screen-holdings');
  if (screenHoldings) {
    screenHoldings.addEventListener('click', (e) => {
      const btn = e.target.closest('#over-sell-warning button[data-action="edit"]');
      if (!btn) return;
      document.querySelector('[data-screen="holdings"]').click();
      editTransaction(btn.getAttribute('data-id'));
    });
  }
}

export async function loadHoldings() {
  if (!state.currentUser) return;
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
    updateDataStatusBadge('ERROR');
    return;
  }
  state.transactions = data || [];
  await refreshHoldingsView();
}

export async function refreshHoldingsView(holdingsData) {
  if (!holdingsData) holdingsData = computeHoldings(state.transactions);
  const { currentHoldings, closedHoldings, overSells } = holdingsData;

  renderOverSellWarning(overSells || []);

  let totalCost = 0, totalCurrentValue = 0;
  const currentPriceMap = new Map();

  if (currentHoldings.length === 0) {
    renderHoldingsList([], currentPriceMap, closedHoldings);
    renderHoldingsSummary(holdingsData, 0, 0);
    updateDataStatusBadge('OK');
    return;
  }

  let anySuccess = false, lastSuccessfulStatus = null;

  for (const h of currentHoldings) {
    totalCost += h.totalCost;
    let price = null;
    try {
      const res = await fetch(`/api/quote?ticker=${encodeURIComponent(h.ticker)}`);
      if (res.ok) {
        const q = await res.json();
        anySuccess = true; lastSuccessfulStatus = q.data_status;
        if (q.price != null && q.price > 0) { price = q.price; state.priceCache.set(h.ticker, q.price); }
      }
    } catch (e) { console.warn(`[refreshHoldingsView] quote ${h.ticker} exception:`, e.message); }

    if (price == null) price = state.priceCache.get(h.ticker) || null;
    currentPriceMap.set(h.ticker, price);
    totalCurrentValue += (price || h.avgCost) * h.qty;
    await new Promise(r => setTimeout(r, 500));
  }

  if (anySuccess && lastSuccessfulStatus) updateDataStatusBadge(lastSuccessfulStatus);
  else updateDataStatusBadge('ERROR');

  renderHoldingsList(currentHoldings, currentPriceMap, closedHoldings);
  renderHoldingsSummary(holdingsData, totalCost, totalCurrentValue);
}

function setTxFormMode(tx) {
  state.editingTxId = tx?.id || null;
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

function previewOverSellIncrease(ticker, tradeDate, price, qty) {
  const beforeOverSell = computeHoldings(state.transactions).overSells.length;
  const simulated = state.transactions.map(t =>
    t.id === state.editingTxId ? { ...t, ticker, trade_date: tradeDate, unit_price: price, quantity: qty } : t
  );
  const afterOverSell = computeHoldings(simulated).overSells.length;
  return afterOverSell > beforeOverSell ? (afterOverSell - beforeOverSell) : 0;
}

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
    if (normIn !== normResolved && !confirm(`'${nameOnly}' → ${qData.stock_name}(${qData.ticker})로 저장할까요?`)) throw new Error('거래 저장을 취소했습니다.');

    if (type === 'SELL') {
      const ok = await canSell(qData.ticker, qty, tradeDate, state.editingTxId);
      if (!ok) throw new Error(`${tradeDate} 시점의 보유 수량을 초과하는 매도입니다.`);
    }

    if (type === 'BUY' && state.editingTxId) {
      const newOverSells = previewOverSellIncrease(qData.ticker, tradeDate, price, qty);
      if (newOverSells > 0 && !confirm(`이 수정으로 인해 초과 매도가 ${newOverSells}건 새로 발생합니다. 계속하시겠습니까?`)) throw new Error('거래 저장을 취소했습니다.');
    }

    const payload = {
      user_id: session.user.id, ticker: qData.ticker, stock_name: qData.stock_name || nameOnly,
      transaction_type: type, trade_date: tradeDate, unit_price: price, quantity: qty,
    };

    btn.textContent = state.editingTxId ? '수정 중…' : '저장 중…';
    let error;
    if (state.editingTxId) {
      const { user_id, ...updateFields } = payload;
      ({ error } = await supabase.from('stock_transactions').update(updateFields).eq('id', state.editingTxId).eq('user_id', session.user.id));
    } else {
      ({ error } = await supabase.from('stock_transactions').insert(payload));
    }
    if (error) throw error;

    if (state.editingTxId) {
      const oldTx = state.transactions.find(t => t.id === state.editingTxId);
      if (oldTx?.ticker) state.analysisCache.delete(oldTx.ticker);
    }
    if (qData.ticker) state.analysisCache.delete(qData.ticker);

    resetTxForm();
    await loadHoldings();
  } catch (err) { showTxError(err.message || '거래 저장에 실패했습니다.'); }
  finally { btn.disabled = false; btn.textContent = state.editingTxId ? '수정 저장' : '거래 저장'; }
}

async function canSell(ticker, quantity, sellDate, excludeId = null) {
  const { data, error } = await supabase.from('stock_transactions').select('id, transaction_type, quantity, trade_date, created_at').eq('ticker', ticker).eq('user_id', state.currentUser?.id || '');
  if (error) return false;

  let excludeCreatedAt = null;
  if (excludeId) {
    const found = (data || []).find(tx => tx.id === excludeId);
    if (found) excludeCreatedAt = found.created_at;
  }

  let net = 0;
  for (const tx of data || []) {
    if (excludeId && tx.id === excludeId) continue;
    if (tx.trade_date > sellDate) continue;
    if (tx.trade_date === sellDate && excludeCreatedAt && tx.created_at && tx.created_at >= excludeCreatedAt) continue;
    const q = Number(tx.quantity) || 0;
    if (tx.transaction_type === 'BUY') net += q; else net -= q;
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

  const target = state.transactions.find(t => t.id === id);
  const deletedTicker = target?.ticker || null;

  const { error } = await supabase.from('stock_transactions').delete().eq('id', id).eq('user_id', session.user.id);
  if (error) { alert('삭제에 실패했습니다: ' + error.message); return; }

  if (deletedTicker) state.analysisCache.delete(deletedTicker);
  await loadHoldings();
}