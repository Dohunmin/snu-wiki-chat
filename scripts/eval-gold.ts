/**
 * 평가자 gold-set 하니스 — plan §10.4.
 *
 *   실제 시트 질문(길이 상위 50%, scripts/gold-questions.json)을
 *   → 실제 라우팅(routeQuery)으로 컨텍스트 검색
 *   → 평가자(Haiku, 4-way verdict) 실행
 *   → 판정 결과를 표 + JSON으로 출력 (사람이 검수/라벨링 → gold 확정)
 *
 *   ⚠️ 합성 질문 금지: 입력은 반드시 scripts/gold-questions.json (실제 시트). (사용자 지시)
 *
 * 실행: npx tsx scripts/eval-gold.ts [--limit N] [--role tier1|admin]
 *   결과: scripts/gold-results.json
 */
import { loadEnvFile } from 'process';
import fs from 'fs';
try { loadEnvFile('.env.local'); } catch { /* 무시 */ }

import { routeQuery } from '@/lib/agents/router';
import { evaluateRetrieval, type Verdict } from '@/lib/agents/evaluator';
import type { Role } from '@/lib/auth/roles';

interface GoldQuestion { question: string; role: string; wikis: string; mode: string; length: number }

const VERDICT_KO: Record<Verdict, string> = {
  'answerable': '✅ answerable(사실 답변가능)',
  'opinion-grounded': '💭 opinion-grounded(의견·근거가능)',
  'external-needed': '🌐 external-needed(외부정보필요)',
  'internal-gap': '🕳️  internal-gap(내부공백)',
};

