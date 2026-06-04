/**
 * policy 검토용 실제 질문 분류 (LLM 없음, 무료). 외부데이터 필요 추정 vs 내부로 충분 추정.
 *   npx tsx --env-file=.env.local scripts/select-policy-eval.ts
 */
import { sql } from '@vercel/postgres';

const master = (process.env.MASTER_ADMIN_EMAIL ?? '').toLowerCase();
// 외부 데이터가 결정적일 신호: 타 대학/기관·해외·법령·규제·비교·벤치마크
const EXT = /타\s?대학|다른 대학|카이스트|포스텍|해외|외국|글로벌|세계|법령|법적|법률|규제|조례|벤치마크|비교(?!과)|타 기관|민간|시장/;
// 정책·제안·진단 성격(공약 에이전트 적합)
const POLICY = /방법|방안|어떻게|가능할까|제안|진단|원인|전략|개선|늘릴|줄일|확대|없을까|해야|편이|나은|바람직/;

async function main() {
  const r = await sql`
    SELECT m.content AS q, u.email, u.role AS urole, m.routed_agents AS wikis
    FROM messages m JOIN conversations c ON m.conversation_id=c.id JOIN users u ON c.user_id=u.id
    WHERE m.role='user' AND m.mode='normal'`;
  const seen = new Set<string>();
  const real = r.rows.filter((x: any) =>
    x.urole !== 'admin' && (x.email || '').toLowerCase() !== master &&
    (x.q || '').length >= 15 && (seen.has(x.q) ? false : (seen.add(x.q), true)));

  const ext = real.filter((x: any) => EXT.test(x.q) && POLICY.test(x.q));
  const intl = real.filter((x: any) => !EXT.test(x.q) && POLICY.test(x.q));

  const show = (label: string, arr: any[], n: number) => {
    console.log(`\n── ${label} (${arr.length}건 중 ${Math.min(n, arr.length)}) ──`);
    arr.sort((a: any, b: any) => b.q.length - a.q.length).slice(0, n)
      .forEach((x: any, i: number) => console.log(`  ${i + 1}. (${x.q.length}자) "${x.q}"`));
  };
  console.log(`실제 정책성 질문 분류:`);
  show('🌐 외부데이터 필요 추정 (타대학·법령·비교)', ext, 6);
  show('🏛️ 내부로 충분 추정 (SNU 거버넌스·재정·전략)', intl, 6);
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
