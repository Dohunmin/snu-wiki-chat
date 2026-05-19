# Design: Hybrid RAG — Option C (Pragmatic Balance)

> **Feature**: hybrid-rag
> **Date**: 2026-05-18
> **Phase**: Design
> **Plan Reference**: [docs/01-plan/features/hybrid-rag.plan.md](../../01-plan/features/hybrid-rag.plan.md)
> **Architecture**: Option C — Pragmatic Balance (회귀 위험 최소 우선)

---

## 📌 Context Anchor (Plan에서 승계)

| 항목 | 내용 |
|---|---|
| **WHY** | 2026-05-18 갭 사례 — "대학원생 장학금 10년" 질문에 풍부한 자료(학생경비 8개년, 학문후속세대 지원금, 박사 기본장학금)가 있는데 "자료 없음"으로 답함. 단어 literal 매칭의 동의어 누락이 거버넌스 도구 신뢰성을 위협 |
| **WHO** | 총장 후보자·관리자. PoC 사용자는 도훈민 본인 |
| **RISK** | 노이즈 청크 오염 / 임베딩 비용·지연 / 회귀 / pgvector 마이그레이션 실수 → RRF·Golden Q&A·플래그·신규 테이블만 추가 등으로 완화 |
| **SUCCESS** | 갭 사례 해소 + 회귀 ≥18/20 + 지연 ≤200ms + 9개 확장 청사진 명확 |
| **SCOPE** | finance 1개 위키만. 신규 `lib/embed/`·`scripts/build-embeddings.ts`·pgvector 테이블 |

---

## 1. Overview

### 1.1 설계 핵심 원칙

> **"기존 WikiAgent 코드는 건드리지 않는다. 임베딩·벡터검색·RRF만 새 모듈로 분리하고, WikiAgent에서는 단일 지점에서 융합만 호출한다."**

```
┌────────────────────────────────────────────────────────────────┐
│ WikiAgent.getContext()                                         │
│ ┌──────────────────────────────────┐                           │
│ │ 기존 키워드 스코어링 (보존)        │                           │
│ │  • splitIntoChunks (## 분할)      │                           │
│ │  • scoreChunk (빈도)              │                           │
│ │  • entity 역참조 guaranteed +5    │                           │
│ │  • source 점수 (topic+3, ...)     │                           │
│ │  • 소스 커버리지 균등화           │                           │
│ │  → scoredChunks: Chunk[]          │                           │
│ └─────────────┬────────────────────┘                           │
│               │                                                │
│               ↓ (ragEnabled 일 때만)                            │
│ ┌──────────────────────────────────────────────────────────┐  │
│ │ ── 신규 단일 통합 지점 (~10줄) ──                          │  │
│ │  vectorTop = await searchVector(query, wikiId, role)     │  │
│ │  fusedChunks = rrfFuse(scoredChunks, vectorTop, k=60)    │  │
│ │  scoredChunks = fusedChunks                              │  │
│ └──────────────────────────────────────────────────────────┘  │
│               │                                                │
│               ↓                                                │
│ ┌──────────────────────────────────┐                           │
│ │ 기존 후속 로직 (보존)              │                           │
│ │  • chunkCap 적용                  │                           │
│ │  • confidence 0.3 필터            │                           │
│ │  • entity 블록 prefix             │                           │
│ │  • 출력 포맷 라벨링                │                           │
│ └──────────────────────────────────┘                           │
└────────────────────────────────────────────────────────────────┘
                │
                ↓ 호출
┌────────────────────────────────────────────────────────────────┐
│ lib/embed/                       (신규 디렉토리, 임베딩·벡터검색) │
│ ├── voyage.ts    Voyage API 클라이언트                          │
│ ├── chunker.ts   페이지 타입별 임베딩 단위 변환                 │
│ ├── search.ts    pgvector top-K 검색                            │
│ ├── rrf.ts       RRF 융합 함수                                  │
│ └── types.ts     ChunkMetadata, EmbeddingResult                 │
└────────────────────────────────────────────────────────────────┘
                │
                ↓ DB
┌────────────────────────────────────────────────────────────────┐
│ PostgreSQL (Vercel Postgres + pgvector extension)              │
│ chunk_embeddings 테이블 (신규)                                  │
└────────────────────────────────────────────────────────────────┘
```

### 1.2 변경 영향 범위

| 영역 | 변경 | 위험 |
|------|------|:---:|
| **수정** wiki-agent.ts | RRF 통합 1곳 (~30줄 추가) | 🟢 저 |
| **수정** types.ts | `ragEnabled?: boolean` 추가 | 🟢 저 |
| **수정** schema.ts | `chunkEmbeddings` 정의 추가 | 🟢 저 |
| **수정** agents.config.json | finance만 `ragEnabled: true` | 🟢 저 |
| **수정** build-wiki-data.ts | 마지막에 임베딩 트리거 추가 | 🟢 저 |
| **수정** package.json | `voyageai`, drizzle pgvector 의존성 | 🟢 저 |
| **신규** lib/embed/ (5 파일) | 독립 모듈, 외부 영향 0 | 🟢 저 |
| **신규** scripts/build-embeddings.ts | 독립 스크립트 | 🟢 저 |
| **신규** scripts/golden-qa.ts | 검증용, 운영 영향 0 | 🟢 저 |
| **신규** DB migration | 새 테이블만 추가 | 🟢 저 |
| **변경 X** router.ts | 전혀 건드리지 않음 | 🟢 0 |
| **변경 X** lens.ts | 전혀 건드리지 않음 | 🟢 0 |
| **변경 X** prompts.ts | 전혀 건드리지 않음 | 🟢 0 |
| **변경 X** middleware.ts | 전혀 건드리지 않음 | 🟢 0 |

---

## 2. Architecture (Option C 상세)

### 2.1 디렉토리 구조

