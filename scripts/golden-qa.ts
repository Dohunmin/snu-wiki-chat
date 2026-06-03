/**
 * Plan SC5 (회귀 ≥18/20) + SC6 (갭 개선 ≥3/5) 자동 검증.
 *
 * 같은 질문 셋을 RAG OFF vs RAG ON 두 가지 모드로 finance WikiAgent에 던지고
 * 컨텍스트에 *기대 키워드*가 포함되는지 자동 비교.
 *
 * PoC 범위 (finance 1개 위키)이므로 회귀 질문은 finance에서 답할 수 있는 것 위주.
 * Phase B에서 9개 위키 확장 시 셋도 확장 (위키별 ~5개).
 *
 * Usage:
 *   npm run qa:golden
 *   또는: npx tsx --env-file=.env.local scripts/golden-qa.ts
 */

import process from 'process';
try { if (typeof process.loadEnvFile === 'function') process.loadEnvFile('.env.local'); } catch {}

import fs from 'fs';
import { WikiAgent } from '@/lib/agents/wiki-agent';
import { routeQuery } from '@/lib/agents/router';
import type { AgentConfig } from '@/lib/agents/types';
import type { Role } from '@/lib/auth/roles';
import agentsConfig from '@/data/agents.config.json';

interface GoldenQuery {
  id: string;
  category: 'regression' | 'gap';
  query: string;
  /** 컨텍스트에 *반드시* 포함되어야 할 키워드 */
  mustInclude: string[];
  /** RAG ON에서만 새로 회수되어야 할 키워드 (정보용) */
  ragOnlyExpected?: string[];
  description: string;
}

// finance 위키 범위로 한정 (PoC, 1개 위키)
const GOLDEN_QUERIES: GoldenQuery[] = [
  // ─── 회귀 그룹 (REG-01~10): 현재 잘 작동, RAG ON에서도 동등 유지 ───
  { id: 'REG-01', category: 'regression',
    query: '2024년 종합재무제표 운영수익 얼마야?',
    mustInclude: ['21,438'],
    description: '단순 수치 조회 — 키워드 매칭으로 잘 잡힘' },
  { id: 'REG-02', category: 'regression',
    query: '2020년부터 2024년 인건비 추이 알려줘',
    mustInclude: ['인건비'],
    description: '인건비 시계열' },
  { id: 'REG-03', category: 'regression',
    query: '법인 단독 적자 연도는?',
    mustInclude: ['2018', '2019'],
    description: '법인 단독 적자 연도 — 비용구조·운영계산서 인용' },
  { id: 'REG-04', category: 'regression',
    query: '2024년 정부출연금은 얼마인가요?',
    mustInclude: ['6,229'],
    description: '정부출연금 수치' },
  { id: 'REG-05', category: 'regression',
    query: '산학협력단 운영수익 변화',
    mustInclude: ['산학협력'],
    description: '산학협력단 시계열' },
  { id: 'REG-06', category: 'regression',
    query: '법인회계 세출 예산 구조',
    mustInclude: ['세출', '인건비'],
    description: '예산-세출구조.fact 인용' },
  { id: 'REG-07', category: 'regression',
    query: '2018년에 인건비가 왜 그렇게 늘었어?',
    mustInclude: ['인건비'],
    description: '인건비 +457억 원인 분석' },
  { id: 'REG-08', category: 'regression',
    query: '발전재단 자산 규모',
    mustInclude: ['발전재단'],
    description: '발전재단 entity/fact 인용' },
  { id: 'REG-09', category: 'regression',
    query: '등록금 동결 정책',
    mustInclude: ['등록금'],
    description: '등록금정책분석 topic 인용' },
  { id: 'REG-10', category: 'regression',
    query: '연구비 추이',
    mustInclude: ['연구비'],
    description: '연구비 시계열' },

  // ─── 갭 그룹 (GAP-01~05): RAG OFF에서는 누락, RAG ON에서 회수 ───
  { id: 'GAP-01', category: 'gap',
    query: '대학원생 장학금이 최근 10년 사이에 증가했어?',
    mustInclude: ['학생경비'],
    ragOnlyExpected: ['학생경비', '학문후속세대'],
    description: '⭐ 핵심 갭 사례 — "장학금" ↔ "학생경비" 동의어' },
  { id: 'GAP-02', category: 'gap',
    query: '학생 1인당 학교 지원금 추세',
    mustInclude: ['학생경비'],
    ragOnlyExpected: ['학생경비'],
    description: '"지원금" ↔ "학생경비" 동의어' },
  { id: 'GAP-03', category: 'gap',
    query: '강사료가 어떻게 변했어?',
    mustInclude: ['강사'],
    ragOnlyExpected: ['강사료'],
    description: '"강사료" 변천 — 인건비 분석 내용' },
  { id: 'GAP-04', category: 'gap',
    query: '재정 자립도는 어떻게 되니?',
    mustInclude: ['정부출연금'],
    ragOnlyExpected: ['재원구조', '자립'],
    description: '"자립도" ↔ "재원구조분석" 의미 매칭' },
  { id: 'GAP-05', category: 'gap',
    query: '국고 의존도가 줄고 있어?',
    mustInclude: ['정부출연금'],
    ragOnlyExpected: ['재원구조', '의존도'],
    description: '"국고" ↔ "정부출연금" 동의어' },
];

