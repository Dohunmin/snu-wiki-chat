/**
 * Citation Numbering — Perplexity 방식 number-based 인용.
 *
 * 문제: LLM이 긴 source ID (`2026-운영계획-실행과제1`)를 정확히 출력 어렵고,
 *       비슷한 ID 사이에서 wrong-attribution 자주 발생 (e.g., CMU 사실을 다른 source로 인용).
 *
 * 해결: 컨텍스트의 각 unique source에 번호 [1], [2], ... 부여.
 *       LLM은 [N] 짧은 마커로만 인용. 서버에서 [N] → `[위키명] sid`로 resolve.
 *
 * 효과:
 *   - LLM 출력 단순화 — wrong-attribution 차단
 *   - DB·UI는 기존 `[wiki] sid` 포맷 그대로 (backward compat)
 *   - sources 필드 = LLM이 실제 인용한 것만 (전체 retrieved set 아님)
 */

import type { AgentContext } from '@/lib/agents/types';

export interface CitationRef {
  wiki: string;       // 위키 display name (e.g., "평의원회")
  page: string;       // source ID (e.g., "19기-7차")
  topic?: string;     // 또는 type (stance/fact/overview)
}

/**
 * 컨텍스트들의 unique source에 번호 부여하고, 컨텍스트 본문 헤더에 [N] 마킹.
 *
 * @returns
 *   - contextMarkdown: LLM에게 줄 본문 (각 source 헤더에 [N] 마커 포함)
 *   - mapping: N → CitationRef 매핑
 *   - summary: "[1] [평의원회] 19기-7차" 같은 매핑 요약 (LLM 빠른 참조용)
 */
export function buildNumberedContexts(contexts: AgentContext[]): {
  contextMarkdown: string;
  mapping: Map<number, CitationRef>;
  summary: string;
} {
  const mapping = new Map<number, CitationRef>();
  const numberByKey = new Map<string, number>();
  let nextNum = 1;

  // 1) unique source 식별 + 번호 부여
  for (const ctx of contexts) {
    for (const src of ctx.sources) {
      const key = `${src.wiki}|${src.page}`;
      if (!numberByKey.has(key)) {
        numberByKey.set(key, nextNum);
        mapping.set(nextNum, {
          wiki: src.wiki,
          page: src.page,
          topic: src.topic,
        });
        nextNum++;
      }
    }
  }

  // 2) 각 컨텍스트 본문의 source 헤더에 [N] 주입
  //    헤더 패턴: "## ... (sourceId) | ..." 또는 "## [type] ... (sourceId) | ..."
  const headerPattern = /^(##\s+)(\[(?:source|fact|stance|overview|entity)\]\s+)?([^(\n]*?)\(([^)]+)\)([^\n]*)$/gm;

  const contextBlocks = contexts.map(ctx => {
    const numbered = ctx.relevantData.replace(
      headerPattern,
      (_full, hashPrefix, typeTag, title, sourceId, rest) => {
        const key = `${ctx.agentName}|${sourceId.trim()}`;
        const n = numberByKey.get(key);
        const tagPart = typeTag ?? '';
        if (!n) {
          // entity나 매칭 안 되는 케이스 — 그대로
          return `${hashPrefix}${tagPart}${title}(${sourceId})${rest}`;
        }
        return `${hashPrefix}${tagPart}[${n}] ${title}(${sourceId})${rest}`;
      },
    );
    return `### [${ctx.agentName}] 관련 자료\n\n${numbered}`;
  });

  // 3) LLM이 빠르게 참조할 수 있는 매핑 요약
  const summary = Array.from(mapping.entries())
    .map(([n, ref]) => `[${n}] [${ref.wiki}] ${ref.page}`)
    .join('\n');

  return {
    contextMarkdown: contextBlocks.join('\n\n---\n\n'),
    mapping,
    summary,
  };
}

/**
 * 텍스트 내 [N] 패턴을 매핑으로 resolve하여 `[위키명] sourceId` 형식으로 치환.
 * 매핑에 없는 [N]은 그대로 둠 (LLM이 잘못 출력한 경우).
 */
export function resolveText(text: string, mapping: Map<number, CitationRef>): string {
  return text.replace(/\[(\d+)\]/g, (match, numStr) => {
    const n = parseInt(numStr, 10);
    const ref = mapping.get(n);
    if (!ref) return match;
    return `[${ref.wiki}] ${ref.page}`;
  });
}

/**
 * 텍스트에서 [N] 인용 번호들을 추출 (중복 제거).
 */
export function extractCitedNumbers(text: string): Set<number> {
  const nums = new Set<number>();
  for (const m of text.matchAll(/\[(\d+)\]/g)) {
    nums.add(parseInt(m[1], 10));
  }
  return nums;
}

/**
 * 인용된 번호들을 CitationRef 배열로 resolve. 매핑에 없으면 skip.
 */
export function resolveCitations(
  numbers: Set<number>,
  mapping: Map<number, CitationRef>,
): CitationRef[] {
  const out: CitationRef[] = [];
  for (const n of numbers) {
    const ref = mapping.get(n);
    if (ref) out.push(ref);
  }
  return out;
}

/**
 * 스트리밍 중 buffer에서 안전한 flush point 결정.
 *
 * 안전 = "[N]" 패턴이 도중에 끊기지 않은 위치.
 *   - 마지막 `[` 가 없으면 → 전체 flush 가능
 *   - 마지막 `[N]` 완성되어 있으면 → 전체 flush 가능
 *   - 마지막 `[` 가 미완성 (`[`, `[3`, `[12` 등) → 그 위치까지만 flush, 나머지 hold
 */
export function safeFlushPoint(buffer: string): number {
  const lastOpen = buffer.lastIndexOf('[');
  if (lastOpen === -1) return buffer.length;

  const remaining = buffer.slice(lastOpen);
  if (/^\[\d+\]/.test(remaining)) return buffer.length;  // 완성됨
  return lastOpen;  // 미완성 — hold from here
}
