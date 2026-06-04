/**
 * policy 모드 검토 배치 — 실제 DB 질문 4건(외부필요 추정 2 + 내부충분 추정 2).
 * 각 질문: policy 답변 + web판단(발동/abstain) + 외부출처 + 신호. md 출력.
 * 예상 ~$1.05 (외부 2×~$0.35 + 내부 2×~$0.18). 승인됨.
 *   npx tsx --env-file=.env.local scripts/eval-policy-batch.ts
 */
import fs from 'fs';
import { routeQuery } from '@/lib/agents/router';
import { enforceContextBudget } from '@/lib/agents/context-budget';
import { complexityBudget, classifyComplexity } from '@/lib/agents/complexity';
import { buildPolicySystemPrompt, buildUserMessage } from '@/lib/llm/prompts';
import { buildNumberedContexts } from '@/lib/llm/citations';
import { getAnthropicClient, LLM_MODEL } from '@/lib/llm/client';

const ROLE = 'admin' as const;
const WEB = { type: 'web_search_20250305', name: 'web_search', max_uses: 1 };
const GUIDE = `\n\n[웹 검색 도구 — 공약설계 (능동 판단·직접 실행)]\n- 답에 외부 정보가 필요한지 네가 판단하고, *필요하면 직접 web_search로 가져온다*(최대 1회).\n- 외부가 필요한 경우 → **즉시 검색**: 질문이 타 대학·외부 기관과의 *비교를 전제*하거나, 현행 외부 법령·제도·외부 사례·통계가 답의 핵심인데 내부 위키에 없을 때.\n- ⛔ 금지: "자료에 없다"며 거절하거나 "원하시면 검색해 드리겠다"고 되묻는 것. 외부가 필요하다 판단한 순간 *네가 바로 검색해 답에 반영*하라. "내부에 없음"의 해결책은 거절이 아니라 검색이다.\n- 내부 거버넌스 사실로 충분히 답할 수 있으면 검색하지 않는다(비용). 검색 내용은 (외부지식)으로 표시, 출처 URL은 시스템이 자동 첨부.`;

type Q = { id: string; tag: string; q: string };
const QS: Q[] = [
  { id: 'E1', tag: '외부필요 추정', q: 'AI 관련 연구나 프로젝트와 관련하여 서울대가 최근 카이스트에 밀리고 있다는 관측이 많은데, 이렇게 된 원인을 진단해 주세요.' },
  { id: 'E2', tag: '외부필요 추정', q: '간호대학은 2030년 무렵에 연건캠퍼스에서 관악캠퍼스의 공대로 이전해. 간호대가 이전하면서 낙성대 근처의 유휴 부지에 요양시설을 짓고 서울대 구성원 및 지역사회 주민의 고령화 시대 수요에 맞는 서비스를 제공하는 방안은 가능할까? 요양시설과 함께 호스피스 병동, 그리고 서울대 장례식장, 서울대 공원 수목장 묘지를 하나의 패키지로 엮어서 제공하는 건 가능할까?' },
  { id: 'I1', tag: '내부충분 추정', q: '새로운 연구 분야, 융합적/학제적 연구 분야의 연구자를 채용하거나 전공/학과를 신설하는 일이 매우 어려워서 사회의 변화를 서울대가 따라가는 데 지장이 많습니다. 이렇게 된 원인을 진단해 주세요.' },
  { id: 'I2', tag: '내부충분 추정', q: '서울대학교는 현재의 "종합대학" 체계가 최선의 운영 방식인가? 개별 단과대학의 자율성을 보장하는 방안에 대해서 논의된 주요 역사를 정리해 보자.' },
];

type TextBlock = { type: 'text'; text: string; citations?: Array<{ url?: string; title?: string }> };
function renderWebSources(cites: { url: string; title: string }[]): string {
  const sU = new Set<string>(), sT = new Set<string>();
  const uniq = cites.filter(c => {
    if (!c.url || sU.has(c.url)) return false;
    const k = (c.title || '').slice(0, 24).trim();
    if (k && sT.has(k)) return false;
    sU.add(c.url); if (k) sT.add(k); return true;
  }).slice(0, 6);
  if (!uniq.length) return '';
  return `\n\n---\n\n### 🌐 외부 출처 (web_search)\n${uniq.map(c => `- [${c.title || c.url}](${c.url})`).join('\n')}`;
}

