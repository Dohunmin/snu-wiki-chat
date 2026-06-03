/**
 * P7 평가용 실제 질문 셋 추출 (LLM 없음, DB만 — 무료). "실제 질문만 + 길이 상위 50%" 제약 준수.
 *   - 타깃: 제도화/시행/도입/개정/이행 여부를 묻는 질문 (P7이 개선해야 할 류)
 *   - 회귀: 평범한 단순 조회 (P7 과발동·비대화 안 하는지 확인용)
 *   npx tsx --env-file=.env.local scripts/select-eval-questions.ts
 */
import { sql } from '@vercel/postgres';

const master = (process.env.MASTER_ADMIN_EMAIL ?? '').toLowerCase();
const TARGET = /제도화|도입|시행|개정|이행|되었|됐|제정|반영되|채택/;
const COMPLEXISH = /왜|어떻게|차이|관계|평가|전략|방향|배경|비교|종합|엮|함의/;

async function main() {
  const r = await sql`
    SELECT m.content AS q, u.email, u.role AS urole, m.routed_agents AS wikis
    FROM messages m JOIN conversations c ON m.conversation_id=c.id JOIN users u ON c.user_id=u.id
    WHERE m.role='user' AND m.mode='normal'`;
  const real = r.rows.filter((x: any) =>
    x.urole !== 'admin' && (x.email || '').toLowerCase() !== master && (x.q || '').trim().length > 0);
  const lens = real.map((x: any) => x.q.length).sort((a: number, b: number) => a - b);
  const median = lens[Math.floor(lens.length / 2)] ?? 0;

  const seen = new Set<string>();
  const uniq = real.filter((x: any) => seen.has(x.q) ? false : (seen.add(x.q), true));

  // 타깃(제도화 여부)은 실제로 짧음 → 길이필터 미적용(전체 실제질문). 합성 X 제약만 유지.
  const target = uniq.filter((x: any) => TARGET.test(x.q));
  // 회귀용: 타깃 아니고 종합형도 아닌 평범 조회. 길이 상위(median↑) 우선 — 부담스러운 케이스로 스트레스.
  const plain = uniq
    .filter((x: any) => !TARGET.test(x.q) && !COMPLEXISH.test(x.q) && x.q.length >= median)
    .sort((a: any, b: any) => b.q.length - a.q.length);

  const show = (label: string, arr: any[], n: number) => {
    console.log(`\n── ${label} (${arr.length}건 중 ${Math.min(n, arr.length)}개) ──`);
    arr.slice(0, n).forEach((x: any, i) => console.log(`  ${i + 1}. "${x.q}"  [${(x.wikis ?? []).join(',')}]`));
  };
  console.log(`실제 비-admin 질문 ${real.length} → 유니크 ${uniq.length} (median ${median}자)`);
  show('🎯 P7 타깃 (제도화·시행 여부)', target, 5);
  show('🔁 회귀 체크 (평범 조회 — P7 과발동 안 해야)', plain, 5);
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
