/**
 * 오인용 예방 효과 측정 — 본문 회차 노출(강화 A) 전/후 비교.
 *   같은 질문(긴15+랜덤15, normal)에서:
 *     baseline   = showSourceId:false (현행, 본문에 회차 숨김)
 *     treatment  = showSourceId:true  (본문에 회차 노출)
 *   각각 생성→Sonnet 감사로 오인용 수 측정 + 옛형식 인용(부작용) 카운트.
 *
 * 실행: npx tsx scripts/measure-prevention.ts
 *   출력: docs/오인용예방_측정_2026-06-02.md + scripts/prevention-results.json
 */
import { loadEnvFile } from 'process';
import fs from 'fs';
try { loadEnvFile('.env.local'); } catch {}

import { fetchSheetQuestions } from './fetch-sheet-questions';
import { routeQuery } from '@/lib/agents/router';
import { buildNumberedContexts, detectOldFormatCitations } from '@/lib/llm/citations';
import { buildSystemPrompt, buildUserMessage } from '@/lib/llm/prompts';
import { getAnthropicClient, LLM_MODEL, MAX_TOKENS } from '@/lib/llm/client';
import { auditCitations } from '@/lib/llm/citation-audit';
import type { Role } from '@/lib/auth/roles';

const textOf = (c: { type: string }[]) => c.filter((b): b is { type: 'text'; text: string } => b.type === 'text').map(b => b.text).join('');

async function mapLimit<T, R>(items: T[], limit: number, fn: (it: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length); let idx = 0;
  const work = async () => { while (idx < items.length) { const i = idx++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, work));
  return out;
}

async function genAndAudit(question: string, role: Role, showSourceId: boolean) {
  const routing = await routeQuery(question, role);
  const numbered = buildNumberedContexts(routing.contexts, { showSourceId });
  const system = buildSystemPrompt(routing.contexts, role);
  const user = buildUserMessage(question, numbered.contextMarkdown, numbered.summary);
  const resp = await getAnthropicClient().messages.create({ model: LLM_MODEL, max_tokens: MAX_TOKENS, system, messages: [{ role: 'user', content: user }] });
  const raw = textOf(resp.content);
  const cites = [...new Set([...raw.matchAll(/\[(\d+)\]/g)].map(m => m[1]))].length;
  const oldFmt = detectOldFormatCitations(raw).length;
  const audit = await auditCitations(raw, numbered.contextMarkdown);
  return { cites, oldFmt, mis: audit.unsupported.length, failed: audit.failed ?? false, unsupported: audit.unsupported };
}

async function main() {
  const raw = await fetchSheetQuestions();
  const seen = new Set<string>();
  const uniq = raw.filter(q => { const k = q.question.replace(/\s+/g, ' ').trim(); if (seen.has(k) || !q.answer || (q.mode || '').startsWith('lens:')) return false; seen.add(k); return true; });
  const byLen = [...uniq].sort((a, b) => b.length - a.length);
  const long15 = byLen.slice(0, 15);
  const longSet = new Set(long15.map(q => q.question));
  const rest = uniq.filter(q => !longSet.has(q.question));
  for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[rest[i], rest[j]] = [rest[j], rest[i]]; }
  const targets = [...long15, ...rest.slice(0, 15)].map(q => ({ question: q.question, role: (q.role || 'tier1') as Role }));

  console.log(`대상 ${targets.length}개 × 2조건 = ${targets.length * 2} 생성+감사`);
  const rows = await mapLimit(targets, 4, async (t, i) => {
    const base = await genAndAudit(t.question, t.role, false);
    const treat = await genAndAudit(t.question, t.role, true);
    console.log(`  [${i + 1}/${targets.length}] base mis=${base.mis} oldfmt=${base.oldFmt} | treat mis=${treat.mis} oldfmt=${treat.oldFmt}`);
    return { question: t.question, base, treat };
  });
  fs.writeFileSync('scripts/prevention-results.json', JSON.stringify(rows, null, 2), 'utf-8');

  const sum = (f: (r: typeof rows[0]) => number) => rows.reduce((a, r) => a + f(r), 0);
  const bMis = sum(r => r.base.mis), tMis = sum(r => r.treat.mis);
  const bCit = sum(r => r.base.cites), tCit = sum(r => r.treat.cites);
  const bOld = sum(r => r.base.oldFmt), tOld = sum(r => r.treat.oldFmt);

  let md = `# 오인용 예방 측정 — 본문 회차 노출 전/후 (2026-06-02)\n\n`;
  md += `대상: 실제 시트 normal 질문 긴15+랜덤15 = ${rows.length}개. Sonnet 감사로 오인용 측정.\n\n`;
  md += `| | baseline(숨김) | treatment(회차노출) |\n|---|--:|--:|\n`;
  md += `| 총 오인용 | **${bMis}** | **${tMis}** |\n`;
  md += `| 총 인용 | ${bCit} | ${tCit} |\n`;
  md += `| 오인용율 | ${(100 * bMis / bCit).toFixed(1)}% | ${(100 * tMis / tCit).toFixed(1)}% |\n`;
  md += `| 옛형식 인용(부작용) | ${bOld} | ${tOld} |\n\n`;
  md += `**오인용 ${bMis}→${tMis} (${bMis ? Math.round(100 * (bMis - tMis) / bMis) : 0}% 감소), 부작용 옛형식 ${bOld}→${tOld}.**\n\n`;
  md += `## 질문별\n\n| # | base mis | treat mis | base old | treat old |\n|--:|--:|--:|--:|--:|\n`;
  rows.forEach((r, i) => { md += `| ${i + 1} | ${r.base.mis} | ${r.treat.mis} | ${r.base.oldFmt} | ${r.treat.oldFmt} |\n`; });
  fs.writeFileSync('docs/오인용예방_측정_2026-06-02.md', md, 'utf-8');
  console.log(`\n✅ 오인용 ${bMis}→${tMis}, 옛형식 ${bOld}→${tOld}  | docs/오인용예방_측정_2026-06-02.md`);
}
main().catch(e => { console.error(e); process.exit(1); });
