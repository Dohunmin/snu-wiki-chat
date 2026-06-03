/**
 * 보편 컨텍스트 예산 (rag 감사 rank1 + flat-pool A2).
 *
 * 모든 검색 경로(global/per-wiki/전역키워드/lens)가 합류하는 buildNumberedContexts 직전에 적용.
 *  - RERANK_ENABLED=true: **flat 풀** — 모든 블록(source 청크 + labeled 섹션)을 질문 대비 cross-encoder
 *    rerank → 관련도 1등부터 예산까지 채움. 거친 labeled 덩어리가 관련 source 청크를 새치기 못 함.
 *  - 아니면: confidence 순으로 블록 유지(동기 fallback).
 * 비용 꼬리($0.52)를 잘라 전 쿼리 ≤$0.15 보장(cost-sim 검증). 잘리는 건 *가장 덜 관련된* 블록.
 * citation 정합: kept 블록의 (id)가 본문에 남아있는 source만 통과 → buildNumberedContexts [N] 매핑 일치.
 */
import type { AgentContext } from './types';
import { rerankDocuments } from '@/lib/embed/voyage';

const SEP = '\n\n---\n\n';

/** kept 블록 텍스트에 (id)가 실제로 등장하는 source만 유지 → 미사용 [N] 매핑 방지. */
function filterSources(c: AgentContext, keptText: string): AgentContext['sources'] {
  const kept = c.sources.filter(s => keptText.includes(`(${s.page})`));
  return kept.length > 0 ? kept : c.sources;
}

export async function enforceContextBudget(
  query: string,
  contexts: AgentContext[],
  maxChars: number,
): Promise<AgentContext[]> {
  if (contexts.length === 0) return contexts;
  const total = contexts.reduce((s, c) => s + c.relevantData.length, 0);

  // ── flat 풀 (rerank-aware) — 기본 ON (예산이 가장 관련된 블록으로 채워지려면 필수). RERANK_ENABLED=false로 비활성. ──
  if (process.env.RERANK_ENABLED !== 'false') {
    type Blk = { ci: number; text: string };
    const blocks: Blk[] = [];
    contexts.forEach((c, ci) => c.relevantData.split(SEP).forEach(t => { if (t.trim()) blocks.push({ ci, text: t }); }));
    if (blocks.length === 0) return contexts;

    let order: number[];
    try {
      const rr = await rerankDocuments(query, blocks.map(b => b.text.slice(0, 4000)));
      order = rr.map(r => r.index);
    } catch {
      order = blocks.map((_, i) => i);   // rerank 실패 → 원순서 유지(graceful)
    }

    const keep = new Set<number>();
    let used = 0;
    for (const i of order) {
      if (keep.size > 0 && used + blocks[i].text.length > maxChars) break;  // 관련 상위부터, 예산 초과 시 중단
      keep.add(i);
      used += blocks[i].text.length;
    }

    const out: AgentContext[] = [];
    contexts.forEach((c, ci) => {
      const keptBlocks = blocks.filter((b, i) => b.ci === ci && keep.has(i)).map(b => b.text);
      if (keptBlocks.length === 0) return;                 // 이 위키 블록이 전부 탈락 → 컨텍스트 제외
      const relevantData = keptBlocks.join(SEP);
      out.push({ ...c, relevantData, sources: filterSources(c, relevantData) });
    });
    return out.length > 0 ? out : contexts.slice(0, 1);
  }

  // ── fallback: confidence 순 블록 유지(동기 로직) ──
  if (total <= maxChars) return contexts;
  const sorted = [...contexts].sort((a, b) => b.confidence - a.confidence);
  const out: AgentContext[] = [];
  let used = 0;
  for (const c of sorted) {
    if (used >= maxChars) break;
    const kept: string[] = [];
    for (const b of c.relevantData.split(SEP)) {
      if (kept.length > 0 && used + b.length + SEP.length > maxChars) break;
      kept.push(b);
      used += b.length + SEP.length;
    }
    if (kept.length > 0) {
      const relevantData = kept.join(SEP);
      out.push({ ...c, relevantData, sources: filterSources(c, relevantData) });
    }
  }
  return out.length > 0 ? out : contexts.slice(0, 1);
}
