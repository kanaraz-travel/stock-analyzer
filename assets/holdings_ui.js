// assets/holdings_ui.js
import { state, $, formatNumber, formatCurrency, getBorderColor } from './core.js';
import { runAnalysis } from './analysis.js';
import { renderInlineAnalysisResult } from './analysis_ui.js';

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
  const realizedPnlSign = totalRealizedPnl > 0 ? '+' : '';

  $('#total-value').innerHTML = `${formatCurrency(totalCurrentValue)} <span class="summary-rate ${unrealizedRate > 0 ? 'positive' : unrealizedRate < 0 ? 'negative' : ''}">(${unrealizedRate > 0 ? '+' : ''}${unrealizedRate.toFixed(2)}%)</span>`;
  $('#total-pnl').innerHTML = `<span class="${unrealizedPnl > 0 ? 'positive' : unrealizedPnl < 0 ? 'negative' : ''}">${unrealizedPnl > 0 ? '+' : ''}${formatCurrency(unrealizedPnl)} (${unrealizedRate > 0 ? '+' : ''}${unrealizedRate.toFixed(2)}%)</span>`;
  $('#realized-pnl').innerHTML = `<span class="${totalRealizedPnl > 0 ? 'positive' : totalRealizedPnl < 0 ? 'negative' : ''}">${realizedPnlSign}${formatCurrency(totalRealizedPnl)} (${realizedRate > 0 ? '+' : ''}${realizedRate.toFixed(2)}%)</span>`;
}

