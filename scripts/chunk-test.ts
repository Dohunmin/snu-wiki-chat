/**
 * A1 검증 — (1) chunkLabeled 단위: 테이블 무결·섹션 분할·fact통째
 *           (2) end-to-end citation 정합: 실제 쿼리로 labeled 청크화 후 [N] 변환·(id)누출 0 확인.
 *   GLOBAL_TOPK_ENABLED=true RERANK_ENABLED=true npx tsx --env-file=.env.local scripts/chunk-test.ts
 * 비용: 쿼리당 임베딩+rerank ≈ $0.001.
 */
import fs from 'fs';
import { chunkLabeled } from '@/lib/agents/wiki-agent';
import { routeQuery } from '@/lib/agents/router';
import { enforceContextBudget } from '@/lib/agents/context-budget';
import { buildNumberedContexts } from '@/lib/llm/citations';

function tableBroken(text: string): boolean {
  const dataRows = (text.match(/^\s*\|.*\|.*$/gm) || []).length;
  const sepRows = (text.match(/^\s*\|[\s:|-]*-[\s:|-]*\|/gm) || []).length;
  return dataRows >= 2 && sepRows === 0;
}
function pickLargest(type: 'entities' | 'overviews') {
  const files = fs.readdirSync('data').filter(f => f.endsWith('.json') && !['agents.config.json', 'concept-index.json'].includes(f));
  let best: any = null;
  for (const f of files) { let d: any; try { d = JSON.parse(fs.readFileSync('data/' + f, 'utf8')); } catch { continue; }
    for (const x of (d[type] || [])) if (/\|[^\n]*\|[^\n]*\|/.test(x.content || '') && (!best || (x.content || '').length > best.content.length)) best = x; }
  return best;
}

// ── (1) 단위 검증 ──
console.log('═══ (1) chunkLabeled 단위 ═══');
const ent = pickLargest('entities');
if (ent) {
  const cs = chunkLabeled('entity', ent.content);
  let broken = cs.some(c => tableBroken(c.text));
  console.log(`entity "${ent.name}" ${ent.content.length}자 → ${cs.length}청크 ${broken ? '🔴표깨짐' : '✅무결'}`);
  cs.forEach((c, i) => console.log(`  [${i + 1}] ${String(c.text.length).padStart(4)}자 | 섹션: "${c.section}"`));
}
const fin = JSON.parse(fs.readFileSync('data/finance.json', 'utf8'));
const fact = (fin.facts || [])[0];
if (fact) { const c = chunkLabeled('fact', fact.content); console.log(`fact "${fact.title}" → ${c.length}청크 ${c.length === 1 ? '✅통째' : '🔴분할!'}`); }

// ── (2) end-to-end citation 정합 ──
async function citationCheck() {
  console.log('\n═══ (2) citation 정합 (실제 쿼리) ═══');
  const queries = ['서울대 재정구조와 정부출연금 비중 알려줘', '서울대 예산의 고정성·비고정성 항목별 비중'];
  for (const q of queries) {
    const r = await routeQuery(q, 'admin');
    const ctxs = await enforceContextBudget(q, r.contexts, Number(process.env.CONTEXT_BUDGET_CHARS ?? '14000'));
    const numbered = buildNumberedContexts(ctxs);
    const md = numbered.contextMarkdown;
    // (id) 누출: fact/stance/overview id가 본문에 남아있나 (있으면 citation 깨짐)
    const idLeaks = (md.match(/\([\w가-힣._-]+\.(?:fact|stance|overview)\)/g) || []);
    // [N] 모두 매핑 범위 내인가
    const nums = [...md.matchAll(/\[(\d+)\]/g)].map(m => +m[1]);
    const overflow = nums.filter(n => n > numbered.mapping.size);
    // 같은 fact가 여러 블록이면 같은 [N] 공유하는지(샘플): [N] 중복 등장은 정상
    console.log(`Q: ${q.slice(0, 36)}... | 블록 ${(md.match(/^##\s/gm) || []).length}개 | 출처 [N] ${numbered.mapping.size}개`);
    console.log(`  (id)누출 ${idLeaks.length}건 ${idLeaks.length === 0 ? '✅' : '🔴 ' + idLeaks.slice(0, 3).join(',')} | [N] 범위초과 ${overflow.length}건 ${overflow.length === 0 ? '✅' : '🔴'}`);
  }
}
citationCheck().catch(e => { console.error(e); process.exit(1); });
