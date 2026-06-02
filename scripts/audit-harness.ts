/**
 * 인용 감사 튜닝 하니스 — 고정 fixture(답변+컨텍스트 동결) 위에서 결정적으로 감사.
 *   생성은 비결정적이라 한 번만(fixture 생성), 이후 감사만 반복해 프롬프트 튜닝.
 *
 *   npx tsx scripts/audit-harness.ts --regen   # fixture 재생성(비쌈, 1회)
 *   npx tsx scripts/audit-harness.ts           # 동결 fixture로 감사만(빠름)
 */
import { loadEnvFile } from 'process';
import fs from 'fs';
try { loadEnvFile('.env.local'); } catch {}
import { routeQuery } from '@/lib/agents/router';
import { buildNumberedContexts, resolveText } from '@/lib/llm/citations';
import { buildSystemPrompt, buildUserMessage } from '@/lib/llm/prompts';
import { getAnthropicClient, LLM_MODEL, MAX_TOKENS } from '@/lib/llm/client';
import { auditCitations } from '@/lib/llm/citation-audit';
import type { Role } from '@/lib/auth/roles';

const FIXTURE = 'scripts/audit-fixture.json';
const QUESTIONS = [
  '시기적으로 동시에 공고가 나고',
  '학부대학의 문제점',
  '이사회에서 시흥캠퍼스 논의가 있었나',
  '평의원회 관련 정보 최근 5개',
  '서울대 전체 예산은 얼마이고',
  '서울대학교는 현재의 "종합대학" 체계가 최선',
  '대학원생 처우의 가장 큰 이슈',
  '법인화 이후 서울대 재정 구조',
];

interface Fixture { question: string; role: string; answerRaw: string; contextMarkdown: string; mapping: [number, { wiki: string; page: string }][] }

async function regen() {
  const gold = JSON.parse(fs.readFileSync('scripts/gold-questions.json', 'utf-8'));
  const out: Fixture[] = [];
  for (const sub of QUESTIONS) {
    const g = gold.find((x: { question: string }) => x.question.includes(sub)) ?? { question: sub, role: 'tier1' };
    const role = (g.role || 'tier1') as Role;
    const routing = await routeQuery(g.question, role);
    const numbered = buildNumberedContexts(routing.contexts);
    const system = buildSystemPrompt(routing.contexts, role);
    const user = buildUserMessage(g.question, numbered.contextMarkdown, numbered.summary);
    const resp = await getAnthropicClient().messages.create({ model: LLM_MODEL, max_tokens: MAX_TOKENS, system, messages: [{ role: 'user', content: user }] });
    const answerRaw = resp.content.filter((b): b is { type: 'text'; text: string } => b.type === 'text').map(b => b.text).join('');
    const mapping = [...numbered.mapping.entries()].map(([n, r]) => [n, { wiki: r.wiki, page: r.page }] as [number, { wiki: string; page: string }]);
    out.push({ question: g.question, role, answerRaw, contextMarkdown: numbered.contextMarkdown, mapping });
    console.log(`  생성: ${g.question.slice(0, 40)} (인용 ${[...new Set([...answerRaw.matchAll(/\[(\d+)\]/g)].map(m => m[1]))].length})`);
  }
  fs.writeFileSync(FIXTURE, JSON.stringify(out, null, 2), 'utf-8');
  console.log(`💾 ${FIXTURE} (${out.length}개 동결)`);
}

async function audit() {
  const fx: Fixture[] = JSON.parse(fs.readFileSync(FIXTURE, 'utf-8'));
  let totalCites = 0, totalFlags = 0;
  for (const f of fx) {
    const cites = [...new Set([...f.answerRaw.matchAll(/\[(\d+)\]/g)].map(m => m[1]))].length;
    const sourceMap = new Map((f.mapping ?? []).map(([n, r]) => [n, r] as [number, { wiki: string; page: string }]));
    const a = await auditCitations(f.answerRaw, f.contextMarkdown, sourceMap);
    totalCites += cites; totalFlags += a.unsupported.length;
    console.log(`\n■ ${f.question.slice(0, 46)}  (인용 ${cites}, 지적 ${a.failed ? '⚠FAIL' : a.unsupported.length})`);
    for (const u of a.unsupported) console.log(`    ✗ [${u.n}] ${u.claim} — ${u.reason.slice(0, 110)}`);
  }
  console.log(`\n총 인용 ${totalCites} 중 지적 ${totalFlags} (${(100 * totalFlags / totalCites).toFixed(1)}%)`);
}

async function main() {
  if (process.argv.includes('--regen') || !fs.existsSync(FIXTURE)) { console.log('fixture 생성...'); await regen(); }
  await audit();
}
main().catch(e => { console.error(e); process.exit(1); });
