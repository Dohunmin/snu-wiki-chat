/**
 * 복잡도 신호 분리 검증 — 실제 61질문에서 후보 신호들이 simple/complex를 *실제로 가르나*.
 * 안 갈리면(다 비슷하면) 라우팅 무의미 → Haiku 판정 or 단일예산. countTokens 무료 + rerank 소액.
 *   npx tsx --env-file=.env.local scripts/complexity-signal.ts
 */
import fs from 'fs';
import { routeQuery } from '@/lib/agents/router';
import { enforceContextBudget } from '@/lib/agents/context-budget';
import { rerankDocuments } from '@/lib/embed/voyage';
import type { Role } from '@/lib/auth/roles';

process.env.RERANK_ENABLED = 'true';
const ROLE: Role = 'admin';
const SPEC = /가능할까|가능한가|방안|한다면|어떨까|정리해|생각해|왜 |비교|어떻게 생각/;
const all = JSON.parse(fs.readFileSync('scripts/gold-questions.json', 'utf-8')).filter((q: any) => !(q.mode || '').startsWith('lens:'));

async function main() {
  const rows: { len: number; wikis: number; spec: boolean; topRr: number; ctxChars: number }[] = [];
  for (let i = 0; i < all.length; i++) {
    const q = all[i].question;
    const r = await routeQuery(q, ROLE);
    const ctxs = await enforceContextBudget(q, r.contexts, 999999);  // 예산 무한 = 전체 자료량 측정
    const ctxChars = ctxs.reduce((s, c) => s + c.relevantData.length, 0);
    // top rerank 점수: 컨텍스트 블록들을 질문 대비 rerank → 최고 관련도(=직접 답 존재 여부)
    const blocks = ctxs.flatMap(c => c.relevantData.split('\n\n---\n\n')).filter(Boolean).slice(0, 60);
    let topRr = 0;
    try { const rr = await rerankDocuments(q, blocks.map(b => b.slice(0, 2000))); topRr = rr[0]?.relevanceScore ?? 0; } catch { /* skip */ }
    rows.push({ len: q.length, wikis: r.selectedAgentIds.length, spec: SPEC.test(q), topRr, ctxChars });
    process.stdout.write(`\r  ${i + 1}/${all.length}`);
  }
  console.log('');
  const nums = (k: 'len' | 'wikis' | 'topRr' | 'ctxChars') => rows.map(r => r[k] as number).sort((a, b) => a - b);
  const q = (a: number[], p: number) => a[Math.floor(a.length * p)];
  const dist = (k: 'len' | 'wikis' | 'topRr' | 'ctxChars') => { const a = nums(k); return `min ${a[0].toFixed(2)} | p25 ${q(a, .25).toFixed(2)} | median ${q(a, .5).toFixed(2)} | p75 ${q(a, .75).toFixed(2)} | max ${a[a.length - 1].toFixed(2)}`; };
  console.log('\n신호별 분포 (가르는 힘이 있나?):');
  console.log('  길이      :', dist('len'));
  console.log('  위키수    :', dist('wikis'), ' ← 다 비슷하면 무용');
  console.log('  top_rerank:', dist('topRr'), ' ← 높음=직접답(factoid), 낮음=종합');
  console.log('  컨텍스트량:', dist('ctxChars'));
  const sp = rows.filter(r => r.spec).length;
  console.log(`  사변마커  : ${sp}/${rows.length} (${Math.round(sp / rows.length * 100)}%)`);
  // 상관: top_rerank가 낮은(종합) 질문이 정말 사변마커/장문인가
  const lowRr = rows.filter(r => r.topRr < q(nums('topRr'), .33));
  console.log(`\ntop_rerank 하위33%(=종합후보) ${lowRr.length}개 중: 사변마커 ${lowRr.filter(r => r.spec).length} | 평균길이 ${Math.round(lowRr.reduce((s, r) => s + r.len, 0) / lowRr.length)}자`);
  const hiRr = rows.filter(r => r.topRr >= q(nums('topRr'), .67));
  console.log(`top_rerank 상위33%(=factoid후보) ${hiRr.length}개 중: 사변마커 ${hiRr.filter(r => r.spec).length} | 평균길이 ${Math.round(hiRr.reduce((s, r) => s + r.len, 0) / hiRr.length)}자`);
}
main().catch(e => { console.error(e); process.exit(1); });
