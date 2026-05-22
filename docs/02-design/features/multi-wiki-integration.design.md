# Design: Multi-Wiki Integration

> **Feature**: multi-wiki-integration
> **Date**: 2026-05-06
> **Phase**: Design
> **Selected Architecture**: **Option C — Pragmatic Balance**
> **Plan Reference**: [../../01-plan/features/multi-wiki-integration.plan.md](../../01-plan/features/multi-wiki-integration.plan.md)

---

## Context Anchor

| 항목 | 내용 |
|---|---|
| **WHY** | 위키 수가 2배(4→8)로 늘어나는 시점은 시스템 한계가 드러나는 순간. 라우팅·검색·프롬프트를 함께 조정하지 않으면 토큰이 2~3배로 폭증하거나, 좁힌다고 좁히다 핵심 정보를 놓침 |
| **WHO** | 총장 후보자 + 관리자. 단일 위키 RAG → 8개 위키 종합 + 후보 비교 + 시뮬레이션 사용자로 확장 |
| **RISK** | (R1) 청크 cap 분배 시 단일 위키 깊이 약화, (R2) 라우터 좁힘 과도 시 cross-wiki 누락, (R4) fact 표 분할 깨짐 |
| **SUCCESS** | 8 위키 ingest + 토큰 ≤ 10K + 회귀 없음 + cross-wiki 비교 표 자동 응답 |
| **SCOPE** | `build-wiki-data.ts`, `types.ts`, `wiki-agent.ts`, `router.ts`, `prompts.ts`, `agents.config.json` |

---

## 1. Overview

### 1.1 선택된 아키텍처: Option C (Pragmatic Balance)

| 요소 | 결정 |
|---|---|
| 새 페이지 타입 처리 | 단일 `WikiAgent` 내 `if-else` 분기 (Plugin 분리 X) |
| Concept Index | 단일 JSON 파일 (`data/concept-index.json`), 별도 모듈 X |
| Router | 기존 `router.ts` 단일 파일 내 함수 분할 |
| 신규 파일 | 0 (data 자동 생성 제외) |

### 1.2 채택 이유

1. Plan §4의 변경 파일 목록과 정확히 일치 — 재계획 불필요
2. 회귀 위험 낮음 — 변경 위치가 6개 파일로 명확
3. 작업 시간 3~5h로 적정
4. 미래 필요 시 Option B(Plugin per Type)로 점진적 진화 가능

### 1.3 변경 범위 요약

```
6 파일 수정 + 0 신규 + 5 자동 생성

수정:
  lib/agents/types.ts             ←  타입 정의
  lib/agents/wiki-agent.ts        ←  검색·청크
  lib/agents/router.ts            ←  적응형 라우팅
  lib/llm/prompts.ts              ←  비교 가이드
  scripts/build-wiki-data.ts      ←  파서·인덱스
  data/agents.config.json         ←  4 에이전트 등록

자동 생성:
  data/history.json
  data/status.json
  data/yhl-speeches.json
  data/finance.json
  data/concept-index.json
```

---

## 2. System Architecture

### 2.1 데이터 흐름

```
[user query]
  ↓
[Router (router.ts)]
  ├ Tier 0: 글로벌 키워드 (기존)
  ├ Stage 1: prefilterScore() — 8개 위키 metadata 점수
  ├ Concept Index lookup → forced wikis
  ├ 적응형 선택 (absolute + relative + score gap)
  └ alwaysContext 위키 추가 (status 등)
  ↓ selected agents (1~6)
  ↓ chunkCap 분배 (정상 위키 / alwaysContext 위키 별도)
[각 WikiAgent.getContext() (wiki-agent.ts)]
  ├ allowedSources 필터 (sensitive)
  ├ guaranteedIds 계산 (entity/topic + concept-index 매칭)
  ├ 페이지 타입별 처리:
  │    ├ source: 청크 분할 + 점수 + 통째 헤더
  │    ├ topic/entity: 통째
  │    ├ stance: 통째 + [stance] 라벨
  │    ├ fact: 통째 + [fact] 라벨 (표 보존)
  │    └ overview: 통째 + [overview] 라벨
  └ 청크 cap만큼 자르기
  ↓ AgentContext (relevantData + sources + confidence)
[Prompts (prompts.ts)]
  ├ system prompt: 기본 P1~P5 + 비교 가이드 상시
  └ user message: 라벨링된 컨텍스트 블록
  ↓
[Claude API] streaming
```

