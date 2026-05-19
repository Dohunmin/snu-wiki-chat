/* Debug — Lens RAG가 실제로 키워드 매칭 못 잡는 동의어 쿼리에 작동하는지 확인 */
import process from 'process';
try { if (typeof process.loadEnvFile === 'function') process.loadEnvFile('.env.local'); } catch {}

import { loadPersonaContext } from '@/lib/agents/lens';

const queries = [
  '이석재 후보의 교원 보수 체계 입장',     // 동의어: 보수 ↔ 처우/연봉
  '이석재 후보의 재정 운영 철학',           // 의미 매칭 테스트
  '대학원 학사 구조 개편 의견',              // 폭넓은 정책 질문
];

async function main() {
  process.env.RAG_DEBUG = 'true';

  for (const q of queries) {
    console.log(`\n${'─'.repeat(70)}`);
    console.log(`📋 Query: "${q}"`);
    console.log('─'.repeat(70));

    const ctx = await loadPersonaContext('leesj', q, 'admin');
    if (!ctx) { console.log('❌ null'); continue; }

    console.log(`  스탠스 회수: ${ctx.stances.length}/8 (insufficient: ${ctx.insufficient})`);
    ctx.stances.slice(0, 5).forEach((s, i) => {
      console.log(`  ${i + 1}. [${s.id}] ${s.title} (topic: ${s.topic}, score: ${s.score.toFixed(3)})`);
    });
  }
}

main().catch(e => { console.error(e); process.exit(1); });