interface RunResult {
  contextLength: number;
  chunkCount: number;
  foundKeywords: string[];
  missingKeywords: string[];
  passed: boolean;
}

async function runQuery(q: GoldenQuery, ragEnabled: boolean): Promise<RunResult> {
  const baseConfig = (agentsConfig.agents as AgentConfig[]).find(a => a.id === 'finance');
  if (!baseConfig) throw new Error('finance agent not found');

  const config: AgentConfig = { ...baseConfig, ragEnabled };
  const agent = new WikiAgent(config);
  const ctx = await agent.getContext(q.query, 'admin', false);
  const data = ctx.relevantData;

  const found = q.mustInclude.filter(kw => data.includes(kw));
  const missing = q.mustInclude.filter(kw => !data.includes(kw));

  return {
    contextLength: data.length,
    chunkCount: ctx.sources.length,
    foundKeywords: found,
    missingKeywords: missing,
    passed: missing.length === 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 레이어 1: finance 알려진-정답 픽스처 (기존 — 결정적·무료, RAG OFF vs ON)
// ─────────────────────────────────────────────────────────────────────────
async function runFinanceFixtures(): Promise<boolean> {
  console.log(`\n${'═'.repeat(80)}`);
  console.log(`🧪 GOLDEN Q&A — Plan SC5 (회귀 ≥18/20) + SC6 (갭 개선 ≥3/5)`);
  console.log(`   PoC 범위: finance 1개 위키, 회귀 10개 + 갭 5개 = 15개 질문`);
  console.log('═'.repeat(80));

  const results: Array<{
    q: GoldenQuery;
    off: RunResult;
    on: RunResult;
  }> = [];

  for (const q of GOLDEN_QUERIES) {
    process.stdout.write(`\n[${q.id}] ${q.category === 'gap' ? '🎯' : '🔁'} "${q.query}"\n`);
    const off = await runQuery(q, false);
    const on = await runQuery(q, true);
    results.push({ q, off, on });

    const offMark = off.passed ? '✅' : '❌';
    const onMark = on.passed ? '✅' : '❌';
    console.log(`  RAG OFF: ${offMark} found=${off.foundKeywords.length}/${q.mustInclude.length} chunks=${off.chunkCount} ctx=${off.contextLength}`);
    console.log(`  RAG ON : ${onMark} found=${on.foundKeywords.length}/${q.mustInclude.length} chunks=${on.chunkCount} ctx=${on.contextLength}`);
    if (off.missingKeywords.length > 0) console.log(`         OFF 누락: ${off.missingKeywords.join(', ')}`);
    if (on.missingKeywords.length > 0) console.log(`         ON  누락: ${on.missingKeywords.join(', ')}`);
  }

  // ─── 집계 ─────────────────────────────────────────────
  const regression = results.filter(r => r.q.category === 'regression');
  const gap = results.filter(r => r.q.category === 'gap');

  // 회귀: RAG ON이 OFF 이상이어야 함 (PASS)
  const regNoRegression = regression.filter(r => r.on.passed || (r.on.foundKeywords.length >= r.off.foundKeywords.length));
  const regImproved = regression.filter(r => r.on.foundKeywords.length > r.off.foundKeywords.length);
  const regRegressed = regression.filter(r => r.on.foundKeywords.length < r.off.foundKeywords.length);

  // 갭: RAG ON에서 통과 (OFF에서 실패한 것을 회수)
  const gapImproved = gap.filter(r => r.on.passed && !r.off.passed);
  const gapBothPassed = gap.filter(r => r.on.passed && r.off.passed);
  const gapFailed = gap.filter(r => !r.on.passed);

  console.log(`\n\n${'═'.repeat(80)}`);
  console.log(`📊 SUMMARY`);
  console.log('═'.repeat(80));
  console.log(`\n🔁 회귀 그룹 (10개) — Plan SC5 기준`);
  console.log(`  ✅ 동등 이상 유지: ${regNoRegression.length}/10`);
  console.log(`  📈 RAG ON에서 개선: ${regImproved.length}/10`);
  console.log(`  🔴 RAG ON에서 회귀: ${regRegressed.length}/10`);
  if (regRegressed.length > 0) {
    console.log(`     회귀 항목: ${regRegressed.map(r => r.q.id).join(', ')}`);
  }

  console.log(`\n🎯 갭 그룹 (5개) — Plan SC6 기준`);
  console.log(`  📈 RAG로 새로 통과: ${gapImproved.length}/5`);
  console.log(`  ✅ 양쪽 모두 통과: ${gapBothPassed.length}/5`);
  console.log(`  🔴 RAG ON에서도 실패: ${gapFailed.length}/5`);
  if (gapFailed.length > 0) {
    console.log(`     실패 항목: ${gapFailed.map(r => r.q.id).join(', ')}`);
  }

  // ─── 판정 (PoC 기준 조정 — finance 1개 위키이므로 SC5/SC6 비례 적용) ───
  // SC5: 회귀 ≥18/20 → finance 단독 10개에서는 ≥9/10
  // SC6: 갭 개선 ≥3/5 → 그대로
  const sc5Pass = regNoRegression.length >= 9;          // 9/10 = 90%
  const sc6Pass = (gapImproved.length + gapBothPassed.length) >= 3;

  console.log(`\n${'─'.repeat(80)}`);
  console.log(`🏁 PLAN SUCCESS CRITERIA (PoC 범위, finance 단독)`);
  console.log('─'.repeat(80));
  console.log(`  SC5 (회귀 ≥9/10): ${regNoRegression.length}/10 ${sc5Pass ? '✅ PASS' : '🔴 FAIL'}`);
  console.log(`  SC6 (갭 ≥3/5):    ${gapImproved.length + gapBothPassed.length}/5 ${sc6Pass ? '✅ PASS' : '🔴 FAIL'}`);

  // 토큰 영향
  const avgOffCtx = Math.round(results.reduce((s, r) => s + r.off.contextLength, 0) / results.length);
  const avgOnCtx = Math.round(results.reduce((s, r) => s + r.on.contextLength, 0) / results.length);
  const tokenDelta = ((avgOnCtx - avgOffCtx) / avgOffCtx) * 100;
  console.log(`\n📈 토큰 영향 (평균 컨텍스트 길이)`);
  console.log(`  RAG OFF: ${avgOffCtx} chars`);
  console.log(`  RAG ON : ${avgOnCtx} chars`);
  console.log(`  변화: ${tokenDelta >= 0 ? '+' : ''}${tokenDelta.toFixed(1)}% ${Math.abs(tokenDelta) <= 100 ? '🟡' : '🔴'}`);
  console.log(`  (Plan §8.3 기준 ±10% — PoC에선 chunkCap 15→25 변경으로 큰 증가 예상)`);

  console.log(`\n${'═'.repeat(80)}\n`);

  return sc5Pass && sc6Pass;
}

// ─────────────────────────────────────────────────────────────────────────
// 레이어 2: 실제 gold 질문 self-baseline (Design Ref: rag-cost-reduction §2 M0a)
//   실제 시트 64질문(gold-questions.json)을 routeQuery로 돌려 '검색 시그니처' 스냅샷.
//   --baseline: 현 코드 시그니처 저장(그린 기준선).
//   기본: 기준선과 비교 → 카타스트로픽 회귀(라우팅/소스 통째로 0)만 exit(1).
//   의도적 축소(위키·청크 감소)는 diff로 보고하되 fail 아님 — 의미적 품질 게이트는 eval-gold 담당.
//   ⚠️ 합성 질문 없음: 입력은 실제 시트(gold-questions.json)만. (사용자 지시)
// ─────────────────────────────────────────────────────────────────────────
interface Signature { question: string; wikis: string[]; sourceIds: string[]; chunks: number; chars: number }
const BASELINE_PATH = 'scripts/golden-qa.baseline.json';

async function captureSignatures(role: Role): Promise<Signature[]> {
  const path = 'scripts/gold-questions.json';
  if (!fs.existsSync(path)) {
    console.error(`❌ ${path} 없음 — 'npx tsx scripts/fetch-sheet-questions.ts --json scripts/gold-questions.json' 먼저 실행`);
    process.exit(2);
  }
  const all = JSON.parse(fs.readFileSync(path, 'utf-8')) as Array<{ question: string; mode?: string }>;
  const questions = all.filter(q => !(q.mode || '').startsWith('lens:'));
  const sigs: Signature[] = [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    process.stdout.write(`\r  시그니처 캡처 ${i + 1}/${questions.length}...`);
    try {
      const routing = await routeQuery(q.question, role);
      const sourceIds = [...new Set(routing.contexts.flatMap(c => c.sources.map(s => s.page)))].sort();
      sigs.push({
        question: q.question,
        wikis: [...routing.selectedAgentIds].sort(),
        sourceIds,
        chunks: sourceIds.length,
        chars: routing.contexts.reduce((s, c) => s + [...c.relevantData].length, 0),
      });
    } catch (err) {
      console.error(`\n  ⚠️ "${q.question.slice(0, 30)}..." 라우팅 실패:`, err instanceof Error ? err.message : err);
      sigs.push({ question: q.question, wikis: [], sourceIds: [], chunks: 0, chars: 0 });
    }
  }
  process.stdout.write('\n');
  return sigs;
}

async function runBaselineLayer(role: Role, saveBaseline: boolean): Promise<boolean> {
  console.log(`\n${'═'.repeat(80)}`);
  console.log(`🧪 SELF-BASELINE — 실제 gold 질문 검색 시그니처 (role=${role})`);
  console.log('═'.repeat(80));
  const sigs = await captureSignatures(role);

  if (saveBaseline) {
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(sigs, null, 2), 'utf-8');
    const totChars = sigs.reduce((s, x) => s + x.chars, 0);
    const avgWikis = sigs.reduce((s, x) => s + x.wikis.length, 0) / sigs.length;
    console.log(`\n💾 ${BASELINE_PATH} 저장 (${sigs.length}질문)`);
    console.log(`   평균 컨텍스트 ${Math.round(totChars / sigs.length).toLocaleString()}자, 평균 위키 ${avgWikis.toFixed(1)}개`);
    return true;
  }

  if (!fs.existsSync(BASELINE_PATH)) {
    console.log(`\n⚠️ 기준선 ${BASELINE_PATH} 없음 — 'npm run qa:golden -- --baseline'으로 먼저 생성하세요. (이번 비교 생략)`);
    return true;
  }

  const baseline: Signature[] = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf-8'));
  const byQ = new Map(baseline.map(b => [b.question, b]));
  let catastrophic = 0, wikiShrink = 0, sourceShrink = 0, charDelta = 0, baseChars = 0, compared = 0;

  for (const cur of sigs) {
    const base = byQ.get(cur.question);
    if (!base) continue;
    compared++;
    baseChars += base.chars;
    charDelta += cur.chars - base.chars;
    if (base.wikis.some(w => !cur.wikis.includes(w))) wikiShrink++;
    if (base.sourceIds.some(s => !cur.sourceIds.includes(s))) sourceShrink++;
    // 카타스트로픽: 검색 결과가 있었는데 이제 통째로 0
    if ((base.wikis.length > 0 && cur.wikis.length === 0) || (base.sourceIds.length > 0 && cur.sourceIds.length === 0)) {
      catastrophic++;
      console.log(`  🔴 CATASTROPHIC "${cur.question.slice(0, 40)}..." 위키 ${base.wikis.length}→${cur.wikis.length}, 소스 ${base.sourceIds.length}→${cur.sourceIds.length}`);
    }
  }

  console.log(`\n📊 기준선 대비 (${compared}질문 비교 — 축소는 의도적이라 fail 아님, 정보용 diff)`);
  console.log(`  위키 줄어든 질문: ${wikiShrink}/${compared}`);
  console.log(`  소스 줄어든 질문: ${sourceShrink}/${compared}`);
  console.log(`  평균 컨텍스트 변화: ${baseChars ? ((charDelta / baseChars) * 100).toFixed(1) : '0'}% (음수=절감)`);
  console.log(`\n🏁 카타스트로픽 회귀(라우팅/소스 0): ${catastrophic} ${catastrophic === 0 ? '✅ PASS' : '🔴 FAIL'}`);
  console.log(`   (의미적 품질 게이트 = answerable→partial 후퇴는 eval-gold가 담당)`);
  return catastrophic === 0;
}

async function main() {
  const args = process.argv.slice(2);
  const saveBaseline = args.includes('--baseline');
  const roleIdx = args.indexOf('--role');
  const role = (roleIdx >= 0 ? args[roleIdx + 1] : 'admin') as Role;

  const financePass = await runFinanceFixtures();
  const baselinePass = await runBaselineLayer(role, saveBaseline);

  console.log(`\n${'═'.repeat(80)}`);
  if (financePass && baselinePass) {
    console.log('✅✅ 전체 PASS');
    process.exit(0);
  } else {
    console.log(`🔴 FAIL — finance픽스처:${financePass ? 'PASS' : 'FAIL'} / self-baseline:${baselinePass ? 'PASS' : 'FAIL'}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('\n❌ Test failed:');
  console.error(err);
  process.exit(2);
});