### 2.2 핵심 변경 vs 기존

| 컴포넌트 | 기존 | 신규 (Option C) |
|---|---|---|
| Router | Tier 1/2/Last-resort | Stage 1 prefilter + 적응형 선택 + concept-index + alwaysContext |
| WikiAgent | sources/topics/entities/syntheses | + facts/stances/overviews 처리 + 출력 라벨링 |
| Build | sources/topics/entities/syntheses 4종 | + facts/stances/overviews 3종 + concept-index.json |
| Types | WikiSource/Topic/Entity/Synthesis | + WikiFact/Stance/Overview/ConceptIndex |
| Prompt | 5원칙 P1~P5 | + 비교 가이드 상시 + 페이지 타입 라벨 활용 가이드 |
| Config | id, name, type, ... | + alwaysContext 플래그 |

---

## 3. Data Model (lib/agents/types.ts)

### 3.1 새 인터페이스

```typescript
// 페이지 타입 — discriminated union 가능 (추후 Option B 진화 시)
export type PageType = 'source' | 'topic' | 'entity' | 'synthesis'
                     | 'fact' | 'stance' | 'overview';

export interface WikiFact {
  id: string;
  title: string;
  category: string;            // "자산", "비전", "통계" 등
  sources: string[];           // 본문 인용 source ID 또는 외부 URL
  unit?: string;               // "억원" (재무 전용)
  yearsCovered?: string;       // "2017~2024"
  metricScope?: string;        // "법인" | "종합" | "산학협력단" 등
  verifiedAt?: string;
  tags: string[];
  content: string;
  sensitive: boolean;
}

export interface WikiStance {
  id: string;
  title: string;
  holder: string;              // "유홍림" — 1급 분류 키
  topic: string;               // "AI시대대학역할" — §T slug
  sources: string[];           // 발언 등장 source ID
  tags: string[];
  content: string;             // ## 핵심 입장 + ## 근거 발언 + ## 맥락
  sensitive: boolean;
}

export interface WikiOverview {
  id: string;
  title: string;
  편: string;                  // "통사편", "운영편" 등
  시기?: [number, number];     // [1946, 2016]
  관련_stance?: Record<string, string[]>;  // { 유홍림: [...], 이석재: [...] }
  tags: string[];
  content: string;
  sensitive: boolean;
}
```

### 3.2 WikiData 확장

```typescript
export interface WikiData {
  id: string;
  name: string;
  sources: WikiSource[];
  topics: WikiTopic[];
  entities: WikiEntity[];
  syntheses: WikiSynthesis[];
  // 신규 (위키별로 비어있을 수 있음)
  facts: WikiFact[];
  stances: WikiStance[];
  overviews: WikiOverview[];
  index: string;
}
```

기존 위키들(senate/board/plan/vision)은 `facts`, `stances`, `overviews` = `[]`. 후방 호환.

### 3.3 AgentConfig 확장

```typescript
export interface AgentConfig {
  id: string;
  name: string;
  type: AgentType;
  dataFile: string;
  enabled: boolean;
  keywords: string[];
  sensitiveTopics: string[];
  description: string;
  // 신규
  alwaysContext?: boolean;     // true = Stage 1 절대 threshold 무시, 항상 포함 (cap 5)
}
```

### 3.4 ConceptIndex (신규)

```typescript
export interface ConceptEntry {
  wikis: string[];                                // ["board", "yhl-speeches"]
  aliases: string[];                              // ["총장", "유 총장"]
  linkedPages: {
    wiki: string;                                 // "board"
    type: 'entity' | 'topic' | 'stance' | 'source' | 'fact' | 'overview';
    id: string;                                   // "유홍림" | "취임사-2023"
  }[];
}

export interface ConceptIndex {
  [conceptName: string]: ConceptEntry;
}
```

저장 위치: `data/concept-index.json`. 라우터·WikiAgent에서 import.

---

## 4. Build Pipeline (scripts/build-wiki-data.ts)

### 4.1 WIKI_MAP 확장

