/**
 * 트랙평가 단일 질문 — NEW 답변 1회 생성 vs OLD(DB 로깅). 컨텍스트엔 내용 있음(trace-track 확인) →
 * 남은 갭이 *생성*인지 확인. 비용: Sonnet 1회(~$0.07).
 *   npx tsx --env-file=.env.local scripts/trace-answer.ts
 */
import { sql } from '@vercel/postgres';
import { routeQuery } from '@/lib/agents/router';
import { enforceContextBudget } from '@/lib/agents/context-budget';
import { complexityBudget } from '@/lib/agents/complexity';
import { buildSystemPrompt, buildUserMessage } from '@/lib/llm/prompts';
import { buildNumberedContexts } from '@/lib/llm/citations';
import { getAnthropicClient, LLM_MODEL } from '@/lib/llm/client';

const Q = '트랙별 연구평가 제도가 실제로 제도화 되었는가?';
const ROLE = 'tier1' as const;

async function getOld(): Promise<string | null> {
  const r = await sql`
    SELECT (SELECT a.content FROM messages a WHERE a.conversation_id=m.conversation_id
            AND a.role='assistant' AND a.created_at > m.created_at ORDER BY a.created_at ASC LIMIT 1) AS old
    FROM messages m WHERE m.role='user' AND m.content=${Q} ORDER BY m.created_at DESC LIMIT 1`;
  return r.rows[0]?.old ?? null;
}

async function main() {
  const routing = await routeQuery(Q, ROLE);
  const ctxs = await enforceContextBudget(Q, routing.contexts, complexityBudget(Q));
  const numbered = buildNumberedContexts(ctxs);
  const sys = buildSystemPrompt(ctxs, ROLE);
  const user = buildUserMessage(Q, numbered.contextMarkdown, numbered.summary);
  const resp = await getAnthropicClient().messages.create({ model: LLM_MODEL, max_tokens: 4000, system: sys, messages: [{ role: 'user', content: user }] });
  const text = resp.content.filter((b): b is { type: 'text'; text: string } => b.type === 'text').map(b => b.text).join('');
  const old = await getOld();
  const cost = resp.usage.input_tokens / 1e6 * 3 + resp.usage.output_tokens / 1e6 * 15;

  console.log(`\n══════ Q: ${Q} ══════`);
  console.log(`라우팅: ${routing.selectedAgentIds.join(', ')} | 컨텍스트 ${numbered.contextMarkdown.length}자`);
  console.log(`\n────── ⚪ OLD (DB 로깅) ──────\n${old ?? '(DB에 없음)'}`);
  console.log(`\n────── 🟢 NEW (현재 파이프라인) ──────\n${text}`);
  console.log(`\n💰 NEW 생성 1회: $${cost.toFixed(4)} (in ${resp.usage.input_tokens} / out ${resp.usage.output_tokens})`);
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
