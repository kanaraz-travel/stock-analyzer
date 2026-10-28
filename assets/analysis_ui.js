// assets/analysis_ui.js
import { state, $, formatDateTime } from './core.js';

export function renderAnalysisResult(data, scrollTo = true) {
  $('#analysis-result').hidden = false;
  const badge = $('#recommendation-badge');
  badge.textContent = data.recommendation || '판단 보류';
  badge.className = 'recommendation-badge';
  const rec = data.recommendation || '';

  let warningEl = document.getElementById('fallback-warning');
  if (!warningEl) {
    warningEl = document.createElement('div');
    warningEl.id = 'fallback-warning';
    warningEl.style.cssText = 'margin-top:12px; padding:10px; background:#fef3c7; color:#92400e; border:1px solid #f59e0b; border-radius:8px; font-size:12px; line-height:1.4; display:none;';
    const target = document.getElementById('overall-summary');
    if (target && target.parentNode) target.parentNode.appendChild(warningEl);
  }

  if (data.fallback) {
    badge.classList.add('recommendation-badge--pending');
    badge.textContent = `임시 판단: ${rec}`;
    if (warningEl) {
      warningEl.textContent = data.fallback_message || '⚠️ 임시 판단입니다.';
      warningEl.style.display = 'block';
    }
  } else {
    if (rec.includes('매수')) badge.classList.add('recommendation-badge--buy');
    else if (rec.includes('매도')) badge.classList.add('recommendation-badge--sell');
    else if (rec.includes('기다리기') || rec.includes('보유')) badge.classList.add('recommendation-badge--hold');
    else badge.classList.add('recommendation-badge--pending');
    if (warningEl) warningEl.style.display = 'none';
  }

  $('#analysis-timestamp').textContent = `분석 시각: ${formatDateTime(data.analyzed_at || new Date().toISOString())}`;
  $('#overall-summary').textContent = data.overall_summary || '-';

  if (scrollTo && state.currentScreen === 'analysis') {
    $('#analysis-result').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

export function renderInlineAnalysisResult(data, cardElement, scrollTo = true) {
  const container = cardElement.querySelector('.holding-inline-result');
  if (!container) return;
  container.hidden = false;
  container.innerHTML = '';

  const rec = data.recommendation || '판단 보류';
  let badgeClass = 'recommendation-badge--pending';
  let badgeText = rec;
  if (data.fallback) { badgeClass = 'recommendation-badge--pending'; badgeText = `임시 판단: ${rec}`; }
  else if (rec.includes('매수')) badgeClass = 'recommendation-badge--buy';
  else if (rec.includes('매도')) badgeClass = 'recommendation-badge--sell';
  else if (rec.includes('기다리기') || rec.includes('보유')) badgeClass = 'recommendation-badge--hold';

  const headDiv = document.createElement('div'); headDiv.className = 'analysis-head';
  const badge = document.createElement('div'); badge.className = `recommendation-badge ${badgeClass}`; badge.textContent = badgeText;
  const ts = document.createElement('div'); ts.className = 'analysis-timestamp'; ts.textContent = formatDateTime(data.analyzed_at || new Date().toISOString());
  headDiv.appendChild(badge); headDiv.appendChild(ts); container.appendChild(headDiv);

  if (data.fallback) {
    const warn = document.createElement('div');
    warn.style.cssText = 'margin-top:8px; padding:8px; background:#fef3c7; color:#92400e; border:1px solid #f59e0b; border-radius:6px; font-size:11px; line-height:1.4;';
    warn.textContent = data.fallback_message || '⚠️ 임시 판단입니다.';
    container.appendChild(warn);
  }

  const overallBlock = document.createElement('div');
  overallBlock.className = 'analysis-block';
  const overallTitle = document.createElement('h4');
  overallTitle.className = 'analysis-block-title';
  overallTitle.textContent = '종합 분석';
  overallBlock.appendChild(overallTitle);
  const overallText = document.createElement('p');
  overallText.className = 'overall-summary-text';
  overallText.textContent = data.overall_summary || '-';
  overallBlock.appendChild(overallText);
  container.appendChild(overallBlock);

  if (scrollTo) container.scrollIntoView({ behavior: 'smooth', block: 'start' });
}