```typescript
const WIKI_MAP = [
  // 기존 4개 (유지)
  { id: 'senate',  name: '평의원회',  folder: 'SNU_Senate_LLM_Wiki',
    sensitiveTopics: ['총장추천위', '인사-비공개'] },
  { id: 'board',   name: '이사회',    folder: 'SNU_이사회_LLM_Wiki',
    sensitiveTopics: ['총장-선출', '이사-선임', '감사-선임'] },
  { id: 'plan',    name: '대학운영계획', folder: 'SNU_대학운영계획_LLM_Wiki',
    sensitiveTopics: [] },
  { id: 'vision',  name: '중장기발전계획', folder: 'SNU_중장기발전계획_LLM_Wiki',
    sensitiveTopics: [] },
  // 신규 4개
  { id: 'history', name: '70년역사',
    folder: 'SNU_70년역사_LLM_Wiki', sensitiveTopics: [] },
  { id: 'status',  name: '대학현황',
    folder: 'SNU_대학현황_LLM_Wiki', sensitiveTopics: [] },
  { id: 'yhl-speeches', name: '유홍림총장연설',
    folder: 'SNU_유홍림총장연설_LLM_Wiki', sensitiveTopics: [] },
  { id: 'finance', name: '재무정보공시',
    folder: 'SNU_재무정보공시_LLM_Wiki', sensitiveTopics: [] },
];
```

### 4.2 신규 디렉토리 파서

기존 `collectMdFiles()` 재사용. `buildWikiData()`에 3개 블록 추가:

```typescript
// ─── Facts ──────────────────────────────────────────────
const factsDir = path.join(wikiPath, 'wiki', 'facts');
const facts: WikiFact[] = [];
for (const { id, content } of collectMdFiles(factsDir)) {
  const { meta, body } = parseFrontmatter(content);
  if (meta.type !== 'fact') continue;

  facts.push({
    id,
    title: extractTitle(body, id),
    category: (meta.category as string) ?? '',
    sources: (meta.sources as string[]) ?? [],
    unit: meta.unit as string | undefined,
    yearsCovered: meta.years_covered as string | undefined,
    metricScope: meta.metric_scope as string | undefined,
    verifiedAt: meta.verified_at as string | undefined,
    tags: (meta.tags as string[]) ?? [],
    content: body,
    sensitive: false,
  });
}

// ─── Stances ────────────────────────────────────────────
const stancesDir = path.join(wikiPath, 'wiki', 'stances');
const stances: WikiStance[] = [];
for (const { id, content } of collectMdFiles(stancesDir)) {
  const { meta, body } = parseFrontmatter(content);
  if (meta.type !== 'stance') continue;

  stances.push({
    id,
    title: extractTitle(body, id),
    holder: (meta.holder as string) ?? '',
    topic: (meta.topic as string) ?? '',
    sources: (meta.sources as string[]) ?? [],
    tags: (meta.tags as string[]) ?? [],
    content: body,
    sensitive: false,
  });
}

// ─── Overviews ──────────────────────────────────────────
const overviewsDir = path.join(wikiPath, 'wiki', 'overviews');
const overviews: WikiOverview[] = [];
for (const { id, content } of collectMdFiles(overviewsDir)) {
  const { meta, body } = parseFrontmatter(content);
  if (meta.type !== 'overview') continue;

  overviews.push({
    id,
    title: extractTitle(body, id),
    편: (meta['편'] as string) ?? '',
    시기: meta['시기'] as [number, number] | undefined,
    관련_stance: meta['관련_stance'] as Record<string, string[]> | undefined,
    tags: (meta.tags as string[]) ?? [],
    content: body,
    sensitive: false,
  });
}
```

### 4.3 Concept Index 생성

`buildWikiData()` 모두 끝난 후 새 함수:

