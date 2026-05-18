/* Debug — 갭 사례 라우팅 결과 확인 */
import process from 'process';
try { if (typeof process.loadEnvFile === 'function') process.loadEnvFile('.env.local'); } catch {}

import { routeQuery } from '@/lib/agents/router';

const queries = [
  '대학원생 장학금이 최근 10년 사이에 증가했어?',
  '학생 1인당 지원금',
  '강사료 변천',
];

async function main() {
  for (const q of queries) {
    console.log(`\n📋 Query: "${q}"`);
    const result = await routeQuery(q, 'admin');
    console.log(`  Selected wikis: ${result.selectedAgentIds.join(', ')}`);
    console.log(`  isGlobal: ${result.isGlobal}`);
    const financeIn = result.selectedAgentIds.includes('finance');
    console.log(`  ✓ finance included? ${financeIn ? '✅ YES (RAG 발동 가능)' : '❌ NO (RAG 못 함)'}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