```
snu-wiki-chat/
├── lib/
│   ├── agents/
│   │   ├── wiki-agent.ts            ← 수정 (RRF 통합 1곳)
│   │   ├── router.ts                ← 변경 없음
│   │   ├── lens.ts                  ← 변경 없음
│   │   └── types.ts                 ← AgentConfig에 ragEnabled 추가
│   ├── embed/                       ← 🆕 신규 디렉토리
│   │   ├── voyage.ts                ← 🆕 Voyage API 클라이언트
│   │   ├── chunker.ts               ← 🆕 페이지 타입별 임베딩 단위 변환
│   │   ├── search.ts                ← 🆕 pgvector top-K 검색
│   │   ├── rrf.ts                   ← 🆕 RRF 융합
│   │   └── types.ts                 ← 🆕 ChunkMetadata, EmbeddingResult
│   ├── llm/                         ← 변경 없음
│   └── db/
│       ├── schema.ts                ← 수정 (chunkEmbeddings 정의 추가)
│       └── client.ts                ← 변경 없음
├── scripts/
│   ├── build-wiki-data.ts           ← 수정 (임베딩 트리거 추가)
│   ├── build-embeddings.ts          ← 🆕 위키별 임베딩 빌드
│   └── golden-qa.ts                 ← 🆕 회귀 자동 비교
├── drizzle/
│   └── 0xxx_pgvector.sql            ← 🆕 마이그레이션
├── data/
│   └── agents.config.json           ← 수정 (finance ragEnabled: true)
└── .env.local                       ← VOYAGE_API_KEY 추가
```

### 2.2 모듈 간 의존성

```
WikiAgent (lib/agents/wiki-agent.ts)
    ↓ import
lib/embed/search.ts          ← pgvector 쿼리
    ↓ import
lib/db/client.ts             ← Drizzle 인스턴스
    ↓
PostgreSQL chunk_embeddings  ← pgvector 인덱스

──────────────────────────────────────────────

WikiAgent (lib/agents/wiki-agent.ts)
    ↓ import
lib/embed/rrf.ts             ← 순수 함수, 외부 의존성 0

──────────────────────────────────────────────

scripts/build-embeddings.ts
    ↓ import
lib/embed/voyage.ts          ← Voyage API
    ↓ import
lib/embed/chunker.ts         ← 청크 변환
    ↓ import
data/{wikiId}.json           ← 기존 빌드 결과
```

### 2.3 핵심 결정 — ragEnabled 플래그 패턴

```typescript
// data/agents.config.json
{
  "agents": [
    { "id": "finance", "ragEnabled": true, ... },
    { "id": "senate" }   // ragEnabled 없음 → undefined → false 취급
  ]
}

// lib/agents/wiki-agent.ts (WikiAgent.getContext 내부)
const scored = /* 기존 키워드 스코어링 결과 */;

if (this.config.ragEnabled) {
  // 🆕 임베딩 + RRF
  const vectorTop = await searchVector(query, this.config.id, userRole, 30);
  scoredChunks = rrfFuse(scored, vectorTop, { k: 60, limit: 30 });
} else {
  // 기존 흐름 그대로
  scoredChunks = scored;
}

// 후속 로직 (기존)
```

**이 플래그의 의미**:
- PoC 단계: finance만 ON, 다른 8개 위키는 OFF → 회귀 위험 0
- Phase B: 9개 위키 모두 ON으로 *config 한 줄씩 변경*
- 검증 중 회귀 발견: 해당 위키만 OFF로 즉시 롤백 가능

---

## 3. Data Model

### 3.1 DB 스키마 — chunk_embeddings 테이블

```sql
-- drizzle/0xxx_pgvector.sql

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE chunk_embeddings (
  id            TEXT PRIMARY KEY,           -- {wikiId}:{pageType}:{pageId}:{chunkIdx}
  wiki_id       TEXT NOT NULL,              -- 'finance', 'senate', ...
  page_type     TEXT NOT NULL,              -- 'source' | 'fact' | 'stance' | 'overview' | 'topic' | 'entity'
  page_id       TEXT NOT NULL,              -- 원본 페이지 id (e.g., '비용구조.fact')
  chunk_idx     INTEGER NOT NULL,           -- source는 청크 순번, 나머지는 0
  chunk_text    TEXT NOT NULL,              -- 임베딩된 원본 텍스트 (검색 결과 반환용)
  embedding     VECTOR(1024) NOT NULL,      -- Voyage 3 = 1024차원
  sensitive     BOOLEAN NOT NULL DEFAULT FALSE,
  metadata      JSONB,                      -- { title, topic, holder, category, ... }
  content_hash  TEXT NOT NULL,              -- SHA-256 of chunk_text (증분 갱신용)
  created_at    TIMESTAMP DEFAULT NOW() NOT NULL
);

-- 벡터 유사도 검색용 인덱스 (cosine distance)
CREATE INDEX chunk_embeddings_vec_idx
  ON chunk_embeddings
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- 위키 필터링용 인덱스
CREATE INDEX chunk_embeddings_wiki_idx
  ON chunk_embeddings (wiki_id);

-- 권한 필터링용 부분 인덱스
CREATE INDEX chunk_embeddings_sensitive_idx
  ON chunk_embeddings (wiki_id)
  WHERE sensitive = FALSE;
```

### 3.2 Drizzle 스키마

```typescript
// lib/db/schema.ts (추가)
import { pgTable, text, integer, boolean, jsonb, timestamp } from 'drizzle-orm/pg-core';
import { vector } from 'drizzle-orm/pg-core';

export const chunkEmbeddings = pgTable('chunk_embeddings', {
  id:          text('id').primaryKey(),
  wikiId:      text('wiki_id').notNull(),
  pageType:    text('page_type').notNull(),
  pageId:      text('page_id').notNull(),
  chunkIdx:    integer('chunk_idx').notNull(),
  chunkText:   text('chunk_text').notNull(),
  embedding:   vector('embedding', { dimensions: 1024 }).notNull(),
  sensitive:   boolean('sensitive').default(false).notNull(),
  metadata:    jsonb('metadata'),
  contentHash: text('content_hash').notNull(),
  createdAt:   timestamp('created_at').defaultNow().notNull(),
});
```

### 3.3 AgentConfig 확장

```typescript
// lib/agents/types.ts (기존 인터페이스에 1줄 추가)
export interface AgentConfig {
  id: string;
  name: string;
  type: AgentType;
  dataFile: string;
  enabled: boolean;
  keywords: string[];
  sensitiveTopics: string[];
  description: string;
  alwaysContext?: boolean;
  adminOnly?: boolean;
  lensPersona?: boolean;
  personaId?: string;
  displayName?: string;
  ragEnabled?: boolean;   // 🆕 true면 하이브리드 RAG, false/undefined면 키워드만
}
```