```typescript
function buildConceptIndex(allWikis: WikiData[]): ConceptIndex {
  const index: ConceptIndex = {};

  const add = (
    name: string,
    wikiId: string,
    pageType: ConceptEntry['linkedPages'][0]['type'],
    pageId: string,
    aliases: string[] = [],
  ) => {
    if (!name || name.length < 2) return;
    if (!index[name]) {
      index[name] = { wikis: [], aliases: [], linkedPages: [] };
    }
    if (!index[name].wikis.includes(wikiId)) index[name].wikis.push(wikiId);
    for (const a of aliases) {
      if (!index[name].aliases.includes(a)) index[name].aliases.push(a);
    }
    index[name].linkedPages.push({ wiki: wikiId, type: pageType, id: pageId });
  };

  for (const wiki of allWikis) {
    // entities
    for (const e of wiki.entities) {
      add(e.name, wiki.id, 'entity', e.id, e.aliases);
      // entity's linked sources도 추가 (이미 sources 배열에 있음)
      for (const sid of e.sources) {
        add(e.name, wiki.id, 'source', sid);
      }
    }
    // topics
    for (const t of wiki.topics) {
      add(t.name, wiki.id, 'topic', t.id);
    }
    // stances
    for (const s of wiki.stances) {
      add(s.holder, wiki.id, 'stance', s.id);
      add(s.topic, wiki.id, 'stance', s.id);
    }
    // facts
    for (const f of wiki.facts) {
      if (f.category) add(f.category, wiki.id, 'fact', f.id);
    }
  }

  // 너무 비대해지지 않게: linkedPages가 1개뿐인 concept은 제외 (cross-wiki 가치 없음)
  // 단 wikis가 2개 이상이면 유지 (cross-wiki 매칭의 본질)
  return Object.fromEntries(
    Object.entries(index).filter(([_, v]) =>
      v.wikis.length >= 2 || v.linkedPages.length >= 3
    )
  );
}

// 메인 실행 마지막에:
const allWikis = WIKI_MAP.map(w => buildWikiData(w));
// ... 각 wiki JSON 저장 ...

const conceptIndex = buildConceptIndex(allWikis);
fs.writeFileSync(
  path.join(outputDir, 'concept-index.json'),
  JSON.stringify(conceptIndex, null, 2),
  'utf-8'
);
console.log(`✨ Concept Index: ${Object.keys(conceptIndex).length} concepts`);
```

### 4.4 updateAgentKeywords 확장

기존 함수에 stance/fact/overview metadata 추가:

```typescript
function updateAgentKeywords(agentId, data, configPath) {
  // ... 기존 로직 ...

  // stance: holder + topic
  for (const s of data.stances) {
    if (s.holder.length >= 2) keywordSet.add(s.holder);
    if (s.topic.length >= 2) keywordSet.add(s.topic);
  }
  // fact: category
  for (const f of data.facts) {
    if (f.category.length >= 2) keywordSet.add(f.category);
  }
  // overview: 편
  for (const o of data.overviews) {
    if (o.편.length >= 2) keywordSet.add(o.편);
  }

  agent.keywords = Array.from(keywordSet).slice(0, 150);
  // ...
}
```

---

## 5. Routing (lib/agents/router.ts)

### 5.1 상수

```typescript
const MIN_ABSOLUTE_SCORE = 3;
const RELATIVE_THRESHOLD = 0.4;
const MAX_WIKIS = 6;
const ALWAYS_CONTEXT_CAP = 5;
const TOTAL_CHUNK_BUDGET = 30;
```

### 5.2 prefilterScore() — Stage 1

```typescript
function prefilterScore(agent: AgentPlugin, queryWords: string[]): number {
  let score = 0;

  // (a) keywords 배열 매칭
  for (const kw of agent.config.keywords) {
    const kl = kw.toLowerCase();
    if (queryWords.some(w => kl.includes(w) || w.includes(kl))) {
      score += Math.min(kw.length / 2, 5);
    }
  }

  // (b) WikiAgent.preScore() 활용 — entities/topics 매칭
  if (agent instanceof WikiAgent && agent.preScore(queryWords.join(' '), 'admin')) {
    score += 5;
  }

  return score;
}
```

### 5.3 detectScoreGap() — 적응형 선택 보조

```typescript
function detectScoreGap(scores: number[]): number {
  if (scores.length <= 1) return scores.length;

  let maxGap = 0;
  let maxGapIdx = scores.length;

  for (let i = 0; i < scores.length - 1; i++) {
    const gap = scores[i] - scores[i + 1];
    if (gap > maxGap && scores[i + 1] < MIN_ABSOLUTE_SCORE * 2) {
      maxGap = gap;
      maxGapIdx = i;  // gap 직전까지 포함
    }
  }
  return maxGapIdx;
}
```