export function renderHoldingsList(holdings, priceMap, closedHoldings = []) {
  const list = $('#holdings-list'); list.innerHTML = '';
  if (holdings.length === 0) {
    const p = document.createElement('p'); p.className = 'empty-text'; p.textContent = '아직 등록된 거래가 없습니다.';
    list.appendChild(p);
  } else {
    holdings.forEach((h) => {
      if (!h.ticker || !h.stock_name) return;

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
      const pnlLabel = (pnl == null) ? '산출 불가' : `${pnl > 0 ? '+' : ''}${formatCurrency(pnl)}`;
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
      if (state.analysisCache.has(h.ticker)) renderInlineAnalysisResult(state.analysisCache.get(h.ticker), card, false);

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
  renderClosedHoldings(closedHoldings);
}

function renderClosedHoldings(closedHoldings) {
  const oldSection = document.getElementById('closed-holdings-section');
  if (oldSection) oldSection.remove();
  if (!closedHoldings || closedHoldings.length === 0) return;

  const section = document.createElement('div');
  section.id = 'closed-holdings-section';
  section.style.cssText = 'margin-top:24px; border-top:1px solid #e2e8f0; padding-top:16px;';

  const header = document.createElement('div');
  header.style.cssText = 'display:flex; justify-content:space-between; align-items:center; cursor:pointer; padding: 8px 0;';
  
  const title = document.createElement('h3');
  title.style.cssText = 'font-size:16px; font-weight:bold; margin:0; color:#334155;';
  title.textContent = `매도 완료 종목 (${closedHoldings.length}건)`;
  
  const icon = document.createElement('span');
  icon.id = 'closed-holdings-icon';
  icon.style.cssText = 'font-size:12px; color:#64748b; transition: transform 0.2s;';
  icon.textContent = '▼';

  header.appendChild(title); header.appendChild(icon);
  section.appendChild(header);

  const list = document.createElement('div');
  list.id = 'closed-holdings-list';
  list.style.marginTop = '12px';
  list.style.display = 'none';

  closedHoldings.forEach(h => {
    const card = document.createElement('div');
    card.style.cssText = 'background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; padding:12px; margin-bottom:8px;';
    
    const pnlColor = h.realizedPnl > 0 ? '#ef4444' : h.realizedPnl < 0 ? '#3b82f6' : '#1e293b';
    const pnlSign = h.realizedPnl > 0 ? '+' : '';

    card.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
        <strong style="font-size:14px; color:#1e293b;">${h.stock_name}</strong>
        <span style="font-size:13px; font-weight:bold; color:${pnlColor};">
          ${pnlSign}${formatCurrency(h.realizedPnl)} (${h.realizedRate > 0 ? '+' : ''}${h.realizedRate.toFixed(2)}%)
        </span>
      </div>
      <div style="font-size:12px; color:#64748b; line-height:1.6;">
        <div>총 매수: ${formatCurrency(h.totalBuyCost)} (평균 ${formatCurrency(h.avgBuyPrice)})</div>
        <div>총 매도: ${formatCurrency(h.totalSellRevenue)} (평균 ${formatCurrency(h.avgSellPrice)})</div>
        <div>수량: ${formatNumber(h.totalQty)}주</div>
      </div>
    `;
    list.appendChild(card);
  });

  section.appendChild(list);

  header.addEventListener('click', () => {
    const isExpanded = list.style.display !== 'none';
    list.style.display = isExpanded ? 'none' : 'block';
    icon.style.transform = isExpanded ? 'rotate(0deg)' : 'rotate(180deg)';
  });

  const holdingsContainer = $('#holdings-list');
  if (holdingsContainer && holdingsContainer.parentNode) {
    holdingsContainer.parentNode.insertBefore(section, holdingsContainer.nextSibling);
  }
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
  // NOTE: editTransaction, deleteTransaction are in holdings.js, but we need them here.
  // To avoid circular dependency, we just dispatch CustomEvents or import them (since holdings.js is the parent).
  // Actually, it's easier to attach the event listeners in holdings.js when the DOM is created.
  // Let's just pass a callback or use global event dispatch. Wait, we can just import them directly since we didn't create a cycle (holdings.js imports holdings_ui.js, not the other way around).
  // Let's keep the buttons but use window event or import. I'll import from holdings.js (wait, holding.js imports this file, so circular dependency!).
  // Let's use event delegation in holdings.js for edit/delete buttons.
  // For now, I'll leave the buttons and handle the click in holdings.js.
  
  const editBtn = document.createElement('button');
  editBtn.type = 'button'; editBtn.className = 'tx-action-btn'; editBtn.textContent = '수정';
  editBtn.setAttribute('data-action', 'edit');
  editBtn.setAttribute('data-id', tx.id);
  actions.appendChild(editBtn);

  const delBtn = document.createElement('button');
  delBtn.type = 'button'; delBtn.className = 'tx-action-btn tx-action-btn--danger'; delBtn.textContent = '삭제';
  delBtn.setAttribute('data-action', 'delete');
  delBtn.setAttribute('data-id', tx.id);
  actions.appendChild(delBtn);

  row.appendChild(actions);
  return row;
}

export function renderOverSellWarning(overSells) {
  const existing = document.getElementById('over-sell-warning');
  if (existing) existing.remove();
  if (!overSells || overSells.length === 0) return;

  const warn = document.createElement('div');
  warn.id = 'over-sell-warning';
  warn.style.cssText = 'background:#fef3c7;border:1px solid #f59e0b;border-radius:12px;padding:12px;margin-bottom:12px;font-size:12px;color:#92400e;line-height:1.5;';

  const title = document.createElement('div');
  title.style.cssText = 'font-weight:700;margin-bottom:6px;';
  title.textContent = `⚠️ 초과 매도 거래 ${overSells.length}건 감지`;
  warn.appendChild(title);

  const desc = document.createElement('div');
  desc.style.cssText = 'font-size:11px;margin-bottom:8px;';
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
    editBtn.setAttribute('data-action', 'edit');
    editBtn.setAttribute('data-id', o.tx_id);
    line.appendChild(editBtn);
    warn.appendChild(line);
  });

  const summaryCard = document.querySelector('#screen-holdings .card');
  if (summaryCard && summaryCard.parentNode) summaryCard.parentNode.insertBefore(warn, summaryCard);
}