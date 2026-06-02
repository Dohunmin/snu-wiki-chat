/** 레버1(출력절제)+3(청크22) 효과 평가 — 새 설정으로 3질문 재생성, 길이·컨텍스트·인용 측정 */
import { loadEnvFile } from 'process';
import fs from 'fs';
try { loadEnvFile('.env.local'); } catch {}
import { routeQuery } from '@/lib/agents/router';
import { buildNumberedContexts, resolveText, extractCitedNumbers, resolveCitations } from '@/lib/llm/citations';
import { buildSystemPrompt, buildUserMessage } from '@/lib/llm/prompts';
import { getAnthropicClient, LLM_MODEL, MAX_TOKENS } from '@/lib/llm/client';
import type { Role } from '@/lib/auth/roles';

const textOf = (c: { type: string }[]) => c.filter((b): b is { type: 'text'; text: string } => b.type === 'text').map(b => b.text).join('');
const Q = [
  '서울대 예산의 비중을 각 항목 별로 알려줘. 고정성 예산과 비고정성 예산을 나눠주고, 서울대가 새로운 대학 운영을 위해 가용한 유동성 있는 예산의 규모를 추산할 수 있도록 분류해줘.',
  '지금까지 질문과 답변을 정리하면 서울대 예산은 고정성 예산이 많지만, 총장이 가용 예산을 늘리려면 기부금을 늘리는 수밖에 없고, 2034년 이후 적자 예상하는데 이를 해결하려면 구조적 재정 수입 성장과 학교채 발행을 적극적으로 고민해야 하겠네? 이것 외에 더 생각해볼 것을 정리해줘.',
  '새로운 연구 분야, 융합적/학제적 연구 분야의 연구자를 채용하거나 전공/학과를 신설하는 일이 매우 어려워서 사회의 변화를 서울대가 따라가는 데 지장이 많습니다. 이렇게 된 원인을 진단해 주세요.',
];
// 옛 답변(사용자 paste) 글자 수 — 비교용
const OLD_CHARS = [4900, 8200, 6100];

async function main() {
  const out: { q: string; ctx: number; ans: number; cites: number; bare: number; answer: string }[] = [];
  for (let i = 0; i < Q.length; i++) {
    const routing = await routeQuery(Q[i], 'tier1' as Role);
    const numbered = buildNumberedContexts(routing.contexts);
    const system = buildSystemPrompt(routing.contexts, 'tier1' as Role);
    const user = buildUserMessage(Q[i], numbered.contextMarkdown, numbered.summary);
    const resp = await getAnthropicClient().messages.create({ model: LLM_MODEL, max_tokens: MAX_TOKENS, system, messages: [{ role: 'user', content: user }] });
    const raw = textOf(resp.content);
    const resolved = resolveText(raw, numbered.mapping);
    const cites = resolveCitations(extractCitedNumbers(raw), numbered.mapping).length;
    const bare = (resolved.match(/\[\d[\d,\s]*\](?!\()/g) || []).length;
    out.push({ q: Q[i].slice(0, 30), ctx: [...numbered.contextMarkdown].length, ans: [...resolved].length, cites, bare, answer: resolved });
    console.log(`\n[${i + 1}] ${Q[i].slice(0, 30)}`);
    console.log(`  위키: ${routing.selectedAgentIds.join(',')}`);
    console.log(`  컨텍스트(입력) ${[...numbered.contextMarkdown].length}자 | 답변(출력) ${[...resolved].length}자 (옛 ~${OLD_CHARS[i]}자, ${Math.round(100 * (1 - [...resolved].length / OLD_CHARS[i]))}% ↓) | 인용 ${cites} | 숫자노출 ${bare}`);
  }
  fs.writeFileSync('scripts/eval-leverboth-out.json', JSON.stringify(out, null, 2), 'utf-8');
  const avgOut = out.reduce((s, o) => s + o.ans, 0) / out.length;
  const avgOld = OLD_CHARS.reduce((a, b) => a + b, 0) / OLD_CHARS.length;
  console.log(`\n평균 출력: 옛 ~${Math.round(avgOld)}자 → 새 ${Math.round(avgOut)}자 (${Math.round(100 * (1 - avgOut / avgOld))}% ↓)`);
  console.log('전문은 scripts/eval-leverboth-out.json');
}
main().catch(e => { console.error(e); process.exit(1); });
