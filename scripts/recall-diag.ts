/**
 * 리콜 누수 진단 — "트랙별 연구평가"류 질문에서 성과연봉제 청크가 *어느 게이트*에서 탈락하는지.
 * 비용: Voyage 쿼리임베딩 1회(~$0.0001) + DB. LLM 생성 없음.
 *   npx tsx --env-file=.env.local scripts/recall-diag.ts
 */
import { sql } from '@vercel/postgres';
import { searchVector } from '@/lib/embed/search';

const master = (process.env.MASTER_ADMIN_EMAIL ?? '').toLowerCase();
const NEEDLE = /연봉|성과|트랙|연구\s?평가|평가/;          // 타깃 질문 식별
const TARGET = /연봉|성과연봉/;                            // 정답 청크 식별

async function findRealQuestions(): Promise<string[]> {
  const r = await sql`
    SELECT m.content AS q, u.email, u.role AS urole, m.routed_agents AS wikis
    FROM messages m JOIN conversations c ON m.conversation_id=c.id JOIN users u ON c.user_id=u.id
    WHERE m.role='user' AND m.mode='normal'`;
  const cands = r.rows.filter((x: any) =>
    x.urole !== 'admin' && (x.email || '').toLowerCase() !== master && NEEDLE.test(x.q));
  console.log(`\n── 실제 사용자 질문 중 평가/연봉/트랙 매칭 ${cands.length}건 ──`);
  for (const c of cands) console.log(`  · "${c.q}"  [${(c.wikis ?? []).join(',')}]`);
  return cands.map((c: any) => c.q as string);
}

async function diag(query: string) {
  console.log(`\n══ 진단 질문: "${query}" ══`);
  // 벡터 top-60 (현재 코드는 30; 60까지 보면 rank 분포 파악)
  const vec = await searchVector(query, 'senate', 'admin', 60);
  console.log(`\n벡터 top-60 (senate): ${vec.length}건`);
  const hits = vec
    .map((v, rank) => ({ rank: rank + 1, sim: v.similarity, id: v.id, title: v.metadata?.title ?? '', text: v.chunkText ?? '' }))
    .filter(h => TARGET.test(h.title) || TARGET.test(h.text) || TARGET.test(h.id));
  if (hits.length === 0) {
    console.log('  ❌ 성과연봉제 청크가 벡터 top-60에 *전혀 없음* → 리콜 게이트(a) 벡터랭크 문제');
  } else {
    for (const h of hits) {
      const cutBySim = h.sim < 0.40;
      const cutByCap = h.rank > 25;
      console.log(`  ✓ rank #${h.rank} | sim=${h.sim.toFixed(3)} | "${h.title || h.id}"`);
      console.log(`     현재 게이트 통과? sim≥0.40:${!cutBySim ? 'O' : `X(${h.sim.toFixed(2)})`} / rank≤30(벡터k):${h.rank <= 30 ? 'O' : 'X'} / rank≤25(chunkCap):${!cutByCap ? 'O' : 'X'}`);
      console.log(`     → ${cutBySim ? 'SIM_CUT(0.40)에서 컷' : cutByCap ? 'chunkCap(25)에서 컷' : '통과해야 정상'}`);
    }
  }
}

async function main() {
  const qs = await findRealQuestions();
  for (const q of qs) await diag(q);
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