### 5.4 lookupConceptIndex()

```typescript
import conceptIndex from '@/data/concept-index.json';

function lookupConceptIndex(queryWords: string[]): {
  forcedWikis: Set<string>;
  guaranteedPages: Map<string, Set<string>>;  // wikiId → page IDs
} {
  const forcedWikis = new Set<string>();
  const guaranteedPages = new Map<string, Set<string>>();

  for (const [concept, entry] of Object.entries(conceptIndex)) {
    const cl = concept.toLowerCase();
    const matches = queryWords.some(w =>
      cl.includes(w) || w.includes(cl) ||
      entry.aliases.some(a => a.toLowerCase().includes(w) || w.includes(a.toLowerCase()))
    );
    if (matches) {
      for (const wiki of entry.wikis) forcedWikis.add(wiki);
      for (const page of entry.linkedPages) {
        if (!guaranteedPages.has(page.wiki)) {
          guaranteedPages.set(page.wiki, new Set());
        }
        guaranteedPages.get(page.wiki)!.add(page.id);
      }
    }
  }
  return { forcedWikis, guaranteedPages };
}
```

### 5.5 routeQuery() 변경

```typescript
export async function routeQuery(query: string, userRole: Role): Promise<RoutingResult> {
  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/[\s,]+/).filter(w => w.length >= 2);
  const globalKeywords: string[] = agentsConfig.routing.globalKeywords;
  const agents = registry.getAll();

  // === Tier 0: 글로벌 키워드 (기존 유지) ===
  const tier1Matches = agents.filter(agent =>
    agent.config.keywords.some(kw => queryLower.includes(kw.toLowerCase()))
  );
  const hasGlobalKeyword = globalKeywords.some(kw => queryLower.includes(kw));
  if (hasGlobalKeyword && tier1Matches.length === 0) {
    const contexts = await Promise.all(
      agents.map(a => a.getContext(query, userRole, true))
    );
    return { selectedAgentIds: contexts.map(c => c.agentId), contexts, isGlobal: true };
  }

  // === Stage 1: prefilter + concept-index ===
  const scored = agents.map(agent => ({
    agent,
    score: prefilterScore(agent, queryWords),
  }));
  scored.sort((a, b) => b.score - a.score);

  const { forcedWikis, guaranteedPages } = lookupConceptIndex(queryWords);
  const topScore = scored[0]?.score ?? 0;
  const relativeThreshold = topScore * RELATIVE_THRESHOLD;
  const gapCutoff = detectScoreGap(scored.map(s => s.score));

  // === 적응형 선택 ===
  const selected = scored.filter((s, i) => {
    if (forcedWikis.has(s.agent.config.id)) return true;
    if (s.agent.config.alwaysContext) return true;
    if (s.score < MIN_ABSOLUTE_SCORE) return false;
    if (s.score < relativeThreshold) return false;
    if (i > gapCutoff) return false;
    return true;
  }).slice(0, MAX_WIKIS);

  // === Stage 2: chunk cap 분배 ===
  const refCount = selected.filter(s => s.agent.config.alwaysContext).length;
  const normalCount = selected.length - refCount;
  const normalCap = normalCount > 0
    ? Math.max(
        Math.floor((TOTAL_CHUNK_BUDGET - refCount * ALWAYS_CONTEXT_CAP) / normalCount),
        5
      )
    : ALWAYS_CONTEXT_CAP;

  const contexts = await Promise.all(selected.map(s =>
    s.agent.getContext(query, userRole, false, {
      chunkCap: s.agent.config.alwaysContext ? ALWAYS_CONTEXT_CAP : normalCap,
      guaranteedPageIds: guaranteedPages.get(s.agent.config.id),
    })
  ));

  // confidence 필터 (기존 유지)
  const filteredContexts = contexts.filter(c => c.confidence > 0.3);
  const finalContexts = filteredContexts.length > 0 ? filteredContexts : contexts;

  return {
    selectedAgentIds: finalContexts.map(c => c.agentId),
    contexts: finalContexts,
    isGlobal: false,
  };
}
```

---

## 6. Retrieval (lib/agents/wiki-agent.ts)

### 6.1 getContext 시그니처 확장

