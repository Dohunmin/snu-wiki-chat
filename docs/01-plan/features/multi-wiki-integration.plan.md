# Plan: Multi-Wiki Integration — 4개 신규 위키 통합 + 토큰 효율 Cross-Source 검색

> **Feature**: multi-wiki-integration
> **Date**: 2026-05-06
> **Phase**: Plan

---

## Executive Summary

| 항목 | 내용 |
|---|---|
| **Problem** | 신규 위키 4개(70년역사·대학현황·유홍림연설·재무정보공시)가 기존 source/topic/entity 외에 fact·stance·overview 페이지 타입을 사용. 현재 빌드는 새 타입을 무시하고, 8개 위키로 늘면 라우터·청크 cap이 그대로일 때 토큰이 급증 |
| **Solution** | (1) 새 페이지 타입을 정식 콘텐츠로 ingest, (2) 적응형 라우팅(절대+상대+gap)으로 위키 좁힘 + `alwaysContext` 위키는 항상 보조, (3) 페이지 타입별 청크 처리(stance/fact/overview 통째)·출력 라벨링, (4) Cross-wiki concept 인덱스 + 비교 프롬프트 상시 가이드 |
| **UX Effect** | 8개 위키 통합 검색이 가능하면서도 쿼리당 입력 토큰 ~10K 이내 유지. 인물·사건이 여러 위키에 걸친 질문에 자동으로 종합 답변 |
| **Core Value** | "위키 수가 늘어나도 답변 품질·속도·비용은 안 무너진다." 단순 RAG에서 멈추지 않고 비교·시뮬레이션으로 확장 가능한 데이터 기반 마련 |

---

## Context Anchor

| 항목 | 내용 |
|---|---|
| **WHY** | 위키 수가 2배(4→8)로 늘어나는 시점은 시스템 한계가 드러나는 순간. 라우팅·검색·프롬프트를 함께 조정하지 않으면 토큰이 2~3배로 폭증하거나, 좁힌다고 좁히다 핵심 정보를 놓침 |
| **WHO** | 총장 후보자 + 관리자. 단일 위키 RAG 사용자에서 → 8개 위키 종합 + 후보 비교 + 시뮬레이션 사용자로 확장됨 |
| **RISK** | (R1) 청크 cap을 위키별로 나누면 단일 위키 깊이 검색이 약해짐. (R2) 라우터 좁힘이 너무 강하면 cross-wiki 답변이 일부 위키에서 끊김 → 적응형 + `alwaysContext`로 완화. (R3) ~~의도 검출 false positive~~ → 가중치 매트릭스 제거로 회피. (R4) fact 표가 청크 분할로 깨질 수 있음 → 통째 출력 |
| **SUCCESS** | 8개 위키 ingest 성공 + 쿼리당 input 토큰 ≤ 10K + 회귀 없음(기존 4 위키 답변 동일) + cross-wiki 비교 질문에 표 형식 자동 응답 |
| **SCOPE** | `scripts/build-wiki-data.ts`, `lib/agents/types.ts`, `lib/agents/wiki-agent.ts`, `lib/agents/router.ts`, `lib/llm/prompts.ts`, `data/agents.config.json`. 신규 plugin 추가는 Phase 2 이후 |

---

## 1. 통합 대상 위키

### 1.1 추가할 4개

| id | name | folder | 데이터 | 신규 디렉토리 | 비고 |
|---|---|---|---|---|---|
| `history` | 70년역사 | `SNU_70년역사_LLM_Wiki` | 70년사 6편/24장 | `overviews/` | stance 없음 |
| `status` | 대학현황 | `SNU_대학현황_LLM_Wiki` | 공식 비전·현황 | `facts/` | 단일 source |
| `yhl-speeches` | 유홍림총장연설 | `SNU_유홍림총장연설_LLM_Wiki` | 18개 연설 | `stances/` | 1인물(유홍림) |
| `finance` | 재무정보공시 | `SNU_재무정보공시_LLM_Wiki` | 8개년 결산·예산 | `facts/` | 시계열 수치 |

