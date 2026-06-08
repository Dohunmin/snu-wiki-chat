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
import agentsConfig from '@/data/agents.config.json';

export interface CitationRef {
  wiki: string;       // 위키 display name (e.g., "평의원회")
  page: string;       // source ID (e.g., "19기-7차")
  topic?: string;     // 또는 type (stance/fact/overview)
  title?: string;     // source의 실제 title (LLM이 [N]을 정확히 식별하기 위함)
}

/**
 * 컨텍스트들의 unique source에 번호 부여하고, 컨텍스트 본문 헤더에 [N] 마킹.
 *
 * @returns
 *   - contextMarkdown: LLM에게 줄 본문 (각 source 헤더에 [N] 마커 포함)
 *   - mapping: N → CitationRef 매핑
 *   - summary: "[1] [평의원회] 19기-7차" 같은 매핑 요약 (LLM 빠른 참조용)
 */
export function buildNumberedContexts(contexts: AgentContext[], opts: { showSourceId?: boolean } = {}): {
  contextMarkdown: string;
  mapping: Map<number, CitationRef>;
  summary: string;
} {
  // showSourceId=true면 본문 헤더에 회차/문서ID를 식별용으로 남김(오인용 예방 — 강화 A).
  //   LLM이 '쓰는 시점'에 어느 회의/문서인지 보고 올바른 [N]을 고르도록. 인용은 여전히 [N].
  const { showSourceId = false } = opts;
  const mapping = new Map<number, CitationRef>();
  const numberByKey = new Map<string, number>();
  let nextNum = 1;

  // 1a) 헤더에서 title 사전 추출 (sid 제거되기 전에)
  //     "## [type]? title (sid) | ..." 패턴에서 title 캡쳐
  const titleByKey = new Map<string, string>();
  // id는 헤더의 "title (id) | meta" 구조에서 ' | ' 또는 줄끝 직전의 (...)에 위치.
  // 비탐욕 title + 경계(\| 또는 줄끝) 단언으로, 제목/메타에 괄호가 있어도 진짜 id만 캡쳐.
  const titleExtractPattern = /^##\s+(?:\[(?:source|fact|stance|overview|entity)\]\s+)?(.*?)\(([^()\n]+)\)(?:\s*\||\s*$)/gm;
  for (const ctx of contexts) {
    for (const m of ctx.relevantData.matchAll(titleExtractPattern)) {
      const title = m[1].trim();
      const sid = m[2].trim();
      const key = `${ctx.agentName}|${sid}`;
      if (title && !titleByKey.has(key)) titleByKey.set(key, title);
    }
  }

  // 1b) unique source 식별 + 번호 부여 (title 포함)
  for (const ctx of contexts) {
    for (const src of ctx.sources) {
      const key = `${src.wiki}|${src.page}`;
      if (!numberByKey.has(key)) {
        numberByKey.set(key, nextNum);
        mapping.set(nextNum, {
          wiki: src.wiki,
          page: src.page,
          topic: src.topic,
          title: titleByKey.get(key),
        });
        nextNum++;
      }
    }
  }

  // 2) 각 컨텍스트 본문의 source 헤더에 [N] 주입 + sid 제거
  //    LLM이 source ID 자체를 못 보게 하여 답변에 [N] 만 사용하도록 강제.
  //    헤더 패턴: "## ... (sourceId) | ..." 또는 "## [type] ... (sourceId) | ..."
  // H-5 수정: id를 ' | meta'(또는 줄끝) 직전의 마지막 (...)에 앵커링.
  // 기존 `([^(\n]*?)\(([^)]+)\)`는 첫 괄호를 id로 캡쳐 → 제목에 괄호가 있으면(약 8.7%) id 매핑 실패 + sid 노출.
  const headerPattern = /^(##\s+)(\[(?:source|fact|stance|overview|entity)\]\s+)?(.*?)\(([^()\n]+)\)(\s*\|[^\n]*|\s*)$/gm;

  const contextBlocks = contexts.map(ctx => {
    const numbered = ctx.relevantData.replace(
      headerPattern,
      (_full, hashPrefix, typeTag, title, sourceId, rest) => {
        const key = `${ctx.agentName}|${sourceId.trim()}`;
        const n = numberByKey.get(key);
        const tagPart = typeTag ?? '';
        if (!n) {
          // entity 등 매칭 안 되는 케이스 — 인용 대상 아니므로 sid도 보이지 않게 제거
          return `${hashPrefix}${tagPart}${title.trim()}${rest}`;
        }
        // [N] 주입. showSourceId면 식별용으로 sid(회차) 유지(예방), 아니면 제거(현행)
        const idPart = showSourceId && !/\.(stance|fact|overview)$/.test(sourceId.trim()) ? ` (${sourceId.trim()})` : '';
        return `${hashPrefix}${tagPart}[${n}] ${title.trim()}${idPart}${rest}`;
      },
    );
    return `### ${ctx.agentName} 관련 자료\n\n${numbered}`;
  });

  // 3) LLM이 빠르게 참조할 수 있는 매핑 요약 — sid 노출 안 함
  //    title 포함하여 LLM이 [N]을 정확히 식별. wrong-attribution 방지.
  //    예: "[3] 대학운영계획: 실행과제 10 — 지식공유와 정책대안 — 2026년"
  const summary = Array.from(mapping.entries())
    .map(([n, ref]) => {
      const titlePart = ref.title ? `: ${ref.title}` : '';
      // 회차/문서ID를 식별자로 노출 — 같은 위키의 여러 회의록을 LLM이 구분해 올바른 [N] 인용하도록.
      //   (인용은 여전히 [N]으로만 — 본문은 sid 숨김 유지. 여기 page는 식별용 라벨)
      const idPart = ref.page && !/\.(stance|fact|overview)$/.test(ref.page) ? ` (${ref.page})` : '';
      const topicPart = ref.topic ? ` — ${ref.topic}` : '';
      return `[${n}] ${ref.wiki}${titlePart}${idPart}${topicPart}`;
    })
    .join('\n');

  return {
    contextMarkdown: contextBlocks.join('\n\n---\n\n'),
    mapping,
    summary,
  };
}

// 위키명 → agent ID 매핑. agents.config에서 동적 구성 → 거버넌스 9 + 단과대/대학원 전부 커버.
//   (기존 하드코딩은 거버넌스만 → 단과대/대학원 인용이 agentId 못 찾아 raw `[인문대학] vision`으로 노출되던 버그.)
const WIKI_TO_AGENT: Record<string, string> = {
  ...Object.fromEntries(
    (agentsConfig.agents as { id: string; name: string }[]).map(a => [a.name, a.id]),
  ),
  '중장기': 'vision',   // 별칭 보존
};

function buildFriendlyLabel(ref: CitationRef): string {
  // title 우선, topic 보조, page basename fallback (suffix 제거)
  if (ref.title) return ref.title;
  if (ref.topic) return ref.topic;
  return ref.page.split('.')[0];
}

/**
 * 텍스트 내 [N] 패턴을 매핑으로 resolve.
 *
 * - source 페이지: `[위키명] sourceId` 형식 (UI linkifyCitations 정규식이 처리)
 * - stance/fact/overview: 친화적 markdown link `[위키명 친화이름](url)` 형식
 *   → 내부 ID (`.stance` `.fact` `.overview`) 노출 없이 사용자에게 의미 있는 텍스트로 표시
 *   → URL은 sid 사용 — wiki browser 클릭 동작 유지
 *
 * 매핑에 없는 [N]은 그대로 둠 (LLM 잘못 출력 케이스).
 * 인접 인용 [N][M] 또는 sid[wiki]는 후처리로 공백 삽입.
 */
export function resolveText(text: string, mapping: Map<number, CitationRef>): string {
  // 1단계: 인접 [N][M] → [N] [M] (raw 단계 분리)
  const spaced = text.replace(/\]\[/g, '] [');
  // 2단계: [N] resolve
  const resolved = spaced.replace(/\[(\d+)\]/g, (match, numStr) => {
    const n = parseInt(numStr, 10);
    const ref = mapping.get(n);
    if (!ref) return match;

    // 친화 처리 대상: stance / fact / overview.
    //   type 결정 — page suffix(.stance/.fact/.overview = 거버넌스) 우선, 없으면 topic(단과대/대학원의 c.type).
    const suffixMatch = ref.page.match(/\.(stance|fact|overview)$/);
    const typeKey = suffixMatch?.[1]
      ?? (ref.topic === 'overview' || ref.topic === 'fact' || ref.topic === 'stance' ? ref.topic : null);
    if (typeKey) {
      const typeMap = { stance: 'stances', fact: 'facts', overview: 'overviews' } as const;
      const type = typeMap[typeKey as 'stance' | 'fact' | 'overview'];
      const agentId = WIKI_TO_AGENT[ref.wiki];
      const friendly = buildFriendlyLabel(ref);
      if (!agentId) return `[${ref.wiki}] ${friendly}`;   // 링크 못 만들어도 raw slug 대신 친화이름 노출
      const url = `/wiki?agent=${agentId}&type=${type}&id=${encodeURIComponent(ref.page)}`;
      const linkText = friendly.startsWith(ref.wiki) ? friendly : `${ref.wiki} ${friendly}`;
      return `[${linkText}](${url})`;
    }
    // source는 기존 형식 — UI linkifyCitations가 처리
    return `[${ref.wiki}] ${ref.page}`;
  });
  // 3단계: 인접 `sid[wiki]` → `sid [wiki]` (markdown 링크 패턴 영향 X)
  return resolved.replace(/(\S)(\[[가-힣][가-힣\w\-]*\]\s+\S)/g, '$1 $2');
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
 * LLM이 P2 규칙 무시하고 [위키명] sid 옛 형식 직접 출력했는지 검출.
 * raw response (resolve 전) 에서 [한글위키명] 패턴 찾음. [숫자] 는 제외.
 *
 * @returns 검출된 옛 형식 인용들 — 발견 시 LLM에게 retry 요청해야 함
 */
export function detectOldFormatCitations(rawResponse: string): Array<{ wiki: string; sid: string; raw: string }> {
  const out: Array<{ wiki: string; sid: string; raw: string }> = [];
  // [한글위키명] 뒤에 공백 + ID 패턴 — [N] 숫자는 제외
  const pattern = /\[([가-힣][가-힣\w\-]*)\]\s+([\w가-힣·\-]+(?:\.(?:fact|stance|overview))?)/g;
  for (const m of rawResponse.matchAll(pattern)) {
    out.push({ wiki: m[1], sid: m[2], raw: m[0] });
  }
  return out;
}

/**
 * 옛 형식 사용 감지 시 LLM에게 줄 retry 프롬프트.
 * "[N] 만 써라" 명시 + 매핑 다시 안내.
 */
export function buildOldFormatRetryPrompt(
  oldFormats: Array<{ wiki: string; sid: string }>,
  citationSummary: string,
): string {
  const examples = oldFormats.slice(0, 5).map((f, i) => `${i + 1}. \`[${f.wiki}] ${f.sid}\``).join('\n');

  return `이전 답변에 ${oldFormats.length}개의 잘못된 인용 형식이 사용되었습니다.

검출된 잘못된 형식:
${examples}

이런 \`[위키명] 문서ID\` 형식은 **시스템이 거부**합니다. 오직 \`[N]\` 번호 형식만 허용됩니다.

답변을 처음부터 다시 작성해주세요:
- 모든 인용을 \`[N]\` 번호 형식으로만 표기
- 위키명·문서ID를 인용 표기에 사용 금지
- 본문 서술에서 자연스러운 위키명 언급은 OK (예: "평의원회는 ~을 의결 [3]")
- 번호 매핑은 다음과 같습니다:

${citationSummary}

답변 내용·구조는 유지하되, 모든 출처 인용을 \`[N]\` 으로만 표기하세요.`;
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