### 3.4 lib/embed/types.ts (신규)

```typescript
// lib/embed/types.ts
export interface ChunkMetadata {
  title: string;
  pageType: 'source' | 'fact' | 'stance' | 'overview' | 'topic' | 'entity';
  // 페이지 타입별 보강
  topic?: string;        // stance, topic
  holder?: string;       // stance
  category?: string;     // fact
  yearsCovered?: string; // fact
  편?: string;          // overview
  date?: string;         // source
}

export interface EmbeddingChunk {
  id: string;                  // {wikiId}:{pageType}:{pageId}:{chunkIdx}
  wikiId: string;
  pageType: ChunkMetadata['pageType'];
  pageId: string;
  chunkIdx: number;
  chunkText: string;
  embedding: number[];         // 1024차원
  sensitive: boolean;
  metadata: ChunkMetadata;
  contentHash: string;
}

export interface VectorSearchResult {
  id: string;
  pageId: string;
  pageType: ChunkMetadata['pageType'];
  chunkText: string;
  distance: number;          // cosine distance (0 = 완전 같음, 2 = 정반대)
  similarity: number;        // 1 - distance / 2 (0~1로 정규화)
  metadata: ChunkMetadata;
}

// WikiAgent의 기존 청크 결과와 호환되는 인터페이스
export interface KeywordRankedChunk {
  type: 'source' | 'fact' | 'stance' | 'overview';
  id: string;                // page id
  title: string;
  chunk: string;
  score: number;
  // 기타 wiki-agent.ts의 chunk 객체 필드
  [key: string]: unknown;
}
```

---

## 4. Module Specs (lib/embed/*)

### 4.1 voyage.ts — Voyage API 클라이언트

**책임**: Voyage 3 multilingual 호출, 배치, 재시도, 토큰 제한 처리.

```typescript
// lib/embed/voyage.ts
const VOYAGE_API_URL = 'https://api.voyageai.com/v1/embeddings';
const MODEL = 'voyage-3';            // multilingual 통합 모델
const MAX_BATCH = 128;               // Voyage 권장 배치 크기
const MAX_RETRY = 3;
const DIMS = 1024;

export interface VoyageRequest {
  texts: string[];                   // 최대 128개
  inputType: 'document' | 'query';   // document = 임베딩 빌드, query = 검색 시
}

export async function embed(req: VoyageRequest): Promise<number[][]> {
  // 1. 입력 토큰 길이 체크 (Voyage 16K 토큰 한도)
  // 2. fetch with retry (exponential backoff)
  // 3. 응답 파싱 → number[][] 반환
  // 4. 차원 검증 (== 1024)
}

export async function embedBatched(
  texts: string[],
  inputType: 'document' | 'query' = 'document'
): Promise<number[][]> {
  // 128개씩 슬라이스 → 순차 호출 (rate limit 보호)
  // 진행 상황 console.log
}
```

**비용 추정** (finance 위키 기준):
- source 26개 × 평균 5청크 = 130 청크
- fact 7개 + topic 11개 + entity 4개 = 22 청크
- 총 ~152 청크 × 평균 800 토큰 = ~122K 토큰
- Voyage 3 가격: ~$0.06/1M 토큰 → **약 $0.007 (1센트 미만)**

### 4.2 chunker.ts — 페이지 타입별 임베딩 단위 변환

**책임**: `data/{wikiId}.json`을 읽어 임베딩 단위 청크 배열로 변환.

```typescript
// lib/embed/chunker.ts
import { splitIntoChunks } from '@/lib/agents/wiki-agent';   // 기존 함수 재사용
import type { WikiData } from '@/lib/agents/types';
import type { EmbeddingChunk, ChunkMetadata } from './types';
import crypto from 'crypto';

export function chunkifyWiki(wikiData: WikiData): EmbeddingChunk[] {
  const chunks: EmbeddingChunk[] = [];

  // source: 기존 ## 헤더 분할 재사용
  for (const source of wikiData.sources) {
    const parts = splitIntoChunks(source.content);
    parts.forEach((text, idx) => {
      chunks.push({
        id: `${wikiData.id}:source:${source.id}:${idx}`,
        wikiId: wikiData.id,
        pageType: 'source',
        pageId: source.id,
        chunkIdx: idx,
        chunkText: text,
        embedding: [],                         // 빌드 단계에서 채움
        sensitive: source.sensitive,
        metadata: {
          title: source.title,
          pageType: 'source',
          date: source.date,
        },
        contentHash: sha256(text),
      });
    });
  }

  // fact / stance / overview / topic / entity: 통째 1청크
  for (const f of (wikiData.facts ?? [])) {
    chunks.push({
      id: `${wikiData.id}:fact:${f.id}:0`,
      wikiId: wikiData.id,
      pageType: 'fact',
      pageId: f.id,
      chunkIdx: 0,
      chunkText: `${f.title}\n카테고리: ${f.category}\n${f.content}`,
      embedding: [],
      sensitive: f.sensitive,
      metadata: {
        title: f.title,
        pageType: 'fact',
        category: f.category,
        yearsCovered: f.yearsCovered,
      },
      contentHash: sha256(f.content),
    });
  }

  for (const s of (wikiData.stances ?? [])) {
    chunks.push({
      id: `${wikiData.id}:stance:${s.id}:0`,
      wikiId: wikiData.id,
      pageType: 'stance',
      pageId: s.id,
      chunkIdx: 0,
      chunkText: `${s.title}\n발언자: ${s.holder}\n주제: ${s.topic}\n${s.content}`,
      embedding: [],
      sensitive: s.sensitive,
      metadata: {
        title: s.title,
        pageType: 'stance',
        holder: s.holder,
        topic: s.topic,
      },
      contentHash: sha256(s.content),
    });
  }

  for (const o of (wikiData.overviews ?? [])) {
    chunks.push({
      id: `${wikiData.id}:overview:${o.id}:0`,
      wikiId: wikiData.id,
      pageType: 'overview',
      pageId: o.id,
      chunkIdx: 0,
      chunkText: `${o.title}\n편: ${o.편}\n${o.content}`,
      embedding: [],
      sensitive: o.sensitive,
      metadata: { title: o.title, pageType: 'overview', 편: o.편 },
      contentHash: sha256(o.content),
    });
  }

  // topic, entity는 본문이 짧으므로 통째
  for (const t of wikiData.topics) {
    if (!t.content.trim()) continue;
    chunks.push({
      id: `${wikiData.id}:topic:${t.id}:0`,
      wikiId: wikiData.id,
      pageType: 'topic',
      pageId: t.id,
      chunkIdx: 0,
      chunkText: `${t.name}\n${t.content}`,
      embedding: [],
      sensitive: false,
      metadata: { title: t.name, pageType: 'topic', topic: t.name },
      contentHash: sha256(t.content),
    });
  }

  for (const e of wikiData.entities) {
    if (!e.content.trim()) continue;
    chunks.push({
      id: `${wikiData.id}:entity:${e.id}:0`,
      wikiId: wikiData.id,
      pageType: 'entity',
      pageId: e.id,
      chunkIdx: 0,
      chunkText: `${e.name}\n별칭: ${e.aliases.join(', ')}\n${e.content}`,
      embedding: [],
      sensitive: false,
      metadata: { title: e.name, pageType: 'entity' },
      contentHash: sha256(e.content),
    });
  }

  return chunks;
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}
```