### 1.2 신규 페이지 타입 3종

#### **fact** (대학현황 3개, 재무정보공시 10개)
정적·시계열 사실 데이터.
```yaml
type: fact
category: 자산 | 비전 | 통계 | ...
sources: [경로 또는 URL]
metric_scope, unit, years_covered  # 재무 전용
verified_at: YYYY-MM-DD
```
본문: `## 내용` (표/수치) + `## 출처` + `## 변경이력`

#### **stance** (유홍림연설 7개)
인물의 입장·철학.
```yaml
type: stance
holder: 유홍림           # 1급 분류 키
topic: AI시대대학역할    # §T 통일 카탈로그
sources: [≥1]
```
본문: `## 핵심 입장` + `## 근거 발언`(Quote ≥1) + `## 맥락` + `## 관련 stance/topic`

#### **overview** (70년역사 6개)
편/장 단위 개요.
```yaml
type: overview
편: 통사편
시기: [1946, 2016]
관련_stance:
  유홍림: [...]
  이석재: [...]
```

---

## 2. 핵심 설계 결정 — 토큰 효율과 Cross-Source 검색

### 2.1 라우팅 전략 — "2-stage + 적응형 선택"

**현재 문제**: Tier 1에서 키워드 매칭된 위키 모두 호출 → 8개 위키 시대에는 4~6개가 동시에 호출될 수 있음.

**개선**: **2-stage 라우팅 + 적응형 cap**

```
Stage 1 (cheap): 모든 8개 위키에 대해 keyword/metadata 점수만 계산
                 (실제 청크 검색 없음, < 5ms)
       ↓ 적응형 선택 (하드캡 X)
Stage 2 (deep): 선택된 위키만 getContext() 호출
                 청크 cap = floor(30 / 선택된위키수) + alwaysContext bias
```

#### 적응형 선택 알고리즘 (하드캡 top-N 대신)

3가지 신호 조합:
1. **절대 threshold** — `score ≥ MIN_ABSOLUTE` (예: 3.0)
2. **상대 threshold** — `score ≥ topScore × 0.4`
3. **Score Gap 감지** — sorted score 사이 가장 큰 gap 앞까지 컷
   ```
   예: [14, 11, 9, 7, 1, 0, 0, 0]
              ↑ gap 6 (7→1)이 최대
              → 4개 위키 선택
   ```
4. **Reference-mode 위키** — `agents.config.json`에 `alwaysContext: true` 플래그 (예: 대학현황). 절대 threshold 무시하고 무조건 포함, 단 청크 cap 작게 (5)

**최종 cap**: `min(통과 위키 수, 6)` — worst case에도 6개 이내.

**효과**:
- 무관한 위키는 0 토큰 사용
- broad 위키(대학현황 등)는 항상 보조 컨텍스트로 활용
- "전체 요약" 같은 글로벌 쿼리는 Stage 1 우회 (현재 로직 유지)

### 2.2 페이지 타입 인식 — 단순화

**의도 검출(`detectIntent`)과 가중치 매트릭스는 사용하지 않습니다.**

이유:
- 한국어 의도 검출 휴리스틱 정확도 ~70% → false positive 30%가 노이즈 누적
- stance/fact 같은 페이지는 자연 점수(빈도 + entity 매칭)만으로도 잡힘
- 비교 의도는 시스템 프롬프트 레벨에서 LLM에게 가이드하는 게 더 견고

#### 점수 공식 (단순)

```typescript
function scoreSource(source, queryWords, guaranteedIds) {
  let score = 0;

  // (1) Concept index hit — 가장 강함
  if (guaranteedIds.has(source.id)) score += 5;

  // (2) Topic 매칭 — 사람이 정리한 압축 콘텐츠 우선
  for (const t of source.topics) {
    if (matchesAny(queryWords, t)) score += 3;
  }

  // (3) Tag·entity 매칭
  for (const tag of source.tags) {
    if (matchesAny(queryWords, tag)) score += 2;
  }
  for (const e of source.entities) {
    if (matchesAny(queryWords, e)) score += 2;
  }

  // (4) 본문 단어 빈도
  for (const word of queryWords) {
    score += occurrenceCount(source.content, word);
  }

  return score;
}
```

