/**
 * 기존 한계 판정 재평가 — judgeOne 프롬프트 개선 후 quality/limitation/발췌만 재생성.
 * 임베딩·클러스터·PCA는 보존 (Voyage·DBSCAN 재호출 X).
 * 실행: npx tsx --env-file=.env.local scripts/reevaluate-limitations.ts
 */
import { loadEnvFile } from 'process';
try { loadEnvFile('.env.local'); } catch {}

import { reevaluateAll } from '../lib/limitations/refresh';

async function main() {
  console.log('🔄 한계 판정 재평가 시작 (임베딩 보존, judgement만)...\n');
  const result = await reevaluateAll({
    onProgress: (cur, total) => process.stdout.write(`\r  재평가 ${cur}/${total}`),
  });
  console.log(`\n\n✅ 완료 (${(result.durationMs / 1000).toFixed(1)}s)`);
  console.log(`   재평가: ${result.updated}건`);
  console.log(`   한계 답변: ${result.limitedBefore} → ${result.limitedAfter}건 (${result.limitedAfter - result.limitedBefore >= 0 ? '+' : ''}${result.limitedAfter - result.limitedBefore})`);
}

main().catch(err => { console.error(err); process.exit(1); });