### 4.3 search.ts — pgvector top-K 검색

**책임**: 쿼리를 임베딩 후 `chunk_embeddings`에서 가까운 청크 top-K 반환. 권한·위키 필터 포함.

```typescript
// lib/embed/search.ts
import { db } from '@/lib/db/client';
import { embed } from './voyage';
import { canAccessSensitive } from '@/lib/auth/roles';
import type { Role } from '@/lib/auth/roles';
import type { VectorSearchResult, ChunkMetadata } from './types';
import { sql } from 'drizzle-orm';

const DEFAULT_K = 30;

export async function searchVector(
  query: string,
  wikiId: string,
  userRole: Role,
  k: number = DEFAULT_K,
): Promise<VectorSearchResult[]> {
  // 1. 쿼리 임베딩 (Voyage inputType: 'query')
  const [queryEmbed] = await embed({ texts: [query], inputType: 'query' });

  // 2. pgvector 쿼리 (cosine distance + 권한 필터)
  const sensitiveAllowed = canAccessSensitive(userRole);
  const embeddingLiteral = `[${queryEmbed.join(',')}]`;

  const rows = await db.execute<{
    id: string;
    page_id: string;
    page_type: string;
    chunk_text: string;
    metadata: ChunkMetadata;
    distance: number;
  }>(sql`
    SELECT id, page_id, page_type, chunk_text, metadata,
           embedding <=> ${embeddingLiteral}::vector AS distance
    FROM chunk_embeddings
    WHERE wiki_id = ${wikiId}
      AND (${sensitiveAllowed} OR sensitive = FALSE)
    ORDER BY embedding <=> ${embeddingLiteral}::vector
    LIMIT ${k}
  `);

  // 3. 정규화 + 매핑
  return rows.rows.map(r => ({
    id: r.id,
    pageId: r.page_id,
    pageType: r.page_type as ChunkMetadata['pageType'],
    chunkText: r.chunk_text,
    distance: Number(r.distance),
    similarity: 1 - Number(r.distance) / 2,
    metadata: r.metadata,
  }));
}
```

### 4.4 rrf.ts — RRF 융합

**책임**: 키워드 순위와 벡터 순위를 RRF로 결합. 순수 함수, 외부 의존성 0.

```typescript
// lib/embed/rrf.ts
import type { KeywordRankedChunk, VectorSearchResult } from './types';

const DEFAULT_K = 60;

export interface RRFOptions {
  k?: number;        // RRF 상수 (작은 차이 흡수, 기본 60)
  limit?: number;    // 최종 반환 개수
}

export function rrfFuse(
  keywordRanked: KeywordRankedChunk[],
  vectorRanked: VectorSearchResult[],
  opts: RRFOptions = {},
): KeywordRankedChunk[] {
  const { k = DEFAULT_K, limit = 30 } = opts;

  // 1. 키워드 결과: 페이지 ID 기준 순위 매핑
  const keywordRankMap = new Map<string, number>();
  keywordRanked.forEach((c, i) => {
    const key = `${c.type}:${c.id}`;
    if (!keywordRankMap.has(key)) keywordRankMap.set(key, i + 1);
  });

  // 2. 벡터 결과: 같은 형식으로 매핑
  const vectorRankMap = new Map<string, number>();
  vectorRanked.forEach((r, i) => {
    const key = `${r.pageType}:${r.pageId}`;
    if (!vectorRankMap.has(key)) vectorRankMap.set(key, i + 1);
  });

  // 3. union 키 + RRF 점수 계산
  const allKeys = new Set([...keywordRankMap.keys(), ...vectorRankMap.keys()]);
  const fused: { key: string; rrfScore: number; }[] = [];

  for (const key of allKeys) {
    const kr = keywordRankMap.get(key);
    const vr = vectorRankMap.get(key);
    const score =
      (kr ? 1 / (k + kr) : 0) +
      (vr ? 1 / (k + vr) : 0);
    fused.push({ key, rrfScore: score });
  }

  // 4. 정렬 후 limit
  fused.sort((a, b) => b.rrfScore - a.rrfScore);
  const topKeys = new Set(fused.slice(0, limit).map(f => f.key));

  // 5. 원본 키워드 청크 객체에서 top 선택 (없으면 벡터 결과를 KeywordRankedChunk 형태로 변환)
  const keywordIndex = new Map<string, KeywordRankedChunk>();
  keywordRanked.forEach(c => keywordIndex.set(`${c.type}:${c.id}`, c));

  const result: KeywordRankedChunk[] = [];
  for (const f of fused.slice(0, limit)) {
    const existing = keywordIndex.get(f.key);
    if (existing) {
      result.push({ ...existing, score: f.rrfScore });
    } else {
      // 벡터에서만 잡힌 청크 → 키워드 결과 형태로 변환
      const vr = vectorRanked.find(v => `${v.pageType}:${v.pageId}` === f.key);
      if (vr) {
        result.push({
          type: vr.pageType as 'source' | 'fact' | 'stance' | 'overview',
          id: vr.pageId,
          title: vr.metadata.title,
          chunk: vr.chunkText,
          score: f.rrfScore,
          source: 'vector-only',     // 디버그용 마커
        });
      }
    }
  }

  return result;
}
```