페이지 타입 분기는 **점수 계산이 아닌 청크 처리·출력에만 적용** (다음 항목).

#### 청크 처리 (페이지 타입별)

| 페이지 타입 | 청크 분할 | 출력 방식 |
|---|---|---|
| source | `##` 헤더 단위 (현재 유지) | `## 제목 (id) \| 회의일: ...` |
| topic | 분할 안 함 (작음) | 전체 |
| entity | 분할 안 함 (작음) | 전체 |
| **stance** | 분할 안 함 (`핵심 입장 + 근거 발언` 통째로) | `## [stance] holder: 유홍림 / topic: AI시대대학역할` |
| **fact** | **분할 안 함** (표 깨짐 방지) | `## [fact] category: 자산 / years: 2017~2024` |
| **overview** | 분할 안 함 | `## [overview] 편: 통사편 / 시기: 1946~2016` |

→ stance/fact/overview는 entity처럼 "통째 보존" 정책. 작은 데이터(평균 200~800자)이므로 분할 비용 > 효익.

**출력 라벨링**의 효과: LLM이 페이지 종류를 인식하고 답변 시 적절히 활용 (가중치 부여보다 견고).

### 2.3 Cross-Wiki Concept Index

**현재 한계**: `유홍림`이 senate, board, yhl-speeches 3개 위키에 각각 존재. 검색 시 별개 취급.

**개선**: 빌드 시 **단순 cross-wiki entity 인덱스** 생성 (`data/concept-index.json`):

```json
{
  "유홍림": {
    "wikis": ["board", "yhl-speeches"],
    "aliases": ["총장", "유 총장"],
    "linkedPages": [
      { "wiki": "board", "type": "entity", "id": "유홍림" },
      { "wiki": "board", "type": "source", "id": "2023-1차" },
      { "wiki": "yhl-speeches", "type": "stance", "id": "AI시대대학역할.유홍림" }
    ]
  },
  "법인화": {
    "wikis": ["history", "board", "senate"],
    "linkedPages": [...]
  }
}
```

#### 인덱스 범위 (의도적 단순화)

- ✅ entity 합집합 (이름 같은 인물·기구)
- ✅ stance holder + topic
- ✅ source tag (위키 가로지르는 빈도 높은 태그만, 예: "법인화")
- ❌ 모든 단어/concept 인덱싱 X (over-engineering)
- ❌ 정교한 점수 가중치 X (단순 부스트만)

#### 활용 흐름

라우팅 시 concept 매칭이 강하면 (예: `유홍림 정책`):
1. concept-index에서 `유홍림` lookup → `["board", "yhl-speeches"]` 강제 포함
2. Stage 1 prefilter는 그대로 진행 (다른 약한 매칭 위키도 포함될 수 있음)
3. WikiAgent 내부에서는 concept 매칭 페이지를 `guaranteedIds`로 +5 부여

→ **인덱스의 역할은 "라우팅 결정"까지만**. LLM 컨텍스트 안에서의 fuzzy matching은 LLM에게 위임.

### 2.4 Comparison Prompt — 항상 켜기

**의도 검출 없이** system prompt에 비교 가이드를 상시 포함:

```
## 답변 형식 가이드

### 비교 질문 (자동 인식)
질문이 두 인물·시점·위키의 비교를 요구하면:
- 비교 항목별 표 형식 사용 (행: 항목, 열: 비교 대상)
- 각 셀에 인라인 출처 [위키명] 페이지ID 표기
- 한쪽만 자료 있는 항목은 "(자료 없음)" 명시
- stance 페이지가 양쪽 모두 있으면 우선 정렬

### 수치/시점 질문
질문에 연도·금액·수량이 포함되면 fact 페이지 우선 인용.

### 일반 질문
기존 P1~P5 규칙 적용 (할루시네이션 금지, 인라인 출처, 테마별 구조화).
```

