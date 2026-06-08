/**
 * 위키별 실제 질문 품질 비교 — DB routedAgents로 위키 골고루 ~10개(실제 질문만, 합성 X) →
 * old(로깅 답변) vs new(복잡도 라우팅). 앞선 비교가 finance/거버넌스 편중이라 위키 다양성 보강.
 *   npx tsx --env-file=.env.local scripts/quality-by-wiki.ts
 * 비용: NEW 생성만(old는 DB=공짜). 단순/종합 섞여 ~$0.6-0.8.
 */
import fs from 'fs';
import { sql } from '@vercel/postgres';
import { routeQuery } from '@/lib/agents/router';
import { enforceContextBudget } from '@/lib/agents/context-budget';
import { complexityBudget, classifyComplexity } from '@/lib/agents/complexity';
import { buildSystemPrompt, buildUserMessage } from '@/lib/llm/prompts';
import { buildNumberedContexts } from '@/lib/llm/citations';
import { getAnthropicClient, LLM_MODEL } from '@/lib/llm/client';

const ROLE = 'tier1' as const;
const PER_WIKI = 2;     // 위키당 최대
const TARGET = 10;
const master = (process.env.MASTER_ADMIN_EMAIL ?? '').toLowerCase();

async function genNew(q: string) {
  const routing = await routeQuery(q, ROLE);
  const budget = complexityBudget(q);
  const ctxs = await enforceContextBudget(q, routing.contexts, budget);
  const numbered = buildNumberedContexts(ctxs);
  const sys = buildSystemPrompt(ctxs, ROLE);
  const user = buildUserMessage(q, numbered.contextMarkdown, numbered.summary);
  const resp = await getAnthropicClient().messages.create({ model: LLM_MODEL, max_tokens: 4000, system: sys, messages: [{ role: 'user', content: user }] });
  const text = resp.content.filter((b): b is { type: 'text'; text: string } => b.type === 'text').map(b => b.text).join('');
  return { text, wikis: routing.selectedAgentIds, ctxChars: numbered.contextMarkdown.length, usage: resp.usage, complexity: classifyComplexity(q), budget };
}

async function main() {
  const r = await sql`
    SELECT u.email, u.role AS urole, m.content AS q, m.routed_agents AS wikis,
      (SELECT a.content FROM messages a WHERE a.conversation_id = m.conversation_id AND a.role='assistant' AND a.created_at > m.created_at ORDER BY a.created_at ASC LIMIT 1) AS old
    FROM messages m JOIN conversations c ON m.conversation_id=c.id JOIN users u ON c.user_id=u.id
    WHERE m.role='user' AND m.mode='normal'`;
  const seen = new Set<string>();
  const cands = r.rows.filter((x: any) =>
    x.urole !== 'admin' && (x.email || '').toLowerCase() !== master &&
    x.old && x.old.length > 300 && (x.wikis?.length ?? 0) > 0 &&
    (seen.has(x.q) ? false : (seen.add(x.q), true)));

  // 위키 골고루: primary wiki(첫 routedAgent, leesj/단과대 제외)별 그룹 → 위키당 PER_WIKI개
  const skip = new Set(['leesj']);
  const cap: Record<string, number> = {};
  const picks: any[] = [];
  // 긴(종합) 우선이 아니라 위키 다양성 우선 — 위키별로 1개씩 라운드로빈
  const byWiki = new Map<string, any[]>();
  for (const c of cands) {
    const w = (c.wikis as string[]).find(x => !skip.has(x) && x.length <= 14) ?? c.wikis[0];
    if (skip.has(w)) continue;
    (byWiki.get(w) ?? byWiki.set(w, []).get(w))!.push(c);
  }
  for (let round = 0; round < PER_WIKI && picks.length < TARGET; round++)
    for (const [w, qs] of byWiki) { if (picks.length >= TARGET) break; if (qs[round]) { (cap[w] = (cap[w] ?? 0) + 1); picks.push({ ...qs[round], primary: w }); } }

  console.log(`후보 ${cands.length} → 위키 ${byWiki.size}종 → 선택 ${picks.length}개\n`);
  const out: string[] = ['# 위키별 품질 비교 — old(로깅) vs new(복잡도 라우팅)\n'];
  let totIn = 0, totOut = 0;
  for (let i = 0; i < picks.length; i++) {
    const p = picks[i];
    const n = await genNew(p.q);
    totIn += n.usage.input_tokens; totOut += n.usage.output_tokens;
    process.stdout.write(`[${i + 1}/${picks.length}] ${p.primary} | ${n.complexity}/${n.budget} | ${n.ctxChars}자\n`);
    out.push(`\n---\n\n## ${i + 1}. [primary: ${p.primary}] (${p.q.length}자, ${n.complexity}/예산 ${n.budget})\n`);
    out.push(`**Q:** ${p.q}\n\n**NEW 위키:** ${n.wikis.join(', ')} | 컨텍스트 ${n.ctxChars.toLocaleString()}자\n`);
    out.push(`\n### ⚪ OLD (로깅)\n\n${p.old}\n`);
    out.push(`\n### 🟢 NEW (복잡도 라우팅)\n\n${n.text}\n`);
  }
  const cost = totIn / 1e6 * 3 + totOut / 1e6 * 15;
  out.push(`\n---\n💰 NEW 생성 ${picks.length}개 ~$${cost.toFixed(3)}`);
  fs.writeFileSync('scripts/quality-by-wiki.out.md', out.join('\n'), 'utf-8');
  console.log(`\n✅ scripts/quality-by-wiki.out.md (${picks.length}쌍) 💰~$${cost.toFixed(3)}`);
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
