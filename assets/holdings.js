// assets/holdings.js
import { 
  supabase, state, $, $$, formatNumber, formatCurrency, formatDateTime, getBorderColor,
  updateMarketStatusBadge, updateDataStatusBadge
} from './app.js';

export function initHoldings() {
  $('#transaction-form').addEventListener('submit', (e) => { e.preventDefault(); saveTransaction(); });
  $('#tx-cancel-btn').addEventListener('click', resetTxForm);
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
  const { currentHoldings, overSells } = holdingsData;

  renderOverSellWarning(overSells || []);

  let totalCost = 0, totalCurrentValue = 0;
  const currentPriceMap = new Map();
  
  if (currentHoldings.length === 0) {
    renderHoldingsList([], currentPriceMap);
    renderHoldingsSummary(holdingsData, 0, 0);
    updateDataStatusBadge('OK');
    return;
  }

  let anySuccess = false;
  let lastSuccessfulStatus = null;

  for (const h of currentHoldings) {
    totalCost += h.totalCost;
    let price = null;
    try {
      const res = await fetch(`/api/quote?ticker=${encodeURIComponent(h.ticker)}`);
      if (res.ok) {
        const q = await res.json();
        anySuccess = true;
        lastSuccessfulStatus = q.data_status;
        if (currentPriceMap.size === 0) updateMarketStatusBadge(q.market_status);
        if (q.price != null && q.price > 0) { price = q.price; state.priceCache.set(h.ticker, q.price); }
      } else {
        console.warn(`[refreshHoldingsView] quote ${h.ticker} failed: HTTP ${res.status}`);
      }
    } catch (e) { 
      console.warn(`[refreshHoldingsView] quote ${h.ticker} exception:`, e.message);
    }

    if (price == null) price = state.priceCache.get(h.ticker) || null;

    currentPriceMap.set(h.ticker, price);
    totalCurrentValue += (price || h.avgCost) * h.qty;
    await new Promise(r => setTimeout(r, 500));
  }

  if (anySuccess && lastSuccessfulStatus) {
    updateDataStatusBadge(lastSuccessfulStatus);
  } else {
    updateDataStatusBadge('ERROR');
  }

  renderHoldingsList(currentHoldings, currentPriceMap);
  renderHoldingsSummary(holdingsData, totalCost, totalCurrentValue);
}

export function computeHoldings(txs) {
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
    if (!tx.ticker || typeof tx.ticker !== 'string' || !tx.stock_name) {
      console.warn('[computeHoldings] ⚠️ 유효하지 않은 거래 데이터 필터링됨:', tx);
      continue;
    }
    
    const txType = String(tx.transaction_type || '').toUpperCase();

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

    if (txType === 'BUY') {
      h.totalCost += q * p;
      h.qty += q;
      h.avgCost = h.qty > 0 ? h.totalCost / h.qty : 0;
    } else if (txType === 'SELL') {
      if (q > h.qty + 1e-9) {
        overSells.push({
          tx_id: tx.id, ticker: tx.ticker, stock_name: tx.stock_name,
          trade_date: tx.trade_date, attempted: q, available: h.qty,
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
    totalRealizedPnl, totalRealizedCost, overSells,
    overSellTickers: Array.from(overSellTickers), hasAnyOverSell: overSells.length > 0,
  };
}

export function renderHoldingsSummary(holdingsData, totalCost, totalCurrentValue) {
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

export function renderHoldingsList(holdings, priceMap) {
  const list = $('#holdings-list'); list.innerHTML = '';
  if (holdings.length === 0) {
    const p = document.createElement('p'); p.className = 'empty-text'; p.textContent = '아직 등록된 거래가 없습니다.';
    list.appendChild(p); return;
  }
  holdings.forEach((h) => {
    if (!h.ticker || !h.stock_name) {
      console.warn('[renderHoldingsList] ⚠️ 유효하지 않은 보유 종목 렌더링 스킵:', h);
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
    aiBtn.addEventListener('click', () => window.runAnalysis(h.ticker, h.stock_name, currentPrice, 'inline', card));
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
    if (state.analysisCache.has(h.ticker)) window.renderInlineAnalysisResult(state.analysisCache.get(h.ticker), card, false);

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

// ★ export 추가 완료
export function renderOverSellWarning(overSells) {
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
      document.querySelector('[data-screen="holdings"]').click();
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

// ★ 편집 저장 시: 이 편집으로 인해 "새로운" 초과 매도가 생기는지 확인 (기존 거래의 초과 매도는 카운트 제외)
function previewOverSellIncrease(ticker, tradeDate, price, qty) {
  const beforeOverSell = computeHoldings(state.transactions).overSells.length;
  const simulated = state.transactions.map(t =>
    t.id === state.editingTxId
      ? { ...t, ticker, trade_date: tradeDate, unit_price: price, quantity: qty }
      : t
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
    if (normIn !== normResolved && !confirm(`'${nameOnly}' → ${qData.stock_name}(${qData.ticker})로 저장할까요?`)) {
      throw new Error('거래 저장을 취소했습니다.');
    }

    if (type === 'SELL') {
      const ok = await canSell(qData.ticker, qty, tradeDate, state.editingTxId);
      if (!ok) throw new Error(`${tradeDate} 시점의 보유 수량을 초과하는 매도입니다.`);
    }

    // ★ BUY 편집 저장 시: 이 편집으로 인한 초과 매도 증가 여부 확인
    if (type === 'BUY' && state.editingTxId) {
      const newOverSells = previewOverSellIncrease(qData.ticker, tradeDate, price, qty);
      if (newOverSells > 0) {
        if (!confirm(`이 수정으로 인해 초과 매도가 ${newOverSells}건 새로 발생합니다. 계속하시겠습니까?\n\n(저장 후 화면의 경고를 확인해 주세요.)`)) {
          throw new Error('거래 저장을 취소했습니다.');
        }
      }
    }

    const payload = {
      user_id: session.user.id, ticker: qData.ticker,
      stock_name: qData.stock_name || nameOnly,
      transaction_type: type, trade_date: tradeDate,
      unit_price: price, quantity: qty,
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

    // ★ 캐시 무효화 (재렌더 이전에 반드시 실행) — 이전 ticker / 신규 ticker 모두 무효화
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
  const { data, error } = await supabase
    .from('stock_transactions')
    .select('id, transaction_type, quantity, trade_date, created_at')
    .eq('ticker', ticker)
    .eq('user_id', state.currentUser?.id || '');
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
    if (tx.trade_date === sellDate && excludeCreatedAt
        && tx.created_at && tx.created_at >= excludeCreatedAt) continue;
    const q = Number(tx.quantity) || 0;
    if (tx.transaction_type === 'BUY') net += q;
    else net -= q;
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

  // ★ 캐시 무효화 (삭제 이전에 ticker 확보)
  const target = state.transactions.find(t => t.id === id);
  const deletedTicker = target?.ticker || null;

  const { error } = await supabase.from('stock_transactions').delete().eq('id', id).eq('user_id', session.user.id);
  if (error) { alert('삭제에 실패했습니다: ' + error.message); return; }

  if (deletedTicker) state.analysisCache.delete(deletedTicker);

  await loadHoldings();
}