/**
 * 답변 품질 비교 (커밋 전 최종 게이트) — 실제 구글시트 로깅 Q&A에서 긴/중요 질문 10개 추출,
 * old(시트 F열, production 로깅 답변) vs new(rerank+예산+flat풀 파이프라인 생성) 나란히.
 *   GLOBAL_TOPK_ENABLED=true RERANK_ENABLED=true npx tsx --env-file=.env.local scripts/quality-compare.ts [N]
 * 비용: NEW 생성만(old는 시트=공짜). NEW 컨텍스트 작아 ~$0.07×N.
 */
import fs from 'fs';
import { routeQuery } from '@/lib/agents/router';
import { enforceContextBudget } from '@/lib/agents/context-budget';
import { complexityBudget, classifyComplexity } from '@/lib/agents/complexity';
import { buildSystemPrompt, buildUserMessage } from '@/lib/llm/prompts';
import { buildNumberedContexts } from '@/lib/llm/citations';
import { getAnthropicClient, LLM_MODEL } from '@/lib/llm/client';
import { db } from '@/lib/db/client';
import { messages } from '@/lib/db/schema';
import { asc } from 'drizzle-orm';
import type { Role } from '@/lib/auth/roles';

// env 존중 (기본은 켜둠) — 고친 설정 실험용으로 GLOBAL_TOPK_ENABLED=false 등 외부 주입 가능.
process.env.GLOBAL_TOPK_ENABLED ??= 'true';
process.env.RERANK_ENABLED ??= 'true';
const N = Number(process.argv[2] ?? '10');
console.log(`설정: GLOBAL_TOPK=${process.env.GLOBAL_TOPK_ENABLED} RERANK=${process.env.RERANK_ENABLED} BUDGET=${process.env.CONTEXT_BUDGET_CHARS ?? '14000'}`);
const ROLE: Role = 'tier1';   // 표준 인가 사용자(sensitive 접근). NEW/OLD 권한 동일 가정.

// 실제 production Q&A = messages 테이블의 user→assistant 페어 (구글시트와 동일 데이터, 로컬 접근).
async function readSheet() {
  const rows = await db
    .select({ cid: messages.conversationId, role: messages.role, content: messages.content, mode: messages.mode, createdAt: messages.createdAt })
    .from(messages)
    .orderBy(asc(messages.conversationId), asc(messages.createdAt));
  const pairs: { role: Role; q: string; old: string; mode: string }[] = [];
  for (let i = 0; i < rows.length - 1; i++) {
    const u = rows[i], a = rows[i + 1];
    if (u.role === 'user' && a.role === 'assistant' && u.cid === a.cid) {
      pairs.push({ role: ROLE, q: u.content, old: a.content, mode: u.mode || 'normal' });
    }
  }
  return pairs;
}

async function genNew(q: string, role: Role) {
  const routing = await routeQuery(q, role);
  const budget = process.env.CONTEXT_BUDGET_CHARS ? Number(process.env.CONTEXT_BUDGET_CHARS) : complexityBudget(q);
  const ctxs = await enforceContextBudget(q, routing.contexts, budget);
  const numbered = buildNumberedContexts(ctxs);
  const system = buildSystemPrompt(ctxs, role);
  const user = buildUserMessage(q, numbered.contextMarkdown, numbered.summary);
  const resp = await getAnthropicClient().messages.create({ model: LLM_MODEL, max_tokens: 4000, system, messages: [{ role: 'user', content: user }] });
  const text = resp.content.filter((b): b is { type: 'text'; text: string } => b.type === 'text').map(b => b.text).join('');
  return { text, wikis: routing.selectedAgentIds, ctxChars: numbered.contextMarkdown.length, usage: resp.usage, complexity: classifyComplexity(q), budget };
}

async function main() {
  const rows = await readSheet();
  // 정규모드 + 충분한 답변 + 중복 질문 제거 → 긴 질문 우선 N개 (실제 시트만, 합성 X)
  const seen = new Set<string>();
  const pool = rows.filter((r: any) => r.q.length > 15 && r.old.length > 300 && !r.mode.startsWith('lens') && (seen.has(r.q) ? false : (seen.add(r.q), true)));
  pool.sort((a: any, b: any) => b.q.length - a.q.length);
  const picks = pool.slice(0, N);
  console.log(`시트 ${rows.length}행 → 후보 ${pool.length} → 긴 질문 ${picks.length}개 선택\n`);

  const out: string[] = ['# 답변 품질 비교 — old(시트) vs new(rerank+예산+flat풀)\n'];
  let totIn = 0, totOut = 0;
  for (let i = 0; i < picks.length; i++) {
    const p = picks[i];
    process.stdout.write(`[${i + 1}/${picks.length}] (${p.q.length}자) 생성 중...\n`);
    const r = await genNew(p.q, p.role);
    totIn += r.usage.input_tokens; totOut += r.usage.output_tokens;
    out.push(`\n---\n\n## ${i + 1}. (질문 ${p.q.length}자 / role ${p.role})\n\n**Q:** ${p.q}\n`);
    out.push(`**NEW [${r.complexity}/예산 ${r.budget.toLocaleString()}자]:** ${r.wikis.join(', ')} | 컨텍스트 ${r.ctxChars.toLocaleString()}자 | 입력 ${r.usage.input_tokens}tok\n`);
    process.stdout.write(`     → ${r.complexity}, 예산 ${r.budget}, 컨텍스트 ${r.ctxChars}자\n`);
    out.push(`\n### ⚪ OLD (시트 로깅, production)\n\n${p.old}\n`);
    out.push(`\n### 🟢 NEW (rerank+예산+flat풀)\n\n${r.text}\n`);
  }
  const cost = totIn / 1e6 * 3 + totOut / 1e6 * 15;
  out.push(`\n---\n\n💰 NEW 생성 ${picks.length}개: 입력 ${totIn.toLocaleString()} / 출력 ${totOut.toLocaleString()} → ~$${cost.toFixed(3)} (old는 시트=공짜)`);
  const outPath = process.env.GLOBAL_TOPK_ENABLED === 'true' ? 'scripts/quality-compare.out.md' : 'scripts/quality-compare.fix.out.md';
  fs.writeFileSync(outPath, out.join('\n'), 'utf-8');
  console.log(`\n✅ ${outPath} 저장 (${picks.length}쌍)`);
  console.log(`💰 NEW 생성 비용 ~$${cost.toFixed(3)} (입력 ${totIn.toLocaleString()}/출력 ${totOut.toLocaleString()}tok)`);
}
main().catch(e => { console.error(e); process.exit(1); });