**왜 항상 켜놓나**:
- 토큰 비용 미미 (~200 토큰)
- 비교 질문 아니면 LLM이 알아서 무시
- 의도 검출 false positive/negative 위험 0

### 2.5 전체 토큰 예산

| 구성 | Before (4 위키) | After (8 위키, naive) | After (8 위키, 본 plan) |
|---|---:|---:|---:|
| 호출되는 위키 수 | 1~3 | 3~6 | **1~5 (적응형)** |
| 위키당 청크 | 30 | 30 | **6~30 (cap 나눔)** |
| 청크당 평균 | 400자 | 400자 | 400자 |
| 입력 토큰 (typical) | 5K~8K | 12K~18K | **5K~9K** |
| 입력 토큰 (worst) | 12K | 25K+ | **11K** |
| 의도 검출/가중치 매트릭스 | — | — | ❌ 없음 (단순화) |

목표: **typical ≤ 10K 유지, worst ≤ 12K 유지**.

#### 추가 절감: Prompt Caching (권장)

Anthropic prompt caching 활용:
- system prompt(고정 부분)을 캐시 마커로 감쌈
- 5분 TTL 안에 같은 system prompt 사용 시 90% 할인
- 대화 1회에 다발 질문하는 패턴에 효과적

---

## 3. 구현 단계 (Incremental)

### **Phase 1 — Ingestion (필수, 이번 사이클)**
- [x] WIKI_MAP에 4개 추가
- [x] `parseFrontmatter` + `collectMdFiles`는 이미 범용. 새 디렉토리만 읽으면 됨
- [x] 새 페이지 타입을 위한 인터페이스 (`WikiFact`, `WikiStance`, `WikiOverview`)
- [x] 신규 디렉토리 파싱: `wiki/facts/`, `wiki/stances/`, `wiki/overviews/`
- [x] `data/agents.config.json`에 4개 에이전트 등록
- [x] `updateAgentKeywords` 확장: stance.topic, fact.category, overview.편 도 키워드 추출

**Deliverable**: `npm run wiki:build` 실행 시 8개 위키 모두 JSON 생성, 새 페이지 타입이 모두 로드.

### **Phase 2 — Type-aware Chunking (필수, 이번 사이클)**
- [ ] `WikiAgent.getContext()`에서 페이지 타입별 청크 처리 분기
  - source: 기존 `##` 헤더 분할 유지
  - stance/fact/overview/topic/entity: 통째 출력 (분할 X)
- [ ] 출력 시 페이지 타입 라벨 prefix (`[stance]`, `[fact]`, `[overview]`)
- [ ] ~~의도 검출 함수~~ → 사용 안 함
- [ ] ~~페이지 타입별 점수 가중치~~ → 사용 안 함 (자연 점수만)
- [ ] 청크 cap을 라우팅된 위키 수에 따라 분배

**Deliverable**: 8 위키 동시 호출 시에도 입력 토큰 ≤ 10K, 새 페이지 타입이 LLM 컨텍스트에 명확히 라벨링됨.

### **Phase 3 — Two-stage Router with Adaptive Selection (이번 사이클)**
- [ ] Router에 `Stage 1 prefilter`: 모든 위키에 대해 metadata 점수 계산
- [ ] 적응형 선택 (절대 threshold + 상대 threshold + score gap)
- [ ] `agents.config.json`에 `alwaysContext` 플래그 지원 (대학현황 등)
- [ ] 글로벌 키워드는 우회 (현재 로직 유지)

**Deliverable**: 무관한 위키 0 호출 + reference 위키는 항상 보조 컨텍스트로 활용.

### **Phase 4 — Cross-Wiki Concept Index (이번 사이클)**
- [ ] 빌드 시 `data/concept-index.json` 생성 (entity 합집합 + stance holder/topic + 빈도 높은 tag)
- [ ] Router에서 concept 매칭 시 해당 위키들 강제 포함
- [ ] WikiAgent에서 concept-매칭 페이지를 `guaranteedIds`로 +5 부여
- [ ] **인덱스는 단순하게 — 정교한 점수 가중치 X**

