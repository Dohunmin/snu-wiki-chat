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

    // ── 렌더: rerank 순서를 살림(관련도순) — context-spine v1 §3.2 ──
    //   kept 블록을 source-doc(회의록) 그룹화 → 그룹을 best-rerank순 → 그룹 내부는 원순서(회의록 시계열 보존).
    //   위키(컨텍스트)도 best-rerank순. 선택(keep)·예산·citation 매핑은 불변 — *순서만* 바뀜(내용 무손실).
    const rankOf = new Map<number, number>();
    order.forEach((blkIdx, rank) => rankOf.set(blkIdx, rank));
    const pageIdOf = (t: string): string | null =>
      t.match(/##\s+(?:\[[^\]]+\]\s+)?[^\n(]*?\(([^()\n]+)\)/)?.[1]?.trim() ?? null;
    const bestRank = (idxs: number[]) => Math.min(...idxs.map(i => rankOf.get(i) ?? Number.MAX_SAFE_INTEGER));

    const rendered: { ctx: AgentContext; rank: number }[] = [];
    contexts.forEach((c, ci) => {
      const mine = blocks
        .map((b, i) => ({ i, text: b.text, ci: b.ci }))
        .filter(b => b.ci === ci && keep.has(b.i));
      if (mine.length === 0) return;                       // 이 위키 블록이 전부 탈락 → 컨텍스트 제외

      // source-doc 그룹화(원순서 유지)
      const groups = new Map<string, typeof mine>();
      for (const b of mine) {
        const sid = pageIdOf(b.text) ?? `__row${b.i}`;     // 헤더 없는 블록은 단독 그룹
        if (!groups.has(sid)) groups.set(sid, []);
        groups.get(sid)!.push(b);
      }
      // 그룹을 best-rerank순 정렬, 그룹 내부는 원순서
      const orderedGroups = [...groups.values()].sort((a, b) => bestRank(a.map(x => x.i)) - bestRank(b.map(x => x.i)));
      const relevantData = orderedGroups.flatMap(g => g.map(x => x.text)).join(SEP);
      rendered.push({ ctx: { ...c, relevantData, sources: filterSources(c, relevantData) }, rank: bestRank(mine.map(x => x.i)) });
    });

    // 위키도 best-rerank순(관련 위키가 컨텍스트 상단 — cross-wiki lost-in-middle 완화)
    rendered.sort((a, b) => a.rank - b.rank);
    const out = rendered.map(r => r.ctx);
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
