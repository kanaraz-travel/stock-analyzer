// assets/auto_badge.js
import { $ } from './core.js';
let timer = null;

export function initAutoBatchBadge() { stopAutoBatchBadge(); poll(); timer = setInterval(poll, 30000); }
export function stopAutoBatchBadge() { if (timer) { clearInterval(timer); timer = null; } }

async function poll() {
  if (document.hidden) return;
  try { 
    const res = await fetch('/api/cron-status'); 
    if (!res.ok) throw new Error('fail'); 
    renderBadge(await res.json()); 
  } catch { renderBadge({ status: 'failed', error: '상태 조회 실패' }); }
}

function renderBadge(data) {
  const badge = $('#auto-batch-badge'); if (!badge) return;
  let text, cls;
  switch (data.status) {
    case 'running': text = `자동 ${data.succeeded || 0}/${data.total || 0}`; cls = 'badge--status-orange'; break;
    case 'failed': case 'interrupted': text = '자동 끊김'; cls = 'badge--status-gray'; break;
    case 'stale': text = '자동 응답 없음'; cls = 'badge--status-gray'; break;
    default: text = '자동 원활'; cls = 'badge--status-green';
  }
  badge.textContent = text; badge.className = `badge ${cls}`;
  badge.onclick = (e) => { e.stopPropagation(); showTooltip(badge, data); };
}

function showTooltip(anchor, data) {
  const existing = document.getElementById('auto-batch-tooltip'); if (existing) existing.remove();
  const tip = document.createElement('div'); tip.id = 'auto-batch-tooltip';
  tip.style.cssText = 'position:absolute;top:40px;right:0;z-index:100;background:#1e293b;color:#fff;padding:12px;border-radius:8px;font-size:12px;line-height:1.5;box-shadow:0 4px 6px rgba(0,0,0,.3);width:240px;word-break:keep-all;';
  
  const fmt = (iso) => iso ? new Date(iso).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '-';
  const statusLabel = { running: '진행 중', completed: '완료', failed: '실패', interrupted: '중단됨', stale: '응답 없음', idle: '대기' }[data.status] || data.status;
  
  // ★ XSS 방지: 기본 구조 생성 후 textContent로 삽입
  const title = document.createElement('div'); title.style.cssText = 'font-weight:bold;margin-bottom:8px;border-bottom:1px solid #475569;padding-bottom:4px;'; title.textContent = '자동 이력 쌓기';
  const statusDiv = document.createElement('div'); statusDiv.innerHTML = `상태: <span style="color:#38bdf8;">${statusLabel}</span>`;
  const nextDiv = document.createElement('div'); nextDiv.textContent = `다음 실행: ${fmt(data.next_run_at)}`;
  const successDiv = document.createElement('div'); successDiv.textContent = `마지막 성공: ${fmt(data.last_success_at)}`;
  const countDiv = document.createElement('div'); countDiv.textContent = `성공 ${data.succeeded || 0} / 실패 ${data.failed || 0} / 스킵 ${data.skipped || 0}`;

  tip.appendChild(title); tip.appendChild(statusDiv); tip.appendChild(nextDiv); tip.appendChild(successDiv); tip.appendChild(countDiv);

  if (data.error) {
    const errDiv = document.createElement('div');
    errDiv.style.cssText = 'color:#f87171; margin-top:6px; border-top:1px solid #475569; padding-top:6px;';
    errDiv.textContent = `⚠️ 사유: ${data.error}`; // ★ textContent 사용
    tip.appendChild(errDiv);
  }
  
  anchor.parentNode.style.position = 'relative'; anchor.parentNode.appendChild(tip);
  setTimeout(() => { 
    const closer = (ev) => { 
      if (!tip.contains(ev.target)) { 
        tip.remove(); document.removeEventListener('click', closer, true); 
      } 
    }; 
    document.addEventListener('click', closer, true); 
  }, 0);
}