---

## 5. WikiAgent 통합 (단일 지점)

**위치**: [lib/agents/wiki-agent.ts](../../lib/agents/wiki-agent.ts), `getContext()` 함수 내부.
**삽입 지점**: 청크 스코어링 완료 후, 소스 커버리지 균등화 *직전*.

```typescript
// lib/agents/wiki-agent.ts (기존 코드에 ~30줄만 추가)

import { searchVector } from '@/lib/embed/search';
import { rrfFuse } from '@/lib/embed/rrf';

export class WikiAgent implements AgentPlugin {
  // ... 기존 코드 (변경 없음)

  async getContext(
    query: string,
    userRole: Role,
    isGlobal = false,
    options: GetContextOptions = {},
  ): Promise<AgentContext> {
    // [기존] 1~6단계: 데이터 로드, 권한 필터, entity 역참조,
    //                source 단위 점수, source 청크 점수, 신규 타입 점수
    // ↓ (변경 없음)
    
    // ─── [기존] 5번 끝 — scoredChunks, labeledItems 완성 시점 ───

    // 🆕 ─── 신규 RAG 통합 (단일 지점, ~30줄) ─────────────────
    let allKeywordChunks: KeywordRankedChunk[] = [
      ...scoredChunks,
      ...labeledItems,
    ];

    if (this.config.ragEnabled) {
      try {
        const vectorTop = await searchVector(query, this.config.id, userRole, 30);
        allKeywordChunks = rrfFuse(allKeywordChunks, vectorTop, { k: 60, limit: 30 });

        if (process.env.RAG_DEBUG === 'true') {
          console.log(`[RAG ${this.config.id}] kw:${scoredChunks.length}+${labeledItems.length} vec:${vectorTop.length} → fused:${allKeywordChunks.length}`);
        }
      } catch (err) {
        // 🔒 Fallback: 벡터 검색 실패해도 키워드 결과로 계속 진행
        console.error(`[RAG ${this.config.id}] vector search failed, falling back to keyword-only`, err);
      }
    }
    // 🆕 ─── 신규 끝 ────────────────────────────────────────

    // [기존] 7단계 이후: 소스 커버리지 균등화, chunk cap, entity 블록, 출력 포맷
    // ↓ allKeywordChunks를 입력으로 받음
    // ↓ (변경 없음)
  }
}
```

**핵심 보장**:
- `ragEnabled !== true`면 기존 라인 *1줄도 변경 없음*
- 벡터 검색 실패 시 키워드 결과 그대로 fallback (try/catch)
- 후속 로직(균등화·cap·confidence)은 그대로 작동

---

## 6. Sequence Diagram — 쿼리 처리 흐름 (finance, ragEnabled=true)

```
사용자: "대학원생 장학금 10년"
    │
    ↓
[API /api/chat]
    │ Zod 검증, 권한 가드 (기존)
    ↓
[routeQuery] (lib/agents/router.ts — 변경 없음)
    │ 키워드 매칭 + concept-index → [finance, plan, vision, status]
    ↓
[병렬] WikiAgent.getContext × 4
    │
    ├─→ senate.getContext()        (ragEnabled: undefined → 키워드만)
    │       └─→ 기존 흐름 그대로
    │
    ├─→ plan.getContext()          (ragEnabled: undefined → 키워드만)
    │       └─→ 기존 흐름 그대로
    │
    ├─→ status.getContext()        (alwaysContext, ragEnabled: undefined)
    │       └─→ 기존 흐름 그대로
    │
    └─→ finance.getContext()       (ragEnabled: true) ★
            │
            ├─ 1-6단계: 기존 키워드 스코어링 (변경 없음)
            │    → scoredChunks: 15개
            │    → labeledItems: 5개
            │
            ├─ 🆕 RAG 단계:
            │    │
            │    ├─→ searchVector("대학원생 장학금 10년", "finance", role, 30)
            │    │     │
            │    │     ├─→ embed(query, inputType='query')   [Voyage API ~50ms]
            │    │     │     → 1024차원 벡터
            │    │     │
            │    │     └─→ pgvector 쿼리 (wiki_id='finance', sensitive 필터)
            │    │           [~10-50ms]
            │    │           → vectorTop: 30개 청크
            │    │             (학생경비 청크 ★, 학문후속세대 청크 ★,
            │    │              예산-세출 대학원 청크 ★, ...)
            │    │
            │    └─→ rrfFuse(allKeyword[20], vectorTop[30], k=60, limit=30)
            │          → fused: 30개 (양쪽 잡힌 청크 부스트)
            │            • 키워드 0점이었던 학생경비 청크가 상위 진입 ★
            │
            └─ 7+단계: 소스 커버리지 균등화 → chunk cap → 출력 (변경 없음)
            
    ↓
[buildSystemPrompt + buildUserMessage] (변경 없음)
    ↓
[Claude] (변경 없음)
    │ "학생경비 1,203→1,605억 (+33%), 학문후속세대 지원금 인상..."
    ↓
사용자 화면
```

**시간 추가**:
- finance 단일 위키 RAG 호출: Voyage API ~50ms + pgvector ~30ms = **~80ms 추가**
- 다른 3개 위키와 병렬 → 전체 라우팅 시간 영향 적음 (병렬 최대값)

---

## 7. Error Handling — 다층 Fallback

### 7.1 단계별 실패 처리

| 실패 지점 | Fallback | 사용자 경험 |
|---------|---------|----------|
| Voyage API 다운 | try/catch → 키워드 결과만 사용 | RAG 효과 일시 손실, 답변은 작동 |
| pgvector 쿼리 타임아웃 | 5초 후 abort → 키워드만 | RAG 효과 일시 손실, 답변은 작동 |
| `chunk_embeddings` 테이블 비어있음 | 벡터 결과 0개 → 키워드만 | 같음 |
| 임베딩 차원 불일치 | 빌드 시 검증, 검색 시 길이 체크 | 빌드 단계에서 차단 |
| DB 연결 실패 | DB 자체가 죽으면 전체 시스템 실패 | 기존 동작과 동일 (대화 저장도 실패) |
| Voyage 토큰 한도 초과 | 청크 자동 분할 후 재시도 | 빌드 단계만 영향, 검색 영향 없음 |

