/**
 * P3-0 (Design: rag-cost-reduction.phase3.design §1) — Phase 3 전역 top-K 무료 절감 추정.
 *
 * 빌드 전 게이트: globalTopK를 짓지 않고도, 현 per-wiki 덤프 char vs
 * 전 코퍼스 pgvector top-K 청크 char(=전역 top-K가 실제 가져올 것)를 비교해
 * Phase 3 절감을 추정. **LLM 0 (Voyage 임베딩만, $0).**
 *
 * 게이트: 평균 추정 절감 <25% → Phase 3 보류 / ≥35% → 진행.
 *
 * 실행: npx tsx --env-file=.env.local scripts/estimate-global-topk.ts
 */
import { loadEnvFile } from 'process';
import fs from 'fs';
try { loadEnvFile('.env.local'); } catch { /* 무시 */ }

import { sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { embedOne } from '@/lib/embed/voyage';
import { routeQuery } from '@/lib/agents/router';
import { canAccessSensitive } from '@/lib/auth/roles';
import type { Role } from '@/lib/auth/roles';

const KS = [16, 24, 32];

async function globalChars(emb: number[], sensitiveAllowed: boolean, k: number): Promise<number> {
  const lit = `[${emb.join(',')}]`;
  // 주의: lensPersona(leesj) 제외 allowlist는 생략 — 전역 풀에 포함돼 global char를 약간 부풀려
  //   절감을 *과소* 추정(보수적). 실측은 shadow(S1)서 allowlist 적용해 확정.
  const res = await db.execute(sql`
    SELECT COALESCE(SUM(LENGTH(chunk_text)), 0) AS chars FROM (
      SELECT chunk_text FROM chunk_embeddings
      WHERE (${sensitiveAllowed} OR sensitive = FALSE)
      ORDER BY embedding <=> ${lit}::vector
      LIMIT ${k}
    ) t
  `);
  const rows = Array.isArray(res) ? res : ((res as unknown as { rows?: Array<{ chars: number | string }> }).rows ?? []);
  return Number((rows[0] as { chars?: number | string })?.chars ?? 0);
}

async function main() {
  const role = 'admin' as Role;
  const sensitiveAllowed = canAccessSensitive(role);

  const all = JSON.parse(fs.readFileSync('scripts/gold-questions.json', 'utf-8')) as Array<{ question: string; mode?: string }>;
  const questions = all.filter(q => !(q.mode || '').startsWith('lens:'));

  console.log('═'.repeat(80));
  console.log(`P3-0 전역 top-K 절감 추정 — 실제 gold ${questions.length}질문 (role=${role}, LLM 0)`);
  console.log('═'.repeat(80));

  let curTotal = 0;
  const gTotals: Record<number, number> = Object.fromEntries(KS.map(k => [k, 0]));
  const perQ: { q: string; cur: number; g24: number; sav24: number }[] = [];

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    process.stdout.write(`\r  ${i + 1}/${questions.length}...`);
    const routing = await routeQuery(q.question, role);
    const cur = routing.contexts.reduce((s, c) => s + [...c.relevantData].length, 0);
    curTotal += cur;
    const emb = await embedOne(q.question, 'query');
    let g24 = 0;
    for (const k of KS) {
      const gc = await globalChars(emb, sensitiveAllowed, k);
      gTotals[k] += gc;
      if (k === 24) g24 = gc;
    }
    perQ.push({ q: q.question, cur, g24, sav24: cur > 0 ? (1 - g24 / cur) * 100 : 0 });
  }
  process.stdout.write('\n');

  const n = questions.length;
  const curAvg = curTotal / n;
  console.log(`\n현 per-wiki 평균 컨텍스트: ${Math.round(curAvg).toLocaleString()}자`);
  console.log('전역 top-K(청크 raw — 포맷팅/entity·recency protected 미포함) 추정:');
  for (const k of KS) {
    const gAvg = gTotals[k] / n;
    const sav = (1 - gAvg / curAvg) * 100;
    console.log(`  K=${k}: ${Math.round(gAvg).toLocaleString()}자  →  추정 절감 ${sav.toFixed(0)}%`);
  }

  // K=24 기준 질문별 분포 (절감이 고른지 / 일부만 큰지)
  perQ.sort((a, b) => a.sav24 - b.sav24);
  const med = perQ[Math.floor(n / 2)].sav24;
  const worst = perQ.slice(0, 3);
  console.log(`\nK=24 질문별 절감: 중앙값 ${med.toFixed(0)}%`);
  console.log('  절감 최저 3개 (전역 top-K가 안 줄이는 = 이미 집중된 질문):');
  for (const x of worst) console.log(`    ${x.sav24.toFixed(0)}%  "${x.q.slice(0, 45)}..."`);

  const sav24 = (1 - gTotals[24] / n / curAvg) * 100;
  console.log(`\n${'─'.repeat(80)}`);
  console.log(`🏁 게이트 (K=24 평균 추정 ${sav24.toFixed(0)}%): ` +
    (sav24 >= 35 ? '✅ ≥35% → Phase 3 진행 권장'
      : sav24 >= 25 ? '🟡 25~35% → 사용자 판단'
        : '🔴 <25% → Phase 3 보류(효과 부족), 다른 방향 재검토'));
  console.log('⚠️ 추정 주의: 전역측 포맷팅/protected 미포함(낙관) + leesj 포함(비관) + 더 관련된 청크(현실).');
  console.log('   실측 절감은 빌드 후 shadow S1(무료 golden-qa)서 확정.');
}

main().catch(err => { console.error(err); process.exit(1); });
