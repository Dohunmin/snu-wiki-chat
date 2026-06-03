/**
 * P7 1차 평가 배치 — 실제 질문 6개(합성 0): 타깃 2 + 회귀(단순) 2 + 회귀(종합) 2.
 * 각 질문 NEW 1회 생성 + OLD(DB 로깅) 비교 + P7 발동 신호. md 출력.
 * 예상 ~$0.40 (상한 ~$0.55). 출력 max_tokens=4000.
 *   npx tsx --env-file=.env.local scripts/eval-p7.ts
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

type Q = { id: string; cat: '🎯타깃' | '🔁회귀(단순)' | '🔁회귀(종합)'; q: string };
const QS: Q[] = [
  { id: 'Q1', cat: '🎯타깃', q: '재정비전의 목표 설정의 근거는 제시되었나?' },
  { id: 'Q2', cat: '🎯타깃', q: '트랙별 연구평가 제도가 실제로 제도화 되었는가?' },
  { id: 'Q3', cat: '🔁회귀(단순)', q: '이사회가 주로 다루는 안건을 어떤 것들이 있습니까?' },
  { id: 'Q4', cat: '🔁회귀(단순)', q: '이사회에서 부결된 안건들은 어떤 것들이 있었나요?' },
  { id: 'Q5', cat: '🔁회귀(종합)', q: '서울대학교 자산 중 서울사대부속초등학교, 부속여자중학교, 부속고등학교가 있어. 사대부초, 부여중은 대학로에 있고, 사대부고는 고려대학교 근처에 있어. 이 학교들은 운동장을 갖고 있는데 요새 현대식 학교들은 운동장 땅을 건물로 지어서 실내 체육관으로 운동장 활용을 대신하고 있어. 사대부속 학교들의 부동산을 고층건물로 짓고 일부 저층은 원래 초중고등학교 용도로, 나머지 건물 고층부는 대학교의 교육 연구시설로 사용하는 것은 가능할까?' },
  { id: 'Q6', cat: '🔁회귀(종합)', q: '새로운 연구 분야, 융합적/학제적 연구 분야의 연구자를 채용하거나 전공/학과를 신설하는 일이 매우 어려워서 사회의 변화를 서울대가 따라가는 데 지장이 많습니다. 이렇게 된 원인을 진단해 주세요.' },
];

const P7SIG = /의결|제정|개정|운영지침|시행세칙|원안\s?심의|심의·?의결/g;  // P7 콘크리트 기록 신호

async function getOld(q: string): Promise<string | null> {
  const r = await sql`
    SELECT (SELECT a.content FROM messages a WHERE a.conversation_id=m.conversation_id
            AND a.role='assistant' AND a.created_at > m.created_at ORDER BY a.created_at ASC LIMIT 1) AS old
    FROM messages m WHERE m.role='user' AND m.content=${q} ORDER BY m.created_at DESC LIMIT 1`;
  return r.rows[0]?.old ?? null;
}

async function genNew(q: string) {
  const routing = await routeQuery(q, ROLE);
  const ctxs = await enforceContextBudget(q, routing.contexts, complexityBudget(q));
  const numbered = buildNumberedContexts(ctxs);
  const sys = buildSystemPrompt(ctxs, ROLE);
  const user = buildUserMessage(q, numbered.contextMarkdown, numbered.summary);
  const resp = await getAnthropicClient().messages.create({ model: LLM_MODEL, max_tokens: 4000, system: sys, messages: [{ role: 'user', content: user }] });
  const text = resp.content.filter((b): b is { type: 'text'; text: string } => b.type === 'text').map(b => b.text).join('');
  return { text, wikis: routing.selectedAgentIds, ctxChars: numbered.contextMarkdown.length, usage: resp.usage, complexity: classifyComplexity(q), budget: complexityBudget(q) };
}

async function main() {
  const out: string[] = ['# P7 1차 평가 — 실제 질문 6개 (NEW vs OLD)\n', '> 타깃=P7이 의결·제정기록 깖, 회귀=P7 과발동/비대화 안 함\n'];
  let totIn = 0, totOut = 0;
  const rows: string[] = ['| 문항 | 분류 | 복잡도 | ctx자 | NEW자 | P7신호 | 인용[N]수 |', '|---|---|---|---|---|---|---|'];
  for (const item of QS) {
    const n = await genNew(item.q);
    const old = await getOld(item.q);
    totIn += n.usage.input_tokens; totOut += n.usage.output_tokens;
    const p7hits = (n.text.match(P7SIG) ?? []).length;
    const cites = new Set((n.text.match(/\[\d+\]/g) ?? [])).size;
    process.stdout.write(`${item.id} ${item.cat} | ${n.complexity}/${n.budget} | ctx ${n.ctxChars} | NEW ${n.text.length}자 | P7신호 ${p7hits} | [N] ${cites}\n`);
    rows.push(`| ${item.id} | ${item.cat} | ${n.complexity} | ${n.ctxChars} | ${n.text.length} | ${p7hits} | ${cites} |`);
    out.push(`\n---\n\n## ${item.id} ${item.cat} (${n.complexity}/예산 ${n.budget})\n`);
    out.push(`**Q:** ${item.q}\n\n**NEW 위키:** ${n.wikis.join(', ')} | 컨텍스트 ${n.ctxChars.toLocaleString()}자 | P7신호(의결·제정 등) ${p7hits}회 | 인용 ${cites}종\n`);
    out.push(`\n### ⚪ OLD (DB 로깅)\n\n${old ?? '_(DB에 동일 질문 없음)_'}\n`);
    out.push(`\n### 🟢 NEW (P7 적용)\n\n${n.text}\n`);
  }
  const cost = totIn / 1e6 * 3 + totOut / 1e6 * 15;
  out.splice(2, 0, '\n## 신호 요약\n', ...rows, `\n💰 실제 비용: **$${cost.toFixed(3)}** (in ${totIn} / out ${totOut})\n`);
  fs.writeFileSync('scripts/eval-p7.out.md', out.join('\n'), 'utf-8');
  console.log(`\n✅ scripts/eval-p7.out.md | 💰 실제 $${cost.toFixed(3)} (in ${totIn} / out ${totOut})`);
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
