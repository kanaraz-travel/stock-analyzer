// assets/analysis.js
// ... (import 기존과 동일) ...

async function runBatchAnalysis() {
  // ... (초기화 기존과 동일) ...
  
  for (let i = 0; i < targets.length; i++) {
    // ...
    try {
      const data = await runAnalysis(stock.ticker, stock.name, null, 'batch');
      
      // ★ T2: fallback 결과면 실패로 카운트하고 루프 중단
      if (data && data.fallback) {
        failedStocks.push(`${stock.name}(${data.fallback_reason})`);
        failed++;
        
        if (data.fallback_reason === 'AI_QUOTA_EXCEEDED') {
          btn.textContent = `한도 초과로 중단 (${i + 1}/${total})`;
          alert('오늘 AI 무료 한도를 모두 사용했습니다. 한국시간 오전 9시 이후 다시 시도해 주세요.');
          break; // 루프 즉시 탈출
        }
      } else {
        succeeded++;
      }
    } catch (e) {
      failedStocks.push(stock.name);
      failed++;
    }
    // ...
  }
  // ...
}