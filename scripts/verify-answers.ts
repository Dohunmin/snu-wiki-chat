/**
 * 커밋 전 답변 품질 검증 — plan: docs/커밋_검토_2026-06-02.md §6
 *
 *   실제 시트 질문에서 길이 긴 15 + 랜덤 15를 뽑아
 *   → 현재 코드(A: B-2/M-5/citations 반영)로 답변 재생성 (chat route 로직 충실 복제)
 *   → 시트의 이전 답변과 Sonnet 심판으로 비교 (개선/오류 정리)
 *
 * ⚠️ 합성 질문 금지: 입력은 실제 시트만.
 * 실행: npx tsx scripts/verify-answers.ts
 *   출력: scripts/verify-results.json + docs/답변검증_2026-06-02.md
 */
import { loadEnvFile } from 'process';
import fs from 'fs';
try { loadEnvFile('.env.local'); } catch { /* 무시 */ }

import { fetchSheetQuestions, type SheetQuestion } from './fetch-sheet-questions';
import { routeQuery } from '@/lib/agents/router';
import { loadPersonaContext } from '@/lib/agents/lens';
import { buildNumberedContexts, resolveText } from '@/lib/llm/citations';
import { buildSystemPrompt, buildUserMessage, buildLensSystemPrompt, buildLensUserMessage } from '@/lib/llm/prompts';
import { getAnthropicClient, LLM_MODEL, MAX_TOKENS } from '@/lib/llm/client';
import type { Role } from '@/lib/auth/roles';

const VALID_ROLES = new Set(['admin', 'tier1', 'tier2', 'pending']);
const asRole = (r: string): Role => (VALID_ROLES.has(r) ? r : 'tier1') as Role;
const textOf = (content: { type: string }[]) =>
  content.filter((b): b is { type: 'text'; text: string } => b.type === 'text').map(b => (b as { text: string }).text).join('');
const citeCount = (s: string) => (s.match(/\[[^\]]+\]\([^)]+\)|\[\d+\]/g) || []).length;