### 7.2 RAG_DEBUG 환경변수

```bash
# .env.local
RAG_DEBUG=true   # WikiAgent에서 RAG 융합 로그 출력
```

출력 예시:
```
[RAG finance] kw:15+5 vec:30 → fused:30 (vec-only: 8)
```

→ 벡터로만 잡힌 8개 청크가 새로 들어옴을 확인.

---

## 8. Test Plan

### 8.1 단위 테스트 (선택, 시간 여유 시)

`lib/embed/rrf.ts`는 순수 함수 → 단위 테스트 작성 권장:

```typescript
// tests/embed/rrf.test.ts
test('RRF prefers chunks in both lists', () => {
  const keyword = [{ type:'fact', id:'a', score:5 }, { type:'fact', id:'b', score:3 }];
  const vector  = [{ pageType:'fact', pageId:'a', ... }, { pageType:'fact', pageId:'c', ... }];
  const fused = rrfFuse(keyword, vector);
  expect(fused[0].id).toBe('a');  // 양쪽 모두 잡힌 청크
});
```

### 8.2 통합 테스트 — Golden Q&A 자동 비교 (필수)

```typescript
// scripts/golden-qa.ts
const GOLDEN_QUESTIONS = [
  // 회귀 20개
  { id: 'r01', query: '2024년 운영수익 얼마야?', mustInclude: ['21,438'] },
  { id: 'r02', query: '2020~2024 인건비 추이', mustInclude: ['7,788', '9,777'] },
  // ... 20개 정의
  
  // 갭 사례 5개
  { id: 'g01', query: '대학원생 장학금이 최근 10년 사이에 증가했어?',
    mustInclude: ['학생경비', '1,203', '1,605'],
    mustNotInclude: ['자료가 포함되어 있지 않', '확인이 어렵'] },
  { id: 'g02', query: '강사료 변천 보여줘',
    mustInclude: ['강사법', '방학'] },
  // ...
];

async function run() {
  for (const q of GOLDEN_QUESTIONS) {
    // 1. RAG OFF 로 답변 받기
    // 2. RAG ON 으로 답변 받기
    // 3. mustInclude 모두 포함? mustNotInclude 모두 미포함?
    // 4. 결과 표 출력 (RAG OFF 통과/실패, RAG ON 통과/실패, 변화)
  }
}
```

**합격 기준**:
- 회귀 그룹 1-20: RAG ON 통과 ≥18 (90%)
- 갭 그룹 g01-g05: RAG ON 통과 ≥3 (60%)
- 토큰 변화: input ±10% 이내

### 8.3 수동 검증

도훈민 본인이 PoC 완료 후 챗 UI에서 직접 확인:
- "대학원생 장학금이 최근 10년 사이에 증가했어?" → 풍부한 답변 받는지
- "AI 가이드라인 평의원회 의결" → 기존과 동등하게 답하는지 (senate 위키, RAG OFF)
- "이사회 시흥 캠퍼스 입장" → 기존과 동등 (board 위키, RAG OFF)

---

## 9. Security — 권한 다층 방어 유지

### 9.1 4중 방어 체계 (기존 3중 → 신규 4중으로 강화)