**Deliverable**: "유홍림 정책" 같은 cross-wiki 질문에 자동으로 multi-wiki 통합.

### **Phase 5 — Comparison Prompt (이번 사이클)**
- [ ] `lib/llm/prompts.ts`에 비교/수치 가이드를 system prompt에 상시 포함
- [ ] 페이지 타입 라벨 활용 가이드 추가
- [ ] ~~의도 검출 결과 동적 주입~~ → 사용 안 함 (항상 켜놓음)

**Deliverable**: 비교 질문에 표 형식 답변 자동 생성.

### **Phase 6 — UI 확장 (다음 사이클)**
- [ ] `/wiki` 페이지에서 fact/stance/overview 탭 추가
- [ ] 페이지 타입별 마크다운 렌더링 차등 처리
- [ ] (스코프 외, 별도 plan)

---

## 4. 변경 파일 목록

| 파일 | 변경 내용 | Phase |
|---|---|---|
| `lib/agents/types.ts` | `WikiFact`, `WikiStance`, `WikiOverview`, `ConceptIndex` 인터페이스 추가, `WikiData`/`AgentConfig` 확장 | 1, 4 |
| `scripts/build-wiki-data.ts` | `WIKI_MAP` 4개 추가, `facts`/`stances`/`overviews` 파서, concept-index 생성 | 1, 4 |
| `lib/agents/wiki-agent.ts` | 페이지 타입별 청크 처리 분기, 출력 라벨링, 청크 cap 분배 (의도 검출·가중치 매트릭스 X) | 2 |
| `lib/agents/router.ts` | Stage 1 prefilter, 적응형 선택(gap detection), `alwaysContext` 처리, concept-index 활용 | 3, 4 |
| `lib/llm/prompts.ts` | 비교/수치/페이지 타입 가이드를 system prompt에 상시 포함 | 5 |
| `data/agents.config.json` | 4개 에이전트 등록 + `alwaysContext` 플래그 (status용) | 1, 3 |
| `data/{4개 신규}.json` | 빌드 자동 생성 | 1 |
| `data/concept-index.json` | 빌드 자동 생성 | 4 |

---

## 5. 데이터 모델 (Phase 1 핵심)

### 5.1 확장된 WikiData
```typescript
export interface WikiData {
  id: string;
  name: string;
  sources: WikiSource[];
  topics: WikiTopic[];
  entities: WikiEntity[];
  syntheses: WikiSynthesis[];
  // 신규
  facts: WikiFact[];
  stances: WikiStance[];
  overviews: WikiOverview[];
  index: string;
}
```

### 5.2 새 인터페이스
```typescript
export interface WikiFact {
  id: string;
  title: string;
  category: string;          // "자산", "비전" 등
  sources: string[];         // 본문에 인용된 source ID 또는 URL
  unit?: string;             // "억원" (재무 전용)
  yearsCovered?: string;     // "2017~2024"
  verifiedAt?: string;
  tags: string[];
  content: string;
}

export interface WikiStance {
  id: string;
  title: string;
  holder: string;            // "유홍림"
  topic: string;             // "AI시대대학역할" — §T slug
  sources: string[];         // 발언 등장 source ID
  content: string;           // ## 핵심 입장 + ## 근거 발언 + ...
  status?: string;
}

export interface WikiOverview {
  id: string;
  title: string;
  편: string;                // "통사편"
  시기?: [number, number];   // [1946, 2016]
  관련_stance?: Record<string, string[]>;  // { 유홍림: [...], 이석재: [...] }
  content: string;
}
```

### 5.3 Concept Index (Phase 4)
```typescript
export interface ConceptIndex {
  [conceptName: string]: {
    wikis: string[];                       // concept이 등장하는 위키 id 목록
    aliases: string[];
    linkedPages: {
      wiki: string;
      type: 'entity' | 'topic' | 'stance' | 'source' | 'fact';
      id: string;
    }[];
  };
}
```