async function mapLimit<T, R>(items: T[], limit: number, fn: (it: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function generate(q: SheetQuestion): Promise<{ answer: string; wikis: string[]; error?: string }> {
  const role = asRole(q.role);
  try {
    const routing = await routeQuery(q.question, role);
    const numbered = buildNumberedContexts(routing.contexts);
    let system: string, user: string;
    if ((q.mode || '').startsWith('lens:')) {
      const persona = await loadPersonaContext(q.mode.slice(5), q.question, role);
      if (!persona) return { answer: '', wikis: routing.selectedAgentIds, error: 'persona-null' };
      system = buildLensSystemPrompt(routing.contexts, persona, role);
      user = buildLensUserMessage(q.question, numbered.contextMarkdown, numbered.summary, persona);
    } else {
      system = buildSystemPrompt(routing.contexts, role);
      user = buildUserMessage(q.question, numbered.contextMarkdown, numbered.summary);
    }
    const resp = await getAnthropicClient().messages.create({
      model: LLM_MODEL, max_tokens: MAX_TOKENS, system, messages: [{ role: 'user', content: user }],
    });
    return { answer: resolveText(textOf(resp.content), numbered.mapping), wikis: routing.selectedAgentIds };
  } catch (err) {
    return { answer: '', wikis: [], error: err instanceof Error ? err.message : String(err) };
  }
}

interface Judgment { winner: 'new' | 'old' | 'tie'; improvements: string[]; regressions: string[]; summary: string; failed?: boolean }

async function judge(question: string, oldA: string, newA: string): Promise<Judgment> {
  const prompt = `서울대 거버넌스 위키 챗봇의 같은 질문에 대한 두 답변을 비교하세요.
"이전 답변"은 옛 코드, "새 답변"은 검색·인용 로직이 개선된 새 코드의 결과입니다.

질문: ${question}

[이전 답변]
${oldA.slice(0, 6000)}

[새 답변]
${newA.slice(0, 6000)}

평가 기준: (1) 검색 누락 복구(필요 자료를 더 잘 찾았나), (2) 인용 정확도/형식, (3) 사실 근거의 풍부함·구체성, (4) 한계 인정의 적절성. 자료 밖 추정으로 길어진 것은 개선 아님.

JSON만 출력(코드펜스 금지):
{"winner":"new|old|tie","improvements":["새 답변이 더 나은 점"],"regressions":["새 답변에서 나빠지거나 생긴 오류"],"summary":"한 줄 요약"}`;
  try {
    const resp = await getAnthropicClient().messages.create({
      model: LLM_MODEL, max_tokens: 1000, messages: [{ role: 'user', content: prompt }],
    });
    const raw = textOf(resp.content).trim();
    const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
    const obj = JSON.parse(raw.slice(s, e + 1));
    return {
      winner: ['new', 'old', 'tie'].includes(obj.winner) ? obj.winner : 'tie',
      improvements: Array.isArray(obj.improvements) ? obj.improvements.map(String) : [],
      regressions: Array.isArray(obj.regressions) ? obj.regressions.map(String) : [],
      summary: String(obj.summary ?? ''),
    };
  } catch (err) {
    return { winner: 'tie', improvements: [], regressions: [], summary: 'JUDGE_FAIL: ' + (err instanceof Error ? err.message : String(err)), failed: true };
  }
}

async function main() {
  console.log('시트에서 질문 로딩...');
  const raw = await fetchSheetQuestions();
  const seen = new Set<string>();
  const uniq = raw.filter(q => { const k = q.question.replace(/\s+/g, ' ').trim(); if (seen.has(k) || !q.answer) return false; seen.add(k); return true; });

  const byLen = [...uniq].sort((a, b) => b.length - a.length);
  const long15 = byLen.slice(0, 15);
  const longSet = new Set(long15.map(q => q.question));
  const rest = uniq.filter(q => !longSet.has(q.question));
  // 랜덤 15
  for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[rest[i], rest[j]] = [rest[j], rest[i]]; }
  const random15 = rest.slice(0, 15);

  const targets = [...long15.map(q => ({ ...q, group: 'long' })), ...random15.map(q => ({ ...q, group: 'random' }))];
  console.log(`대상 ${targets.length}개 (긴 ${long15.length} + 랜덤 ${random15.length}). 답변 재생성 중...`);

  const gen = await mapLimit(targets, 4, async (q, i) => {
    const r = await generate(q);
    console.log(`  [gen ${i + 1}/${targets.length}] ${q.group} (${q.length}자) ${r.error ? '❌' + r.error : '✓ ' + r.wikis.join(',')}`);
    return r;
  });

  console.log('심판(이전 vs 새) 비교 중...');
  const judged = await mapLimit(targets, 4, async (q, i) => {
    if (gen[i].error) return { winner: 'tie', improvements: [], regressions: ['생성 실패: ' + gen[i].error], summary: '생성 실패', failed: true } as Judgment;
    const j = await judge(q.question, q.answer, gen[i].answer);
    console.log(`  [judge ${i + 1}/${targets.length}] ${j.winner}`);
    return j;
  });

  const rows = targets.map((q, i) => ({
    group: q.group, length: q.length, role: q.role, mode: q.mode, question: q.question,
    routedWikis: gen[i].wikis, oldAnswer: q.answer, newAnswer: gen[i].answer, error: gen[i].error,
    oldLen: [...q.answer].length, newLen: [...(gen[i].answer || '')].length,
    oldCites: citeCount(q.answer), newCites: citeCount(gen[i].answer || ''),
    judgment: judged[i],
  }));
  fs.writeFileSync('scripts/verify-results.json', JSON.stringify(rows, null, 2), 'utf-8');

  // 집계
  const win = { new: 0, old: 0, tie: 0 };
  for (const r of rows) win[r.judgment.winner]++;
  const regressions = rows.filter(r => r.judgment.regressions.length > 0);

  // 리포트
  let md = `# 답변 품질 검증 (이전 vs 새 코드) — 2026-06-02\n\n`;
  md += `대상: 실제 시트 질문 **긴 15 + 랜덤 15 = ${rows.length}개**. 새 코드 = B-2(가중분배)+M-5(라우팅)+citations(H-5) 반영.\n\n`;
  md += `## 한눈에\n\n- 심판 판정: **새 더 나음 ${win.new}** / 동급 ${win.tie} / 이전 더 나음 ${win.old}\n`;
  md += `- 회귀(새에서 나빠짐) 발생: **${regressions.length}건**\n`;
  md += `- 평균 길이: 이전 ${Math.round(rows.reduce((a, r) => a + r.oldLen, 0) / rows.length)} → 새 ${Math.round(rows.reduce((a, r) => a + r.newLen, 0) / rows.length)}자\n`;
  md += `- 평균 인용 수: 이전 ${(rows.reduce((a, r) => a + r.oldCites, 0) / rows.length).toFixed(1)} → 새 ${(rows.reduce((a, r) => a + r.newCites, 0) / rows.length).toFixed(1)}\n\n`;

  if (regressions.length) {
    md += `## ⚠️ 회귀/오류 (검토 필요)\n\n`;
    for (const r of regressions) md += `- **${r.question.slice(0, 50)}** (${r.judgment.winner}): ${r.judgment.regressions.join(' / ')}\n`;
    md += `\n`;
  }
  md += `## 질문별\n\n| # | 그룹 | 판정 | 길이(전→후) | 인용(전→후) | 위키 | 요약 |\n|--:|---|---|---|---|---|---|\n`;
  rows.forEach((r, i) => {
    md += `| ${i + 1} | ${r.group} | ${r.judgment.winner} | ${r.oldLen}→${r.newLen} | ${r.oldCites}→${r.newCites} | ${r.routedWikis.join(',') || '-'} | ${r.judgment.summary.replace(/\|/g, '/').slice(0, 80)} |\n`;
  });
  md += `\n## 개선점 모음\n\n`;
  rows.filter(r => r.judgment.improvements.length).forEach(r => {
    md += `- **${r.question.slice(0, 45)}**: ${r.judgment.improvements.join(' / ')}\n`;
  });
  fs.writeFileSync('docs/답변검증_2026-06-02.md', md, 'utf-8');

  console.log(`\n✅ 완료 — 새:${win.new} 동급:${win.tie} 이전:${win.old}, 회귀 ${regressions.length}건`);
  console.log('   docs/답변검증_2026-06-02.md + scripts/verify-results.json');
}

main().catch(err => { console.error(err); process.exit(1); });
