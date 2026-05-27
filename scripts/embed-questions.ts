/**
 * 한계 답변 분석 갱신 (사용자 질문 임베딩 + Sonnet 평가 + DBSCAN 클러스터링).
 * 실행: npm run knowledge:questions
 * 출력: public/knowledge-map-questions.json
 *
 * Design Ref: §2.4 — refreshAll() 호출하는 thin wrapper. 핵심 로직은 lib/limitations/refresh.ts.
 * Batch 자동 반복으로 누적 처리. 한 번 처리된 질문은 재호출 X (증분).
 */
import { loadEnvFile } from 'process';
try { loadEnvFile('.env.local'); } catch {}

import { refreshAll } from '../lib/limitations/refresh';

async function main() {
  console.log('🚀 한계 답변 분석 갱신 시작...\n');
  const result = await refreshAll({
    onBatch: (batchNum, r) => {
      const stageMsg = r.processed === 0
        ? '처리할 새 질문 없음'
        : `처리 ${r.processed}건 (누적 ${r.totalCount}건, 신규 클러스터 ${r.newClusterCount}, ${(r.durationMs / 1000).toFixed(1)}s)`;
      console.log(`  batch ${batchNum}: ${stageMsg}${r.hasMore ? ' → 다음 batch...' : ''}`);
    },
  });
  console.log(`\n✅ 완료: 총 ${result.totalProcessed}건 처리, ${result.totalBatches} batch, ${(result.durationMs / 1000).toFixed(1)}s`);
}

main().catch(err => { console.error(err); process.exit(1); });