| Layer | 위치 | 동작 |
|------|------|------|
| **L1 미들웨어** | [middleware.ts:25-35](../../../middleware.ts#L25-L35) | 라우트 진입 차단 (변경 없음) |
| **L2 API 가드** | [chat/route.ts:32,46](../../../app/api/chat/route.ts#L32) | mode·role 검증 (변경 없음) |
| **L3 라우터** | [router.ts:98-104](../../../lib/agents/router.ts#L98-L104) | adminOnly 위키는 비admin 제외 (변경 없음) |
| **L4 데이터** | [wiki-agent.ts:108](../../../lib/agents/wiki-agent.ts#L108) | sensitive source 필터 (변경 없음) |
| **🆕 L4'** | `lib/embed/search.ts` | pgvector 쿼리에 `wiki_id IN` + `sensitive` 필터 |

### 9.2 leesj (adminOnly + lensPersona) 처리

```typescript
// PoC 단계에서는 finance만 ragEnabled=true이므로 leesj는 영향 없음.
// Phase B에서 leesj도 임베딩한다면:

// 1. build-embeddings.ts: adminOnly 위키는 별도 플래그 필요
//    또는 sensitive=true 처리하여 일반 사용자에게 노출 차단

// 2. searchVector: 라우터가 이미 leesj를 비admin에게 제외했으므로
//    wiki_id IN 필터에 leesj가 포함되지 않음 → 자동 안전
```

### 9.3 검증 항목

- [ ] tier2 사용자로 finance 쿼리 시: `sensitive=true` 청크가 응답에 나오는가? (없어야 함)
- [ ] 비admin 사용자로 lens 모드 시도 → 차단되는가? (기존 동작 유지)
- [ ] DB 쿼리 로그에 SQL injection 가능 패턴 없는가? (Drizzle 파라미터 바인딩)

---

## 10. Performance

### 10.1 추가 지연 분석

| 단계 | 시간 | 비고 |
|------|-----:|------|
| Voyage embed (query) | ~50ms | 단일 쿼리, 16K 토큰 한도 |
| pgvector cosine search | ~20-50ms | ivfflat 인덱스, 100 리스트 |
| RRF 융합 (순수 JS) | <1ms | 30개 청크 |
| **추가 지연** | **~80ms** | finance 1개 위키 기준 |

병렬 호출이므로 전체 라우팅 시간 = max(개별 시간). RAG-ON 위키 1개일 때 영향 최소.

### 10.2 비용 분석 (PoC, finance만)

| 항목 | 1회성 | 운영 |
|------|------:|-----:|
| 임베딩 빌드 (~150 청크) | ~$0.01 | — |
| 쿼리당 임베딩 | — | ~$0.0001 |
| pgvector 스토리지 | — | 무료 (Vercel Postgres 한도 내) |
| **PoC 1주일 예상 비용** | $0.01 | ~$0.10 (1,000회 쿼리) |

### 10.3 Phase B (9개 위키) 추정

- 임베딩 빌드: 9 위키 × 평균 150청크 = ~1,350청크 → ~$0.10
- 운영 쿼리: 동일 ~$0.0001/쿼리 (배치 없으므로)
- 스토리지: 1,350 × 1024 × 4B = ~5.5MB (Postgres 한도 내 무난)

---

## 11. Implementation Guide

### 11.1 변경 파일 목록

| 파일 | 변경 유형 | 라인 추가 | Module |
|------|---------|--------:|:------:|
| `drizzle/0xxx_pgvector.sql` | 🆕 신규 | ~30 | module-1 |
| `lib/db/schema.ts` | 수정 | ~15 | module-1 |
| `lib/agents/types.ts` | 수정 | 1 | module-1 |
| `data/agents.config.json` | 수정 | 1 | module-1 |
| `package.json` | 수정 | 2 | module-1 |
| `.env.local` | 수정 | 1 | module-1 |
| `lib/embed/types.ts` | 🆕 신규 | ~50 | module-2 |
| `lib/embed/voyage.ts` | 🆕 신규 | ~80 | module-2 |
| `lib/embed/chunker.ts` | 🆕 신규 | ~120 | module-2 |
| `scripts/build-embeddings.ts` | 🆕 신규 | ~100 | module-3 |
| `lib/embed/search.ts` | 🆕 신규 | ~60 | module-4 |
| `lib/embed/rrf.ts` | 🆕 신규 | ~70 | module-4 |
| `lib/agents/wiki-agent.ts` | 수정 | ~30 (단일 지점) | module-4 |
| `scripts/golden-qa.ts` | 🆕 신규 | ~150 | module-5 |
| `scripts/build-wiki-data.ts` | 수정 | ~15 | module-6 |

**합계**: 신규 9개 파일, 수정 6개 파일, 총 ~725줄.

### 11.2 구현 순서

```
Day 1: module-1 (인프라)
  ├─ pgvector extension 설치
  ├─ chunk_embeddings 테이블 마이그레이션
  ├─ Drizzle schema 정의
  ├─ AgentConfig.ragEnabled 추가
  ├─ Voyage API 키 발급 + .env.local
  └─ 검증: npm run db:migrate 무에러
  
Day 2-3: module-2 (임베딩 모듈)
  ├─ lib/embed/types.ts 인터페이스 정의
  ├─ lib/embed/voyage.ts 구현 + 배치·재시도
  ├─ lib/embed/chunker.ts 페이지 타입별 변환
  └─ 검증: 더미 텍스트 5개 임베딩 → 1024차원 반환 확인
  
Day 3: module-3 (빌드 스크립트)
  ├─ scripts/build-embeddings.ts {wikiId}
  ├─ 진행률 출력, content_hash 기반 UPSERT
  └─ 검증: npx tsx scripts/build-embeddings.ts finance
            → DB row 수 ≥ 청크 수 확인, 비용 출력
  
Day 4: module-4 (검색 + RRF + 통합) ★ 핵심
  ├─ lib/embed/search.ts pgvector 쿼리
  ├─ lib/embed/rrf.ts RRF 융합 (순수 함수)
  ├─ wiki-agent.ts에 30줄 통합 (try/catch fallback 포함)
  ├─ data/agents.config.json finance: ragEnabled=true
  └─ 검증: 챗 UI에서 "대학원생 장학금 10년" 질문 직접 테스트
  
Day 5: module-5 (회귀 자동 검증)
  ├─ scripts/golden-qa.ts 25개 질문 정의
  ├─ RAG OFF vs ON 자동 비교
  ├─ 결과 리포트 생성 (CSV + 마크다운)
  └─ 검증: 회귀 ≥18/20, 갭 ≥3/5
  
Day 6: module-6 (파이프라인 통합) + 결과 정리
  ├─ scripts/build-wiki-data.ts에 ragEnabled 위키 임베딩 트리거
  ├─ Vercel 배포
  ├─ 프로덕션 검증
  └─ PoC 보고서 작성 (다음 단계 청사진)
```

### 11.3 Session Guide — Module Map (--scope 지원)

PDCA Do 단계를 `--scope` 옵션으로 분할 실행 가능:

| Module | 파일 | 추정 시간 | 의존성 |
|:------:|------|--------:|:------:|
| **module-1** | DB infra: schema.ts, agents.config.json, types.ts, env, pgvector SQL | 0.5-1일 | — |
| **module-2** | lib/embed/: types.ts, voyage.ts, chunker.ts | 1-1.5일 | module-1 |
| **module-3** | scripts/build-embeddings.ts | 0.5일 | module-2 |
| **module-4** | lib/embed/search.ts, rrf.ts + wiki-agent.ts 통합 ★ | 1.5일 | module-3 |
| **module-5** | scripts/golden-qa.ts 자동 검증 | 1일 | module-4 |
| **module-6** | build-wiki-data.ts 통합 + Vercel 배포 | 0.5일 | module-4 |

**권장 세션 분할**:
- **Session 1**: `--scope module-1,module-2` (인프라 + 임베딩 모듈, 1.5-2일)
- **Session 2**: `--scope module-3` (빌드 스크립트, 0.5일)
- **Session 3**: `--scope module-4` ★ (검색 통합 핵심, 1.5일) — 별도 세션 권장
- **Session 4**: `--scope module-5,module-6` (검증 + 파이프라인, 1.5일)

```bash
/pdca do hybrid-rag --scope module-1,module-2
/pdca do hybrid-rag --scope module-3
/pdca do hybrid-rag --scope module-4
/pdca do hybrid-rag --scope module-5,module-6
```

---

## 12. Risks & Open Questions

| 항목 | 영향 | 완화 / 후속 결정 |
|------|:---:|---------------|
| Drizzle ORM의 pgvector 지원 버전 호환 | 중 | drizzle-orm `^0.36.0` (현재) — pgvector 지원 확인 필요. 없으면 raw SQL 사용 |
| Vercel Postgres에 pgvector extension 가능한지 | 고 | Vercel 콘솔 또는 Neon 백엔드에서 `CREATE EXTENSION vector;` 실행 가능 (Neon은 공식 지원) |
| Voyage API rate limit (PoC 빌드 시) | 저 | finance 150청크 × 1회 = rate limit 무관 |
| 임베딩 텍스트에 메타데이터 prefix 효과 | 중 | "카테고리: 재무\n..." 같은 prefix가 의미 검색 품질 향상 → A/B 실험 가능 |
| RRF k=60 기본값 적절성 | 저 | 업계 표준값. Golden Q&A 결과 보고 30/120 등 튜닝 |
| ivfflat 인덱스 lists=100 적절성 | 저 | 청크 수 1,000 미만이면 lists=10 권장. PoC 후 튜닝 |
| query embedding 캐싱 여부 | 저 | 같은 쿼리 짧은 시간 반복 시 캐싱 효과. Phase B에서 검토 |

---

## 13. Definition of Done

PoC 종료 기준:

- [ ] `chunk_embeddings` 테이블 생성, pgvector 작동
- [ ] finance 위키 전체 청크 임베딩 완료 (~150 row)
- [ ] WikiAgent의 finance 호출 시 RAG 융합 작동 (RAG_DEBUG 로그로 확인)
- [ ] 갭 사례 "대학원생 장학금 10년" 질문에 학생경비 시계열 인용 답변
- [ ] Golden Q&A 자동 비교: 회귀 ≥18/20, 갭 ≥3/5
- [ ] Vercel 프로덕션 배포 작동
- [ ] 다른 8개 위키 회귀 없음 (랜덤 5개 쿼리 수동 확인)
- [ ] PoC 보고서 작성 (Phase B-D 청사진 포함)

---

## 14. 다음 단계

```
/pdca do hybrid-rag --scope module-1,module-2   # Session 1: 인프라 + 임베딩 모듈
```

또는 전체 한 번에:

```
/pdca do hybrid-rag                              # 전체 6일치 진행
```

---

## 14.5 Phase B Additions (2026-05-19)

PoC 검증 후 Phase B 진입 시 사용자 결정으로 다음 추가됨. 본 Design §1.2 "변경 X" 4개 영역 중 **router.ts는 *additive*로 1개소 수정** (lens/prompts/middleware는 여전히 무변경).

### 14.5.1 8개 위키 전체 임베딩
- `data/agents.config.json` 8개 위키 `ragEnabled: true` (leesj 제외 — Phase C에서 lens-specific 처리)
- `scripts/build-embeddings.ts --all-rag-enabled` → 1,021 청크 임베딩 (4분, $0)
- 위키별: senate(289), board(182), plan(134), vision(77), history(85), status(13), yhl-speeches(75), finance(166)

### 14.5.2 Semantic Routing — `lib/embed/search.ts:semanticRoutingHints()`
- 쿼리 임베딩 → cross-wiki pgvector 검색 (wiki_id 필터 없이)
- GROUP BY wiki_id + MIN(distance) → 위키별 최소 거리
- **Tiered thresholds**:
  - `absoluteMax = 1.0` — top-1 위키는 이 안이면 무조건 포함 (약한 매칭이라도 살림)
  - `tightMax = 0.85` — top-2 ~ top-5는 이 안만 (명확한 의미 매칭만 추가)
- 효과: "장학금"·"강사료" 같이 위키 도메인 어휘와 사용자 어휘가 다른 케이스에서 자동 매칭
- 실측 distance 분포: 0.6-0.8(강한 매칭), 0.95+(노이즈) → 임계값 충분히 보수적

### 14.5.3 Router 통합 — `lib/agents/router.ts`
```typescript
const [conceptResult, semanticHints] = await Promise.all([
  Promise.resolve(lookupConceptIndex(queryWords)),
  semanticRoutingHints(query, userRole, { topK: 50, maxWikis: 5, absoluteMax: 1.0, tightMax: 0.85 }),
]);
const forcedWikis = new Set<string>();
for (const w of conceptResult.forcedWikis) if (routableIds.has(w)) forcedWikis.add(w);
for (const w of semanticHints) if (routableIds.has(w)) forcedWikis.add(w);
```

### 14.5.4 Forced Wiki Cap Priority (버그 fix)
- **버그**: `scored.slice(0, MAX_WIKIS=6)`가 키워드 점수순으로 자르므로 SemRoute로 forced된 위키가 cap에서 누락 가능
- **수정**: `router.ts:152-172` — forced + alwaysContext 위키 먼저 cap 보존, 나머지가 빈 자리 채움
- 효과: SemRoute 추천이 최종 라우팅에 *반드시* 반영됨

### 14.5.5 Scholarship 도메인 동의어 (Phase B kickoff 시 추가)
- `data/concept-index.json`: 장학금 entry (aliases: 학생경비, 학문후속세대 지원금, 등록금 면제 등)
- `data/agents.config.json`: finance.keywords += [장학금, 학생경비, 학문후속세대, 대학원생 지원, 등록금 면제, 지원금]
- Defense in depth — concept-index와 semantic routing 둘 다 finance 끌어옴

### 14.5.6 검증 (5개 갭 쿼리)
| 쿼리 | 라우팅 결과 |
|------|----------|
| "강사료가 어떻게 변했어" | senate, board, history, status, **finance**, plan |
| "외국인 유치 노력" | history, plan, vision, status, yhl-speeches, **finance** |
| "교원 처우 개선 공약" | senate, board, status, vision, history, **finance** |
| "대학원생 장학금 10년" | vision, senate, **finance**, plan, history, status |
| "학생 1인당 지원금" | senate, history, vision, plan, **finance**, status |

→ 5/5 모두 finance 포함, RAG 발동.

---

## 15. 참고

- Plan: [docs/01-plan/features/hybrid-rag.plan.md](../../01-plan/features/hybrid-rag.plan.md)
- Voyage AI: https://docs.voyageai.com/docs/embeddings
- pgvector: https://github.com/pgvector/pgvector
- Drizzle pgvector: https://orm.drizzle.team/docs/column-types/pg#vector
- RRF 논문: Cormack et al. 2009 (Reciprocal Rank Fusion)
