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
    if (warningEl) { warningEl.textContent = data.fallback_message || '⚠️ 임시 판단입니다.'; warningEl.style.display = 'block'; }
  } else {
    if (rec.includes('매수')) badge.classList.add('recommendation-badge--buy');
    else if (rec.includes('매도')) badge.classList.add('recommendation-badge--sell');
    else if (rec.includes('기다리기') || rec.includes('보유')) badge.classList.add('recommendation-badge--hold');
    else badge.classList.add('recommendation-badge--pending');
    if (warningEl) warningEl.style.display = 'none';
  }

  $('#analysis-timestamp').textContent = `분석 시각: ${formatDateTime(data.analyzed_at || new Date().toISOString())}`;
  $('#overall-summary').textContent = data.overall_summary || '-';

  // ★ 에이전트 상세 의견 렌더링 (XSS 방지를 위해 DOM 생성 방식 사용)
  let detailEl = document.getElementById('agent-details');
  if (!detailEl) {
    detailEl = document.createElement('div');
    detailEl.id = 'agent-details';
    detailEl.style.cssText = 'margin-top:16px; border-top:1px dashed #e5e7eb; padding-top:12px; font-size:13px;';
    $('#analysis-result').appendChild(detailEl);
  }
  
  detailEl.innerHTML = ''; // 초기화

  if (data.agent_outputs) {
    const title = document.createElement('div');
    title.style.cssText = 'font-weight:bold; margin-bottom:8px; color:#475569;';
    title.textContent = '🔍 AI 에이전트 상세 진단';
    detailEl.appendChild(title);

    if (data.agent_outputs.news) {
      const n = data.agent_outputs.news;
      const newsDiv = document.createElement('div');
      newsDiv.style.cssText = 'margin-bottom:6px;';
      
      const strong = document.createElement('strong');
      strong.style.color = '#2563eb';
      strong.textContent = '📰 뉴스: ';
      
      const spanText = document.createElement('span');
      spanText.textContent = n.text;
      
      const spanMeta = document.createElement('span');
      spanMeta.style.cssText = 'color:#64748b; font-size:11px;';
      spanMeta.textContent = ` (${n.sentiment} / ${n.impact})`;
      
      newsDiv.appendChild(strong);
      newsDiv.appendChild(spanText);
      newsDiv.appendChild(spanMeta);
      detailEl.appendChild(newsDiv);
    }
    
    if (data.agent_outputs.trend) {
      const t = data.agent_outputs.trend;
      const trendDiv = document.createElement('div');
      
      const strong = document.createElement('strong');
      strong.style.color = '#2563eb';
      strong.textContent = '📈 추세: ';
      
      const spanText = document.createElement('span');
      // innerHTML 대신 textContent로 안전하게 구성
      spanText.textContent = `단기 ${t.short} / 중기 ${t.medium}`;
      
      const spanMeta = document.createElement('span');
      spanMeta.style.cssText = 'color:#64748b; font-size:11px;';
      spanMeta.textContent = ` (강도: ${t.strength})`;
      
      trendDiv.appendChild(strong);
      trendDiv.appendChild(spanText);
      trendDiv.appendChild(spanMeta);
      detailEl.appendChild(trendDiv);
    }
  }

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

  const overallBlock = document.createElement('div'); overallBlock.className = 'analysis-block';
  const overallTitle = document.createElement('h4'); overallTitle.className = 'analysis-block-title'; overallTitle.textContent = '종합 분석';
  overallBlock.appendChild(overallTitle);
  const overallText = document.createElement('p'); overallText.className = 'overall-summary-text'; overallText.textContent = data.overall_summary || '-';
  overallBlock.appendChild(overallText); container.appendChild(overallBlock);

  if (data.agent_outputs) {
    const detailDiv = document.createElement('div');
    detailDiv.style.cssText = 'margin-top:12px; font-size:12px; color:#475569; background:#f8fafc; padding:8px; border-radius:6px;';
    
    if (data.agent_outputs.news) {
      const div1 = document.createElement('div');
      div1.style.marginBottom = '4px';
      div1.textContent = `📰 ${data.agent_outputs.news.text}`;
      detailDiv.appendChild(div1);
    }
    if (data.agent_outputs.trend) {
      const t = data.agent_outputs.trend;
      const div2 = document.createElement('div');
      div2.textContent = `📈 단기 ${t.short} / 중기 ${t.medium}`;
      detailDiv.appendChild(div2);
    }
    container.appendChild(detailDiv);
  }

  if (scrollTo) container.scrollIntoView({ behavior: 'smooth', block: 'start' });
}