/**
 * 단일조건 오인용 측정 — 현재 체크아웃된 코드(HEAD든 작업트리든)로
 * 같은 30질문(긴15+랜덤15, normal) 생성→Sonnet 감사로 오인용 수 측정.
 *   git stash로 HEAD에 두고 실행 → 원본(B-2 전) 오인용율.
 *
 * 실행: npx tsx scripts/measure-base-misc.ts
 */
import { loadEnvFile } from 'process';
import fs from 'fs';
try { loadEnvFile('.env.local'); } catch {}
import { fetchSheetQuestions } from './fetch-sheet-questions';
import { routeQuery } from '@/lib/agents/router';
import { buildNumberedContexts } from '@/lib/llm/citations';
import { buildSystemPrompt, buildUserMessage } from '@/lib/llm/prompts';
import { getAnthropicClient, LLM_MODEL, MAX_TOKENS } from '@/lib/llm/client';
import { auditCitations } from '@/lib/llm/citation-audit';
import type { Role } from '@/lib/auth/roles';

const textOf = (c: { type: string }[]) => c.filter((b): b is { type: 'text'; text: string } => b.type === 'text').map(b => b.text).join('');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function withRetry<T>(fn: () => Promise<T>, tries = 5): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (i >= tries - 1 || !/overload|rate.?limit|429|529|timeout|ETIMEDOUT|ECONNRESET/i.test(msg)) throw e;
      await sleep(2000 * (i + 1) + Math.floor(1000 * ((i * 37) % 10) / 10)); // 백오프
    }
  }
}
async function mapLimit<T, R>(items: T[], limit: number, fn: (it: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length); let idx = 0;
  const work = async () => { while (idx < items.length) { const i = idx++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, work)); return out;
}

async function main() {
  const raw = await fetchSheetQuestions();
  const seen = new Set<string>();
  const uniq = raw.filter(q => { const k = q.question.replace(/\s+/g, ' ').trim(); if (seen.has(k) || !q.answer || (q.mode || '').startsWith('lens:')) return false; seen.add(k); return true; });
  const byLen = [...uniq].sort((a, b) => b.length - a.length);
  const long15 = byLen.slice(0, 15);
  const ls = new Set(long15.map(q => q.question));
  const rest = uniq.filter(q => !ls.has(q.question));
  for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[rest[i], rest[j]] = [rest[j], rest[i]]; }
  const targets = [...long15, ...rest.slice(0, 15)].map(q => ({ question: q.question, role: (q.role || 'tier1') as Role }));

  const rows = await mapLimit(targets, 4, async (t, i) => {
    const routing = await routeQuery(t.question, t.role);
    // 작업트리면 opts 무시 안 함(showSourceId 기본 false=현행), HEAD면 opts 자체가 무시됨 — 둘 다 '현행 본문' 동작
    const numbered = buildNumberedContexts(routing.contexts);
    const system = buildSystemPrompt(routing.contexts, t.role);
    const user = buildUserMessage(t.question, numbered.contextMarkdown, numbered.summary);
    const resp = await withRetry(() => getAnthropicClient().messages.create({ model: LLM_MODEL, max_tokens: MAX_TOKENS, system, messages: [{ role: 'user', content: user }] }));
    const ans = textOf(resp.content);
    const cites = [...new Set([...ans.matchAll(/\[(\d+)\]/g)].map(m => m[1]))].length;
    const sourceMap = new Map([...numbered.mapping].map(([n, r]) => [n, { wiki: r.wiki, page: r.page }]));
    const a = await withRetry(() => auditCitations(ans, numbered.contextMarkdown, sourceMap));  // 2단계(소스전체) 포함
    console.log(`  [${i + 1}/${targets.length}] cites=${cites} mis=${a.unsupported.length}${a.failed ? ' (FAIL)' : ''}`);
    return { question: t.question, cites, mis: a.unsupported.length };
  });
  const mis = rows.reduce((s, r) => s + r.mis, 0);
  const cit = rows.reduce((s, r) => s + r.cites, 0);
  fs.writeFileSync('scripts/base-misc-results.json', JSON.stringify(rows, null, 2), 'utf-8');
  console.log(`\n✅ 총 오인용 ${mis} / 총 인용 ${cit} = ${(100 * mis / cit).toFixed(1)}%`);
}
main().catch(e => { console.error(e); process.exit(1); });
