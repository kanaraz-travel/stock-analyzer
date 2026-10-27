// assets/search.js
import {
  state, $,
  formatNumber, formatDateTime,
  updateMarketStatusBadge, updateDataStatusBadge
} from './core.js';
import { renderAnalysisResult } from './analysis.js';

export function initSearch() {
  const searchBtn = $('#search-btn');
  const tickerInput = $('#ticker-input');
  if (searchBtn) searchBtn.addEventListener('click', handleSearch);
  if (tickerInput) tickerInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleSearch(); });
}

async function handleSearch() {
  const query = $('#ticker-input').value.trim();
  const errorEl = $('#search-error');
  if (errorEl) errorEl.hidden = true;
  const candidatesEl = document.getElementById('search-candidates');
  if (candidatesEl) candidatesEl.hidden = true;

  if (!query) {
    if (errorEl) { errorEl.textContent = '종목명을 입력해 주세요.'; errorEl.hidden = false; }
    return;
  }

  const btn = $('#search-btn');
  btn.disabled = true; btn.textContent = '조회 중';
  
  let httpStatus = 0; // ★ HTTP 상태 코드를 추적하기 위한 변수

  try {
    const res = await fetch(`/api/quote?ticker=${encodeURIComponent(query)}`);
    httpStatus = res.status;
    const data = await res.json();

    if (res.status === 409 && data.candidates) {
      state.currentQuote = null;
      $('#quote-card').hidden = true;
      $('#analysis-result').hidden = true;
      renderSearchCandidates(data.candidates);
      return;
    }

    if (!res.ok) throw new Error(data.error || '시세를 가져오지 못했습니다.');
    if (data.price == null) throw new Error('종목의 시세 정보가 없습니다.');

    state.currentQuote = data;
    if (data.price > 0) state.priceCache.set(data.ticker, data.price);
    renderQuote(data);
    updateMarketStatusBadge(data.market_status);
    updateDataStatusBadge(data.data_status);
  } catch (err) {
    if (errorEl) { errorEl.textContent = err.message || '시세를 가져오지 못했습니다.'; errorEl.hidden = false; }
    $('#quote-card').hidden = true; $('#analysis-result').hidden = true;
    
    // ★ 수정: 네트워크 오류(0)이거나 서버 오류(500 이상)일 때만 '연결 끊김' 표시
    // 404(종목 없음), 400(잘못된 요청) 등은 정상 통신이므로 '연결 원활' 유지
    if (httpStatus === 0 || httpStatus >= 500) {
      updateDataStatusBadge('ERROR');
    } else {
      updateDataStatusBadge('OK');
    }
  } finally {
    btn.disabled = false; btn.textContent = '조회';
  }
}

// 후보 목록 스크롤 렌더링 + parentNode null 방어
function renderSearchCandidates(candidates) {
  let container = document.getElementById('search-candidates');
  if (!container) {
    container = document.createElement('div');
    container.id = 'search-candidates';
    container.style.marginTop = '12px';
    container.style.padding = '12px';
    container.style.background = '#f8fafc';
    container.style.borderRadius = '8px';
    container.style.maxHeight = '300px';
    container.style.overflowY = 'auto';

    const errorEl = document.getElementById('search-error');
    if (errorEl && errorEl.parentNode) {
      errorEl.parentNode.insertBefore(container, errorEl.nextSibling);
    } else {
      const quoteCard = document.getElementById('quote-card');
      if (quoteCard && quoteCard.parentNode) quoteCard.parentNode.insertBefore(container, quoteCard);
      else document.body.appendChild(container);
    }
  }
  container.innerHTML = '';
  container.hidden = false;

  const title = document.createElement('div');
  title.style.fontSize = '13px';
  title.style.color = '#475569';
  title.style.marginBottom = '8px';
  title.style.position = 'sticky';
  title.style.top = '0';
  title.style.background = '#f8fafc';
  title.style.zIndex = '1';
  title.style.paddingBottom = '4px';
  title.textContent = `검색 결과가 ${candidates.length}개입니다. 종목을 선택해 주세요:`;
  container.appendChild(title);

  candidates.forEach(c => {
    const match = c.match(/^(.+)\((\d{6})\)$/);
    const name = match ? match[1] : c;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.style.display = 'block';
    btn.style.width = '100%';
    btn.style.textAlign = 'left';
    btn.style.padding = '10px 12px';
    btn.style.marginBottom = '4px';
    btn.style.background = '#ffffff';
    btn.style.border = '1px solid #e2e8f0';
    btn.style.borderRadius = '6px';
    btn.style.fontSize = '14px';
    btn.style.cursor = 'pointer';
    btn.style.color = '#1e293b';
    btn.textContent = c;
    btn.addEventListener('mouseenter', () => btn.style.background = '#f1f5f9');
    btn.addEventListener('mouseleave', () => btn.style.background = '#ffffff');
    btn.addEventListener('click', () => {
      $('#ticker-input').value = name;
      container.hidden = true;
      handleSearch();
    });
    container.appendChild(btn);
  });
}

function renderQuote(q) {
  $('#quote-card').hidden = false;
  $('#stock-name').textContent = q.stock_name || q.ticker;
  $('#current-price').textContent = q.price != null && q.price > 0 ? formatNumber(q.price) + '원' : '-';
  const changeEl = $('#change-rate');
  if (q.change_rate != null) {
    const sign = q.change_rate > 0 ? '+' : '';
    changeEl.textContent = `${sign}${q.change_rate.toFixed(2)}%`;
    changeEl.className = 'change-rate ' + (q.change_rate > 0 ? 'positive' : q.change_rate < 0 ? 'negative' : '');
  } else { changeEl.textContent = '-'; changeEl.className = 'change-rate'; }

  const ms = String(q.market_status || '');
  const ds = String(q.data_status || '');
  const isMarketClosed = ds === 'MARKET_CLOSED' || ms.includes('휴장') || ms.includes('장마감') || ms.includes('장 마감');
  const isAfterHours = ds === 'AFTER_HOURS' || ds === 'AFTER_MARKET';

  let timeLabel = '';
  if (q.quote_as_of) {
    timeLabel = `시세 기준 시각: ${formatDateTime(q.quote_as_of)}`;
  } else if (q.server_time) {
    const ts = formatDateTime(q.server_time);
    if (isMarketClosed) timeLabel = `데이터 조회 시각: ${ts} · 장 마감 종가`;
    else if (isAfterHours) timeLabel = `데이터 조회 시각: ${ts} · 시간외 (정규장 종가 기준)`;
    else timeLabel = `데이터 조회 시각: ${ts} (시세 기준 시각 미확인)`;
  } else {
    timeLabel = '시각 정보 없음';
  }
  $('#quote-as-of').textContent = timeLabel;

  if (state.analysisCache.has(q.ticker)) {
    renderAnalysisResult(state.analysisCache.get(q.ticker), false);
  } else {
    $('#analysis-result').hidden = true;
  }
}

export async function refreshQuoteSilently(ticker) {
  try {
    const res = await fetch(`/api/quote?ticker=${encodeURIComponent(ticker)}`);
    if (!res.ok) { 
      // ★ 수정: 500 이상일 때만 ERROR 표시
      if (res.status >= 500) updateDataStatusBadge('ERROR');
      return; 
    }
    const data = await res.json();
    if (state.currentQuote?.ticker === ticker) {
      if (data.price > 0) state.priceCache.set(ticker, data.price);
      state.currentQuote = data;
      renderQuote(data);
      updateMarketStatusBadge(data.market_status);
      updateDataStatusBadge(data.data_status);
    }
  } catch { updateDataStatusBadge('ERROR'); }
}