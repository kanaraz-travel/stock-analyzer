// assets/auto_badge.js
import { $ } from './core.js';

let autoBatchInterval = null;

export function initAutoBatchBadge() {
  if (autoBatchInterval) clearInterval(autoBatchInterval);
  pollAutoBatchStatus();
  autoBatchInterval = setInterval(pollAutoBatchStatus, 30000);
}

export function stopAutoBatchBadge() {
  if (autoBatchInterval) {
    clearInterval(autoBatchInterval);
    autoBatchInterval = null;
  }
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
  const isDelayed = data.status === 'idle' && (now > nextRun + 10 * 60 * 1000);

  let text = '', className = '';
  if (data.status === 'running') { text = '자동 중...'; className = 'badge--status-orange'; }
  else if (data.status === 'failed' || isDelayed) { text = '자동 끊김'; className = 'badge--status-gray'; }
  else { text = '자동 원활'; className = 'badge--status-green'; }

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