async function gen(q: string) {
  const routing = await routeQuery(q, ROLE);
  const ctxs = await enforceContextBudget(q, routing.contexts, complexityBudget(q));
  const numbered = buildNumberedContexts(ctxs);
  const sys = buildPolicySystemPrompt(ctxs, ROLE) + GUIDE;
  const user = buildUserMessage(q, numbered.contextMarkdown, numbered.summary);
  const resp = await getAnthropicClient().messages.create({
    model: LLM_MODEL, max_tokens: 4000, system: sys,
    messages: [{ role: 'user', content: user }], tools: [WEB] as unknown as never,
  });
  let body = '';
  const cites: { url: string; title: string }[] = [];
  for (const b of resp.content) {
    if (b.type === 'text') {
      body += (b as TextBlock).text;
      for (const c of ((b as TextBlock).citations ?? [])) if (c.url) cites.push({ url: c.url, title: c.title ?? c.url });
    } else if ((b as { type: string }).type === 'web_search_tool_result') {
      const wb = b as { content?: Array<{ url?: string; title?: string }> };
      if (Array.isArray(wb.content)) for (const r of wb.content) if (r?.url) cites.push({ url: r.url, title: r.title ?? r.url });
    }
  }
  const text = body + renderWebSources(cites);
  const u = resp.usage as { input_tokens: number; output_tokens: number; server_tool_use?: { web_search_requests?: number } };
  const webN = u.server_tool_use?.web_search_requests ?? 0;
  return {
    text, wikis: routing.selectedAgentIds, ctx: numbered.contextMarkdown.length,
    complexity: classifyComplexity(q), webN,
    links: (text.match(/\]\(https?:\/\//g) ?? []).length,
    cites: new Set(text.match(/\[\d+\]/g) ?? []).size,
    label: { 해석: (text.match(/\(해석\)/g) ?? []).length, 제안: (text.match(/\(제안\)/g) ?? []).length, 외부: (text.match(/\(외부지식\)/g) ?? []).length },
    cost: u.input_tokens / 1e6 * 3 + u.output_tokens / 1e6 * 15 + webN * 0.01, usage: u,
  };
}

async function main() {
  const out: string[] = ['# policy 모드 검토 — 실제 질문 4건 (외부필요 2 + 내부충분 2)\n', '> web 판단(발동/abstain)이 맞는지 + 답변 품질을 검토\n'];
  const rows: string[] = ['| 문항 | 추정 | web | 외부링크 | [N] | (해석/제안/외부) | ctx자 | 비용 |', '|---|---|---|---|---|---|---|---|'];
  let tot = 0;
  for (const item of QS) {
    const g = await gen(item.q);
    tot += g.cost;
    const judge = g.webN > 0 ? `🌐발동(${g.webN})` : '🏛️abstain';
    process.stdout.write(`${item.id} ${item.tag} | ${judge} | 링크${g.links} [N]${g.cites} | $${g.cost.toFixed(3)}\n`);
    rows.push(`| ${item.id} | ${item.tag} | ${judge} | ${g.links} | ${g.cites} | ${g.label.해석}/${g.label.제안}/${g.label.외부} | ${g.ctx} | $${g.cost.toFixed(3)} |`);
    out.push(`\n---\n\n## ${item.id} [${item.tag}] — ${judge}\n`);
    out.push(`**Q:** ${item.q}\n\n**라우팅:** ${g.wikis.join(', ')} | ${g.complexity} | ctx ${g.ctx.toLocaleString()}자 | web ${g.webN}회 | 외부링크 ${g.links} | [N] ${g.cites}종\n`);
    out.push(`\n### 🟢 공약설계 답변\n\n${g.text}\n`);
  }
  out.splice(2, 0, '\n## 신호 요약\n', ...rows, `\n💰 실제 총비용: **$${tot.toFixed(3)}**\n`);
  fs.writeFileSync('scripts/eval-policy-batch.out.md', out.join('\n'), 'utf-8');
  console.log(`\n✅ scripts/eval-policy-batch.out.md | 💰 실제 $${tot.toFixed(3)}`);
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
