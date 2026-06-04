/**
 * 공약설계(policy) 모드 검증 — 실제 DB 질문 1개를 policy 파이프라인으로 생성.
 * fact 모드가 약했던 Q5(외부지식 부재)를 policy(web_search max 2)로 돌려 차이 확인.
 * 비용: Sonnet 1회 + web_search ≤2 → ~$0.25~0.35. (실행 전 승인 필요)
 *   npx tsx --env-file=.env.local scripts/test-policy.ts
 */
import { routeQuery } from '@/lib/agents/router';
import { enforceContextBudget } from '@/lib/agents/context-budget';
import { complexityBudget, classifyComplexity } from '@/lib/agents/complexity';
import { buildPolicySystemPrompt, buildUserMessage } from '@/lib/llm/prompts';
import { buildNumberedContexts } from '@/lib/llm/citations';
import { getAnthropicClient, LLM_MODEL } from '@/lib/llm/client';

// 실제 사용자 질문 (DB 로깅) — 외부 법령이 결정적이라 web 켜지는 케이스. URL 출처 렌더링 검증용.
const Q = '서울대학교 자산 중 사대부속 학교들의 부동산을 고층건물로 짓고 일부 저층은 초중고 용도로, 고층부는 대학 교육·연구시설로 사용하는 것은 가능할까?';
const ROLE = 'admin' as const;
const WEB_SEARCH_TOOL_POLICY = { type: 'web_search_20250305', name: 'web_search', max_uses: 1 };
const GUIDE = `\n\n[웹 검색 도구 — 공약설계 (능동 판단·직접 실행)]\n- 답에 외부 정보가 필요한지 네가 판단하고, *필요하면 직접 web_search로 가져온다*(최대 1회).\n- 외부가 필요한 경우 → **즉시 검색**: 질문이 타 대학·외부 기관과의 *비교를 전제*하거나, 현행 외부 법령·제도·외부 사례·통계가 답의 핵심인데 내부 위키에 없을 때.\n- ⛔ 금지: "자료에 없다"며 거절하거나 "원하시면 검색해 드리겠다"고 되묻는 것. 외부가 필요하다 판단한 순간 *네가 바로 검색해 답에 반영*하라. "내부에 없음"의 해결책은 거절이 아니라 검색이다.\n- 내부 거버넌스 사실로 충분히 답할 수 있으면 검색하지 않는다(비용). 검색 내용은 (외부지식)으로 표시, 출처 URL은 시스템이 자동 첨부.`;

type TextBlock = { type: 'text'; text: string; citations?: Array<{ url?: string; title?: string }> };
function renderWebSources(cites: { url: string; title: string }[]): string {
  const seenUrl = new Set<string>(), seenTitle = new Set<string>();
  const uniq = cites.filter(c => {
    if (!c.url || seenUrl.has(c.url)) return false;
    const key = (c.title || '').slice(0, 24).trim();
    if (key && seenTitle.has(key)) return false;
    seenUrl.add(c.url); if (key) seenTitle.add(key);
    return true;
  }).slice(0, 6);
  if (uniq.length === 0) return '';
  return `\n\n---\n\n### 🌐 외부 출처 (web_search)\n${uniq.map(c => `- [${c.title || c.url}](${c.url})`).join('\n')}`;
}

async function main() {
  const routing = await routeQuery(Q, ROLE);
  const ctxs = await enforceContextBudget(Q, routing.contexts, complexityBudget(Q));
  const numbered = buildNumberedContexts(ctxs);
  const sys = buildPolicySystemPrompt(ctxs, ROLE) + GUIDE;
  const user = buildUserMessage(Q, numbered.contextMarkdown, numbered.summary);

  const resp = await getAnthropicClient().messages.create({
    model: LLM_MODEL, max_tokens: 4000, system: sys,
    messages: [{ role: 'user', content: user }],
    tools: [WEB_SEARCH_TOOL_POLICY] as unknown as never,
  });
  // 텍스트 + web_search 출처 추출 (route와 동일):
  //   (a) 텍스트 citation(모델이 직접 인용한 span) + (b) web_search_tool_result(검색한 페이지, URL 항상 존재)
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
  const cost = u.input_tokens / 1e6 * 3 + u.output_tokens / 1e6 * 15 + webN * 0.01;

  console.log(`══ POLICY 모드 검증 ══\nQ: ${Q}`);
  console.log(`복잡도 ${classifyComplexity(Q)} | 라우팅 ${routing.selectedAgentIds.join(', ')} | ctx ${numbered.contextMarkdown.length}자`);
  console.log(`\n────── 🟢 공약설계 답변 ──────\n${text}`);
  console.log(`\n── 신호 ──`);
  console.log(`web_search ${webN}회 | 외부링크 ${(text.match(/\]\(https?:\/\//g) ?? []).length}개 | 내부인용[N] ${new Set(text.match(/\[\d+\]/g) ?? []).size}종`);
  console.log(`라벨: (해석) ${(text.match(/\(해석\)/g) ?? []).length} / (제안) ${(text.match(/\(제안\)/g) ?? []).length} / (외부지식) ${(text.match(/\(외부지식\)/g) ?? []).length}`);
  console.log(`💰 $${cost.toFixed(4)} (in ${u.input_tokens} / out ${u.output_tokens} / web ${webN})`);
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
