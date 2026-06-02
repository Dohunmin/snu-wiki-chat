/**
 * 인용 감사 가드(B) 효과·오탐 테스트.
 *   알려진 오인용 2건 + 정상 3건을 실제 파이프라인(routeQuery→생성→감사)으로 돌려
 *   감사가 오인용을 잡는지 / 정상 인용을 오탐하는지 확인.
 *
 * 실행: npx tsx scripts/test-citation-audit.ts
 */
import { loadEnvFile } from 'process';
import fs from 'fs';
try { loadEnvFile('.env.local'); } catch { /* 무시 */ }

import { routeQuery } from '@/lib/agents/router';
import { buildNumberedContexts, resolveText } from '@/lib/llm/citations';
import { buildSystemPrompt, buildUserMessage } from '@/lib/llm/prompts';
import { getAnthropicClient, LLM_MODEL, MAX_TOKENS } from '@/lib/llm/client';
import { auditCitations } from '@/lib/llm/citation-audit';
import type { Role } from '@/lib/auth/roles';

// 알려진 오인용 2건(잡아야 함) + 정상 3건(오탐 없어야 함)
const TARGETS: { q: string; expect: 'mis' | 'ok' }[] = [
  { q: '시기적으로 동시에 공고가 나고', expect: 'mis' },   // 겸임교원 18기-19차 오인용
  { q: '학부대학의 문제점', expect: 'mis' },                 // 17기-21차 오인용
  { q: '이사회에서 시흥캠퍼스 논의가 있었나', expect: 'ok' },
  { q: '평의원회 관련 정보 최근 5개', expect: 'ok' },
  { q: '서울대 전체 예산은 얼마이고', expect: 'ok' },
];

async function main() {
  const gold: { question: string; role: string; mode: string }[] = JSON.parse(fs.readFileSync('scripts/gold-questions.json', 'utf-8'));
  // gold-questions에 없는 것은 시트 fallback 불필요 — 부분일치로 찾기
  const allQ = gold;

  for (const t of TARGETS) {
    const found = allQ.find(g => g.question.includes(t.q)) ?? { question: t.q, role: 'tier1', mode: 'normal' };
    const role = (found.role || 'tier1') as Role;
    console.log('\n' + '═'.repeat(78));
    console.log(`[${t.expect === 'mis' ? '오인용 예상' : '정상 예상'}] ${found.question.slice(0, 50)}`);
    console.log('═'.repeat(78));

    const routing = await routeQuery(found.question, role);
    const numbered = buildNumberedContexts(routing.contexts);
    const system = buildSystemPrompt(routing.contexts, role);
    const user = buildUserMessage(found.question, numbered.contextMarkdown, numbered.summary);
    const resp = await getAnthropicClient().messages.create({
      model: LLM_MODEL, max_tokens: MAX_TOKENS, system, messages: [{ role: 'user', content: user }],
    });
    const rawAns = resp.content.filter((b): b is { type: 'text'; text: string } => b.type === 'text').map(b => b.text).join('');

    const audit = await auditCitations(rawAns, numbered.contextMarkdown);
    console.log(`인용 수: ${[...new Set([...rawAns.matchAll(/\[(\d+)\]/g)].map(m => m[1]))].length}  |  감사 결과: ${audit.failed ? '⚠️FAIL' : audit.unsupported.length + '건 오인용 지적'}`);
    for (const u of audit.unsupported) {
      const ref = numbered.mapping.get(u.n);
      console.log(`  ✗ [${u.n}] → ${ref ? '[' + ref.wiki + '] ' + ref.page : '?'}  | 주장: ${u.claim}  | 사유: ${u.reason}`);
    }
    if (audit.unsupported.length === 0) console.log('  (지적 없음)');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