```typescript
export interface GetContextOptions {
  chunkCap?: number;
  guaranteedPageIds?: Set<string>;  // concept-index에서 온 강제 포함 페이지
}

async getContext(
  query: string,
  userRole: Role,
  isGlobal = false,
  options: GetContextOptions = {},
): Promise<AgentContext> { ... }
```

### 6.2 페이지 타입 통합 처리

기존 `sources` 점수 계산 후, 새 페이지 타입 추가:

```typescript
// ─── 새 페이지 타입 점수 (sources와 같은 방식, 단 청크 분할 X) ───
const labeledPages: Array<{
  type: PageType;
  id: string;
  title: string;
  content: string;
  meta: string;          // 라벨용 부가 정보
  score: number;
  sensitive: boolean;
}> = [];

// stances
for (const s of data.stances) {
  if (!isSensitiveAllowed && s.sensitive) continue;
  let score = scoreText(s.content + ' ' + s.holder + ' ' + s.topic, queryWords);
  if (options.guaranteedPageIds?.has(s.id)) score += 5;
  // holder/topic 매칭 보너스
  if (queryWords.some(w => s.holder.toLowerCase().includes(w))) score += 3;
  if (queryWords.some(w => s.topic.toLowerCase().includes(w))) score += 3;
  if (score > 0) {
    labeledPages.push({
      type: 'stance', id: s.id, title: s.title, content: s.content,
      meta: `holder: ${s.holder} / topic: ${s.topic}`,
      score, sensitive: s.sensitive,
    });
  }
}

// facts
for (const f of data.facts) {
  if (!isSensitiveAllowed && f.sensitive) continue;
  let score = scoreText(f.content + ' ' + f.category, queryWords);
  if (options.guaranteedPageIds?.has(f.id)) score += 5;
  if (queryWords.some(w => f.category.toLowerCase().includes(w))) score += 3;
  if (score > 0) {
    labeledPages.push({
      type: 'fact', id: f.id, title: f.title, content: f.content,
      meta: `category: ${f.category}${f.yearsCovered ? ` / years: ${f.yearsCovered}` : ''}`,
      score, sensitive: f.sensitive,
    });
  }
}

// overviews
for (const o of data.overviews) {
  if (!isSensitiveAllowed && o.sensitive) continue;
  let score = scoreText(o.content + ' ' + o.편, queryWords);
  if (options.guaranteedPageIds?.has(o.id)) score += 5;
  if (queryWords.some(w => o.편.toLowerCase().includes(w))) score += 3;
  if (score > 0) {
    labeledPages.push({
      type: 'overview', id: o.id, title: o.title, content: o.content,
      meta: `편: ${o.편}${o.시기 ? ` / 시기: ${o.시기[0]}~${o.시기[1]}` : ''}`,
      score, sensitive: o.sensitive,
    });
  }
}
```

### 6.3 chunk cap 분배

기존 `chunksToUse` 선택 로직 변경:

```typescript
const chunkCap = options.chunkCap ?? (isGlobal ? allowedSources.length
  : guaranteedIds.size > 0 ? MAX_CHUNKS_ENTITY : MAX_CHUNKS);

// labeledPages는 통째로 출력 (분할 X), source 청크와 함께 점수 정렬
const allItems = [
  ...scoredChunks,         // source 청크
  ...labeledPages.map(p => ({
    type: p.type, id: p.id, title: p.title,
    chunk: p.content, score: p.score, meta: p.meta,
    isLabeled: true,
  })),
];

allItems.sort((a, b) => b.score - a.score);

// 소스별 대표 1개 우선 (기존 로직)
const finalItems = applySourceCoverage(allItems).slice(0, chunkCap);
```

### 6.4 출력 라벨링

