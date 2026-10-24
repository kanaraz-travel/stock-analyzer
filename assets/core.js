// assets/core.js
// 전역 상태, Supabase 클라이언트, 공용 헬퍼. 이 파일은 어떤 다른 파일도 import하지 않음(순환 방지).
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

export const SUPABASE_URL = 'https://hexykwjjkkozbeaqziem.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhleHlrd2pqa2tvemJlYXF6aWVtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE3OTk0MzUsImV4cCI6MjEwNzM3NTQzNX0.r4m4TY8dkkb19PKmMqdDH3_SicTUpt2DoXeDVSE1M3g';

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

// 순수 계산: 보유 종목 집계 (거래 이력 정렬 후 FIFO-like 평균단가 계산)
export function computeHoldings(txs) {
  const map = new Map();
  let totalRealizedPnl = 0, totalRealizedCost = 0;
  const overSells = [];
  const overSellTickers = new Set();

  const sorted = [...txs].sort((a, b) => {
    const da = a.trade_date || ''; const db = b.trade_date || '';
    if (da !== db) return da < db ? -1 : 1;
    return (a.created_at || '').localeCompare(b.created_at || '');
  });

  for (const tx of sorted) {
    if (!tx.ticker || typeof tx.ticker !== 'string' || !tx.stock_name) {
      console.warn('[computeHoldings] 유효하지 않은 거래 데이터 필터링됨:', tx);
      continue;
    }
    const txType = String(tx.transaction_type || '').toUpperCase();
    if (!map.has(tx.ticker)) {
      map.set(tx.ticker, { ticker: tx.ticker, stock_name: tx.stock_name, qty: 0, avgCost: 0, totalCost: 0, transactions: [], hasOverSell: false });
    }
    const h = map.get(tx.ticker);
    h.transactions.push(tx);
    const q = Number(tx.quantity), p = Number(tx.unit_price);

    if (txType === 'BUY') {
      h.totalCost += q * p; h.qty += q;
      h.avgCost = h.qty > 0 ? h.totalCost / h.qty : 0;
    } else if (txType === 'SELL') {
      if (q > h.qty + 1e-9) {
        overSells.push({ tx_id: tx.id, ticker: tx.ticker, stock_name: tx.stock_name, trade_date: tx.trade_date, attempted: q, available: h.qty });
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