### 5.4 AgentConfig 확장 (Phase 3 — `alwaysContext` 플래그)
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
  alwaysContext?: boolean;  // true면 Stage 1 절대 threshold 무시하고 항상 포함 (예: 대학현황)
}
```

---

## 6. 라우터 확장 의사 코드

```typescript
const MIN_ABSOLUTE_SCORE = 3;
const RELATIVE_THRESHOLD = 0.4;
const MAX_WIKIS = 6;
const ALWAYS_CONTEXT_CAP = 5;
const TOTAL_CHUNK_BUDGET = 30;

async function routeQuery(query: string, role: Role): Promise<RoutingResult> {
  const queryLower = query.toLowerCase();
  const agents = registry.getAll();

  // Tier 0 — global keyword (기존 유지)
  if (hasGlobalKeyword(query) && noTier1Match) { return allWikisGlobalMode(); }

  // === Stage 1: cheap prefilter (metadata only, no content scan) ===
  const scored = agents.map(agent => ({
    agent,
    score: prefilterScore(agent, queryLower),
  }));

  // === Concept Index — 강한 cross-wiki 매칭 강제 포함 ===
  const conceptHits = conceptIndex.lookup(queryLower);  // ['board', 'yhl-speeches']
  const forcedWikis = new Set(conceptHits);

  // === 적응형 선택 ===
  scored.sort((a, b) => b.score - a.score);
  const topScore = scored[0]?.score ?? 0;
  const relativeThreshold = topScore * RELATIVE_THRESHOLD;

  // Score gap 감지
  const gapCutoffIdx = findLargestGap(scored.map(s => s.score));

  const selected = scored.filter((s, i) => {
    if (forcedWikis.has(s.agent.config.id)) return true;          // concept 강제 포함
    if (s.agent.config.alwaysContext) return true;                // reference 위키
    if (s.score < MIN_ABSOLUTE_SCORE) return false;               // 절대 컷
    if (s.score < relativeThreshold) return false;                // 상대 컷
    if (i > gapCutoffIdx) return false;                           // gap 이후 컷
    return true;
  }).slice(0, MAX_WIKIS);

  // === Stage 2: deep retrieval (청크 cap 분배) ===
  const normalAgents = selected.filter(s => !s.agent.config.alwaysContext);
  const refAgents = selected.filter(s => s.agent.config.alwaysContext);

  const normalCap = Math.floor(
    (TOTAL_CHUNK_BUDGET - refAgents.length * ALWAYS_CONTEXT_CAP)
    / Math.max(normalAgents.length, 1)
  );

  const contexts = await Promise.all(selected.map(s =>
    s.agent.getContext(query, role, false, {
      chunkCap: s.agent.config.alwaysContext ? ALWAYS_CONTEXT_CAP : normalCap,
      conceptIndex,
    })
  ));

  return { selectedAgentIds: selected.map(s => s.agent.config.id), contexts };
}
```

---

## 7. 위험 및 완화

| Risk | 완화 |
|---|---|
| **R1** 청크 cap 분배로 단일 위키 깊이 약화 | 라우팅 위키 1개면 cap 30 유지. N개로 늘어도 reference 위키는 5씩 따로 할당 |
| **R2** 라우터가 너무 좁히면 정보 누락 | 적응형 선택 (절대+상대+gap) 보수적. `alwaysContext` 위키 항상 포함. concept 매칭은 강제 |
| **R3** ~~stance 가중치 과대~~ | 가중치 매트릭스 제거 — 자연 점수만 사용 |
| **R4** fact 표가 청크 분할로 깨짐 | fact 절대 분할 안 함 (통째 출력) |
| **R5** 빌드 타입 에러 | Phase 1을 작은 단위로 검증 (1 위키씩 먼저 빌드) |
| **R6** 메모리 (8 위키 JSON 합산) | 현재 4 위키 1MB. 8 위키 ~2MB |
| **R7** concept-index 너무 비대 | 빈도 높은 tag만 (예: 5개 위키 이상 등장 또는 출현 ≥10회). entity·stance holder/topic은 전부 포함 |
| **R8** alwaysContext 위키가 무관한 답변에 노이즈 | cap 5로 제한 + LLM은 출처 라벨 보고 무관하면 무시 |

---

## 8. 검증 시나리오

### 8.1 회귀 테스트 (기존 4 위키)
- [ ] "26년 이사회 회의 기록" → board 위주, 결과 동일
- [ ] "AI 가이드라인 의결" → senate 위주, 결과 동일
- [ ] "전체 요약" → 4개 위키 모두 (Tier 0 유지)

### 8.2 신규 위키 검증
- [ ] "법인화 역사" → history 위주
- [ ] "서울대 비전" → status 위주
- [ ] "유홍림 총장 AI 발언" → yhl-speeches 위주
- [ ] "2024년 종합재무제표" → finance 위주

### 8.3 Cross-Wiki 검증 (핵심)
- [ ] "유홍림 총장의 AI 시대 대학 역할 입장" → yhl-speeches stance + 다른 위키 보조
- [ ] "법인화 전후 재정 변화" → history(맥락) + finance(수치)
- [ ] "관악 캠퍼스 70년" → history + status
- [ ] "이사회와 평의원회의 시흥 캠퍼스 입장" → board + senate (기존 4 위키만 사용 시도 정상 작동)

### 8.4 토큰 측정
- [ ] 위 모든 시나리오에서 input 토큰 측정
- [ ] typical ≤ 10K, worst ≤ 12K 확인

---

## 9. Success Criteria

| # | 기준 | 측정 |
|---|---|---|
| SC1 | 8개 위키 빌드 성공 | `npm run wiki:build` 무에러, `data/{8}.json` + `concept-index.json` 모두 생성 |
| SC2 | 기존 4 위키 회귀 없음 | 시나리오 8.1 모두 동일 답변 |
| SC3 | 신규 위키 단독 답변 작동 | 시나리오 8.2 모두 정확 출처 인용 |
| SC4 | Cross-wiki 비교 자동 통합 | 시나리오 8.3 — 답변에 2개 이상 위키 출처 등장 |
| SC5 | 입력 토큰 ≤ 10K (typical), ≤ 12K (worst) | 모든 시나리오 평균 토큰 확인 |
| SC6 | 비교 질문은 표 형식 응답 | 시나리오 8.3 응답에 markdown table 포함 |
| SC7 | alwaysContext 위키 항상 호출 | 시나리오 8.2 모두 routing 결과에 status 포함 |
| SC8 | 코드 단순성 | wiki-agent.ts에 `detectIntent`, intent 가중치 매트릭스 없음 |

---

## 10. 다음 단계

1. **Plan 승인** ← 지금 (이 문서)
2. **Design** — `/pdca design multi-wiki-integration` (3가지 아키텍처 옵션 제시)
3. **Do** — Phase 1~5 순차 구현
4. **Check** — 시나리오 8 전부 실행 + 토큰 측정
5. **Report** — 토큰 절감 정량 + Cross-wiki 답변 예시

---

## 11. 의도적 비스코프 (Out of Scope)

- 이석재 후보 철학 wiki (사용자 요청에 따라 제외)
- Multi-LLM 시뮬레이션 (Phase 6 별도 plan)
- 벡터 임베딩 검색 도입 (장기 과제, 별도 plan)
- UI 확장 (`/wiki` 페이지 페이지 타입 탭) — 별도 plan
- Synthesis 자동 저장 워크플로우 — 별도 plan

---

## 12. 참고

- 기존 plan: `docs/01-plan/features/smart-retrieval.plan.md`, `smart-routing.plan.md`
- 시스템 보고서: `docs/SNU_거버넌스_위키_시스템_보고서.md`
- 스코어링 분석: `docs/스코어링_및_답변_생성_보고서.md`
- Obsidian 통일 스키마: `c:/Users/USER/Desktop/Obsidian/CLAUDE.md` §F/§S/§T/§L
