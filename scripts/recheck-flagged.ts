/**
 * 플래그된 2건 재검증 — E1(카이스트: 능동 검색되나?) + I1(진단: [N] 생기나?).
 * 수정(능동검색·진단 [N]) 후 확인. 예상 ~$0.53 (E1 web발동~$0.35 + I1 abstain~$0.18).
 *   npx tsx --env-file=.env.local scripts/recheck-flagged.ts
 */
import fs from 'fs';
import { routeQuery } from '@/lib/agents/router';
import { enforceContextBudget } from '@/lib/agents/context-budget';
import { complexityBudget } from '@/lib/agents/complexity';
import { buildPolicySystemPrompt, buildUserMessage } from '@/lib/llm/prompts';
import { buildNumberedContexts } from '@/lib/llm/citations';
import { getAnthropicClient, LLM_MODEL } from '@/lib/llm/client';

const ROLE = 'admin' as const;
const WEB = { type: 'web_search_20250305', name: 'web_search', max_uses: 1 };
const GUIDE = `\n\n[웹 검색 도구 — 공약설계 (능동 판단·직접 실행)]\n- 답에 외부 정보가 필요한지 네가 판단하고, *필요하면 직접 web_search로 가져온다*(최대 1회).\n- 외부가 필요한 경우 → **즉시 검색**: 질문이 타 대학·외부 기관과의 *비교를 전제*하거나, 현행 외부 법령·제도·외부 사례·통계가 답의 핵심인데 내부 위키에 없을 때.\n- ⛔ 금지: "자료에 없다"며 거절하거나 "원하시면 검색해 드리겠다"고 되묻는 것. 외부가 필요하다 판단한 순간 *네가 바로 검색해 답에 반영*하라. "내부에 없음"의 해결책은 거절이 아니라 검색이다.\n- 내부 거버넌스 사실로 충분히 답할 수 있으면 검색하지 않는다(비용). 검색 내용은 (외부지식)으로 표시, 출처 URL은 시스템이 자동 첨부.`;

const QS = [
  { id: 'E1', q: 'AI 관련 연구나 프로젝트와 관련하여 서울대가 최근 카이스트에 밀리고 있다는 관측이 많은데, 이렇게 된 원인을 진단해 주세요.' },
  { id: 'I1', q: '새로운 연구 분야, 융합적/학제적 연구 분야의 연구자를 채용하거나 전공/학과를 신설하는 일이 매우 어려워서 사회의 변화를 서울대가 따라가는 데 지장이 많습니다. 이렇게 된 원인을 진단해 주세요.' },
];

type TextBlock = { type: 'text'; text: string; citations?: Array<{ url?: string; title?: string }> };
function srcs(c: { url: string; title: string }[]): string {
  const sU = new Set<string>(), sT = new Set<string>();
  const u = c.filter(x => { if (!x.url || sU.has(x.url)) return false; const k = (x.title || '').slice(0, 24).trim(); if (k && sT.has(k)) return false; sU.add(x.url); if (k) sT.add(k); return true; }).slice(0, 6);
  return u.length ? `\n\n---\n\n### 🌐 외부 출처 (web_search)\n${u.map(x => `- [${x.title || x.url}](${x.url})`).join('\n')}` : '';
}

async function main() {
  const out: string[] = ['# 재검증 — 플래그 2건 (능동검색·[N] 수정 후)\n'];
  let tot = 0;
  for (const it of QS) {
    const routing = await routeQuery(it.q, ROLE);
    const ctxs = await enforceContextBudget(it.q, routing.contexts, complexityBudget(it.q));
    const numbered = buildNumberedContexts(ctxs);
    const sys = buildPolicySystemPrompt(ctxs, ROLE) + GUIDE;
    const resp = await getAnthropicClient().messages.create({
      model: LLM_MODEL, max_tokens: 4000, system: sys,
      messages: [{ role: 'user', content: buildUserMessage(it.q, numbered.contextMarkdown, numbered.summary) }],
      tools: [WEB] as unknown as never,
    });
    let body = ''; const cites: { url: string; title: string }[] = [];
    for (const b of resp.content) {
      if (b.type === 'text') { body += (b as TextBlock).text; for (const c of ((b as TextBlock).citations ?? [])) if (c.url) cites.push({ url: c.url, title: c.title ?? c.url }); }
      else if ((b as { type: string }).type === 'web_search_tool_result') { const wb = b as { content?: Array<{ url?: string; title?: string }> }; if (Array.isArray(wb.content)) for (const r of wb.content) if (r?.url) cites.push({ url: r.url, title: r.title ?? r.url }); }
    }
    const text = body + srcs(cites);
    const u = resp.usage as { input_tokens: number; output_tokens: number; server_tool_use?: { web_search_requests?: number } };
    const webN = u.server_tool_use?.web_search_requests ?? 0;
    const cost = u.input_tokens / 1e6 * 3 + u.output_tokens / 1e6 * 15 + webN * 0.01; tot += cost;
    const nCite = new Set(text.match(/\[\d+\]/g) ?? []).size;
    const links = (text.match(/\]\(https?:\/\//g) ?? []).length;
    console.log(`${it.id}: web ${webN > 0 ? `🌐발동(${webN})` : '🏛️abstain'} | 외부링크 ${links} | [N] ${nCite}종 | $${cost.toFixed(3)}`);
    out.push(`\n---\n\n## ${it.id} — web ${webN}회 | 외부링크 ${links} | [N] ${nCite}종\n\n**Q:** ${it.q}\n\n### 🟢 답변\n\n${text}\n`);
  }
  out.push(`\n💰 실제 $${tot.toFixed(3)}`);
  fs.writeFileSync('scripts/recheck-flagged.out.md', out.join('\n'), 'utf-8');
  console.log(`\n✅ scripts/recheck-flagged.out.md | 💰 $${tot.toFixed(3)}`);
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