async function main() {
  const args = process.argv.slice(2);
  const limIdx = args.indexOf('--limit');
  const limit = limIdx >= 0 ? parseInt(args[limIdx + 1], 10) : Infinity;
  const roleIdx = args.indexOf('--role');
  const role = (roleIdx >= 0 ? args[roleIdx + 1] : 'tier1') as Role;
  // Design Ref: rag-cost-reduction §2 M0b — 기준선 저장/비교
  const saveBaseline = args.includes('--baseline');

  const path = 'scripts/gold-questions.json';
  if (!fs.existsSync(path)) {
    console.error(`❌ ${path} 없음 — 먼저 'npx tsx scripts/fetch-sheet-questions.ts --json scripts/gold-questions.json' 실행`);
    process.exit(1);
  }
  const allQuestions: GoldQuestion[] = JSON.parse(fs.readFileSync(path, 'utf-8'));
  // 신뢰도 게이트는 normal 검색 대상 — lens 모드는 별도 경로(loadPersonaContext)라 제외.
  const questions = allQuestions.filter(q => !(q.mode || '').startsWith('lens:'));
  const skipped = allQuestions.length - questions.length;
  if (skipped > 0) console.log(`(lens 모드 ${skipped}개 제외 — normal ${questions.length}개만 평가)`);
  const targets = questions.slice(0, limit);

  console.log('═'.repeat(80));
  console.log(`평가자 gold 하니스 — 실제 시트 질문 ${targets.length}개 (role=${role})`);
  console.log(`모델: Haiku 4.5  |  입력: ${path} (합성 질문 없음)`);
  console.log('═'.repeat(80));

  const results = [];
  const counts: Record<string, number> = {};
  let failCount = 0;

  for (let i = 0; i < targets.length; i++) {
    const q = targets[i];
    process.stdout.write(`\n[${i + 1}/${targets.length}] (${q.length}자) ${q.question.slice(0, 50)}...\n`);
    try {
      const routing = await routeQuery(q.question, role);
      const wikis = routing.selectedAgentIds.join(', ');
      const ev = await evaluateRetrieval(q.question, routing.contexts);
      counts[ev.verdict] = (counts[ev.verdict] ?? 0) + 1;
      if (ev.failed) failCount++;

      console.log(`    위키: ${wikis || '(없음)'}`);
      console.log(`    판정: ${VERDICT_KO[ev.verdict]}${ev.failed ? '  ⚠️PARSE_FAIL' : ''}`);
      if (ev.aspects.length) {
        for (const a of ev.aspects) {
          const mark = a.covered === 'yes' ? '✔' : a.covered === 'partial' ? '◐' : '✘';
          console.log(`      ${mark} ${a.aspect} [${a.covered}]`);
        }
      }
      if (ev.missing.length) console.log(`    부족: ${ev.missing.join(' / ')}`);

      results.push({
        question: q.question,
        length: q.length,
        role,
        routedWikis: routing.selectedAgentIds,
        verdict: ev.verdict,
        aspects: ev.aspects,
        missing: ev.missing,
        failed: ev.failed ?? false,
        rawOnFail: ev.failed ? ev.raw : undefined,
        goldVerdict: null, // ← 사람이 검수해 채울 정답 라벨
      });
    } catch (err) {
      console.error(`    ❌ 오류:`, err instanceof Error ? err.message : err);
      results.push({ question: q.question, length: q.length, role, error: String(err), goldVerdict: null });
    }
  }

  fs.writeFileSync('scripts/gold-results.json', JSON.stringify(results, null, 2), 'utf-8');

  console.log('\n' + '═'.repeat(80));
  console.log('📊 verdict 분포');
  console.log('═'.repeat(80));
  for (const v of Object.keys(VERDICT_KO) as Verdict[]) {
    console.log(`  ${VERDICT_KO[v]}: ${counts[v] ?? 0}`);
  }
  console.log(`  ⚠️ PARSE_FAIL: ${failCount}/${targets.length}`);
  console.log(`\n💾 scripts/gold-results.json (goldVerdict 칸을 검수해 채우면 일치율 측정 가능)`);

  // ── Design Ref: rag-cost-reduction §2 M0b — 기준선 게이트 + 교차근거 위키 분포 diff ──
  //   --baseline: 현 코드 verdict/routedWikis 스냅샷 저장(그린 기준선).
  //   기본: 기준선 비교 → 'answerable→그외' 후퇴 건수 집계, >0이면 exit(1).
  //   교차근거 위키 분포 축소는 silent regression 신호로 보고(정보용).
  const BASELINE_PATH = 'scripts/gold-eval.baseline.json';
  const snapshot = results
    .filter(r => r.verdict)
    .map(r => ({ question: r.question as string, verdict: r.verdict as Verdict, routedWikis: (r.routedWikis ?? []) as string[] }));

  if (saveBaseline) {
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(snapshot, null, 2), 'utf-8');
    console.log(`\n💾 ${BASELINE_PATH} 저장 (${snapshot.length}질문) — 변경후 'npx tsx scripts/eval-gold.ts'로 비교`);
    return;
  }

  if (!fs.existsSync(BASELINE_PATH)) {
    console.log(`\n⚠️ 기준선 ${BASELINE_PATH} 없음 — '--baseline'으로 먼저 생성하세요. (비교 생략)`);
    return;
  }

  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf-8')) as Array<{ question: string; verdict: Verdict; routedWikis: string[] }>;
  const baseByQ = new Map(baseline.map(b => [b.question, b]));
  let answerableRegressions = 0, wikiShrinkQ = 0, compared = 0;
  const regressionDetail: string[] = [];

  for (const r of snapshot) {
    const base = baseByQ.get(r.question);
    if (!base) continue;
    compared++;
    // 답변가능성 후퇴: answerable → 그 외(특히 internal-gap/external-needed)
    if (base.verdict === 'answerable' && r.verdict !== 'answerable') {
      answerableRegressions++;
      regressionDetail.push(`  🔴 "${r.question.slice(0, 40)}..." ${base.verdict} → ${r.verdict}`);
    }
    // 교차근거 위키 분포 후퇴(silent regression 신호)
    if (base.routedWikis.some(w => !r.routedWikis.includes(w))) wikiShrinkQ++;
  }

  console.log(`\n${'═'.repeat(80)}`);
  console.log(`📊 기준선 대비 (${compared}질문)`);
  console.log('═'.repeat(80));
  regressionDetail.forEach(d => console.log(d));
  console.log(`  답변가능성 후퇴(answerable→그외): ${answerableRegressions}/${compared}`);
  console.log(`  교차근거 위키 줄어든 질문: ${wikiShrinkQ}/${compared} (silent regression 신호 — 정보용)`);
  console.log(`\n🏁 ${answerableRegressions === 0 ? '✅ PASS — 답변가능성 후퇴 0' : '🔴 FAIL — 답변가능성 후퇴 발생'}`);
  if (answerableRegressions > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