```typescript
const formattedBlocks = finalItems.map(item => {
  if ('isLabeled' in item && item.isLabeled) {
    // stance/fact/overview
    return `## [${item.type}] ${item.title} (${item.id}) | ${item.meta}\n${item.chunk}`;
  } else {
    // source — 기존 형식 + 회의일
    return `## ${item.title} (${item.id})${item.date ? ` | 회의일: ${item.date}` : ''}\n${item.chunk}`;
  }
}).join('\n\n---\n\n');
```

---

## 7. Prompt (lib/llm/prompts.ts)

### 7.1 system prompt 보강

```typescript
return `당신은 서울대학교 거버넌스 통합 위키 AI 어시스턴트입니다.
평의원회·이사회·대학운영계획·중장기발전계획·70년역사·대학현황·유홍림총장연설·재무정보공시 자료를 바탕으로 정확하고 구조적인 답변을 제공합니다.

## 핵심 원칙

[기존 P1~P5 유지]

## 답변 형식 가이드

### 페이지 타입 활용 (자료 헤더의 라벨 참고)
- \`[stance]\` 라벨 = 인물의 명시적 입장. 비교·의견 질문에 우선 인용 (Quote 필수)
- \`[fact]\` 라벨 = 정형 사실 데이터. 수치·연도 질문에 우선 인용 (단위·연도 명시)
- \`[overview]\` 라벨 = 편 단위 개요. broad 질문에 우선
- 그 외 = source(회의록/계획서) — 기본 출처

### 비교 질문 (자동 인식)
질문이 두 인물·시점·위키 비교를 요구하면:
- 비교 항목별 표 형식 (행: 항목, 열: 비교 대상)
- 각 셀에 인라인 출처 [위키명] 페이지ID
- 한쪽만 자료 있는 항목은 "(자료 없음)" 명시
- stance 페이지가 양쪽 모두 있으면 우선 정렬

### 수치/시점 질문
연도·금액·수량이 포함되면 fact 페이지를 우선 인용. 단위·범위 명시.

[기존 답변 길이 원칙]

## 현재 활용 가능한 위키
${agentList}${sensitiveWarning}`;
```

### 7.2 user message 변경 없음

기존 `buildUserMessage()` 그대로 — 이미 contexts.relevantData를 그대로 출력하므로 라벨링은 wiki-agent에서 처리됨.

---

## 8. Test Plan

### 8.1 회귀 테스트 (기존 4 위키)

| 시나리오 | 기대 |
|---|---|
| "26년 이사회 회의 기록" | board 위주, 결과 동일 |
| "AI 가이드라인 의결" | senate 위주, 결과 동일 |
| "전체 요약" | 4 위키 모두 (Tier 0) |

### 8.2 신규 위키 단독

| 시나리오 | 기대 |
|---|---|
| "법인화 역사" | history overview/source 포함 |
| "서울대 비전" | status fact 포함 (alwaysContext도 검증) |
| "유홍림 총장 AI 발언" | yhl-speeches stance 포함 |
| "2024년 종합재무제표" | finance fact 포함, 표 깨지지 않음 |

### 8.3 Cross-Wiki (핵심)

| 시나리오 | 기대 |
|---|---|
| "유홍림 AI 시대 대학 역할 입장" | yhl-speeches stance + concept-index로 board 보조 |
| "법인화 전후 재정 변화" | history(맥락) + finance(수치) |
| "관악 캠퍼스 70년" | history + status |

### 8.4 토큰 측정

각 시나리오 입력 토큰 측정 → typical ≤ 10K, worst ≤ 12K.

---

## 9. Migration / Rollout

### 9.1 후방 호환

- 기존 4 위키 JSON: `facts: []`, `stances: []`, `overviews: []` 자동 추가
- 기존 ChatPage / wiki browser UI: 라벨링된 페이지를 source처럼 표시 (별도 처리 X)
- 기존 conversation 기록: 영향 없음

### 9.2 배포 순서

```
M1 → 빌드 → 검증 (npm run build 통과)
M2 → 빌드 실행 (npm run wiki:build) → 8 JSON 생성 확인
M3 → dev 서버 재기동 → 신규 위키 단독 답변 검증
M4 → 토큰 측정 → 목표 통과 확인
M5 → 비교 질문 답변 형식 확인
git push → Vercel 자동 재배포
```

각 모듈 후 commit → 회귀 발생 시 단계별 rollback 가능.

---

## 10. Out of Scope

- 이석재 후보 철학 wiki (사용자 요청에 따라 제외)
- Multi-LLM 시뮬레이션 (별도 plan)
- 벡터 임베딩 검색 (장기 과제, 별도 plan)
- UI 확장 (`/wiki` 페이지에 fact/stance/overview 탭) — 별도 plan
- 페이지 타입별 Plugin 분리 (Option B) — 필요 시 다음 사이클

---

## 11. Implementation Guide

### 11.1 변경 파일 상세

| 파일 | 추가 라인 (예상) | 변경 라인 | 핵심 변경 |
|---|---:|---:|---|
| `lib/agents/types.ts` | ~50 | ~5 | 4 인터페이스 + AgentConfig 확장 |
| `data/agents.config.json` | ~60 | ~5 | 4 에이전트 + alwaysContext |
| `scripts/build-wiki-data.ts` | ~140 | ~10 | 3 파서 + concept-index + WIKI_MAP |
| `lib/agents/wiki-agent.ts` | ~80 | ~30 | 페이지 타입 통합 + 라벨링 |
| `lib/agents/router.ts` | ~120 | ~30 | Stage 1 + 적응형 + concept-index |
| `lib/llm/prompts.ts` | ~30 | ~5 | 라벨 활용 가이드 + 비교 가이드 |
| **합계** | **~480** | **~85** | 6 파일 |

### 11.2 구현 순서 (의존성 따라)

1. `types.ts` (모든 후속 모듈이 의존)
2. `agents.config.json` (4 에이전트 등록 + alwaysContext)
3. `build-wiki-data.ts` (데이터 생성)
4. **빌드 실행** → 8 JSON + concept-index.json 확인
5. `wiki-agent.ts` (검색 로직 — concept-index가 데이터 파일에 의존)
6. `router.ts` (라우팅 — wiki-agent 변경에 의존)
7. `prompts.ts` (LLM 프롬프트 — 마지막)
8. dev 서버 재기동 → 시나리오 8 검증

### 11.3 Session Guide

#### Module Map

| Module | Files | Estimated | Done State |
|---|---|---:|---|
| **M1 — Foundation** | `types.ts`, `agents.config.json` | 1h | TS 컴파일 통과, registry가 8 에이전트 인식 |
| **M2 — Build Pipeline** | `build-wiki-data.ts` | 1.5h | `npm run wiki:build` 성공, 8 JSON + concept-index.json |
| **M3 — Wiki Agent** | `wiki-agent.ts` | 1h | 새 페이지 타입이 LLM 컨텍스트에 라벨링되어 등장 |
| **M4 — Router** | `router.ts` | 1.5h | 적응형 라우팅 + alwaysContext 작동, 토큰 측정 |
| **M5 — Prompts** | `prompts.ts` | 30min | 비교 질문 응답이 표 형식 |

**합계: 5~5.5시간**

#### Recommended Session Plan

**Session 1 — Data Layer 완성** (M1 + M2 + M3, ~3.5h)
```bash
/pdca do multi-wiki-integration --scope m1,m2,m3
```
완료 시점: 신규 위키들이 검색 결과에 등장. 라우팅은 아직 기존 방식.

**Session 2 — Routing & Polish** (M4 + M5, ~2h)
```bash
/pdca do multi-wiki-integration --scope m4,m5
```
완료 시점: 적응형 라우팅 + 비교 가이드 작동. 검증 시나리오 통과.

또는 한 번에:
```bash
/pdca do multi-wiki-integration
```

각 모듈 완료 후 commit 권장 (rollback 안전성).

---

## 12. Decision Record

| 결정 | 선택 | 대안 | 이유 |
|---|---|---|---|
| 페이지 타입 처리 | 단일 WikiAgent 내 분기 | Plugin per Type (Option B) | 작업 시간·복잡도 절약, 추후 진화 가능 |
| Concept Index | 단일 JSON | 별도 모듈 + DB | 빌드 시 자동 생성, lookup 빠름 |
| 의도 검출 | 사용 안 함 | detectIntent() | False positive 30%가 노이즈 누적, system prompt가 더 견고 |
| 가중치 매트릭스 | 사용 안 함 | 6×3 매트릭스 | 의도 검출 부정확성 + 자연 점수로 충분 |
| Comparison prompt | 항상 켜기 | 의도 검출 시 동적 주입 | 토큰 ~200 추가 미미, false positive 회피 |
| Reference 위키 | `alwaysContext` 플래그 | 기본 기능 | broad 위키(status) 항상 보조 컨텍스트 |
| Top-N 컷오프 | 적응형 (gap+threshold) | 하드 top-3 | 정보 누락 위험 회피 |
