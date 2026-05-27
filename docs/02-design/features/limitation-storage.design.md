# Design: Limitation Storage — Option C (Pragmatic) — Neon Postgres + pgvector ANN 증분

> **Feature**: limitation-storage
> **Date**: 2026-05-28
> **Phase**: Design
> **Plan Reference**: [docs/01-plan/features/limitation-storage.plan.md](../../01-plan/features/limitation-storage.plan.md)
> **Architecture**: Option C — Pragmatic (DB 저장 + ANN 증분 클러스터링 + 보정용 전체 재계산)

---

## 📌 Context Anchor (Plan에서 승계)

| 항목 | 내용 |
|---|---|
| **WHY** | 배포 환경 갱신 버튼이 EROFS(Vercel read-only fs). 파일 저장의 근본 한계 + 전체 메모리 클러스터링 비효율 |
| **WHO** | 관리자. DB는 Neon (chunk_embeddings 공유, 로컬/배포 동일 DB) |
| **RISK** | ANN 증분은 정밀 DBSCAN 근사(글로벌 재배치 부분 손실) / pgvector 마이그레이션 chunk_embeddings 영향 / 137건 시드 누락 / 지형도 전환 누락 |
| **SUCCESS** | 배포 갱신 EROFS 없음 / 137건 시드 / ANN≈메모리 결과 / 지형도 최신 / chunk_embeddings 무영향 |
| **SCOPE** | schema + 마이그레이션 / refresh.ts DB+ANN / cluster-ann.ts / API DB / seed / 지형도 빌드 DB |

---

## 1. Overview

### 1.1 핵심 원칙

> **"파일 → Neon DB. embedding은 pgvector 컬럼. 새 질문만 ANN으로 이웃 찾아 클러스터 할당(전체 N² 회피). 정밀도는 가끔 전체 재계산으로 보정."**

```
┌──────────────────────────────────────────────────────────────────────┐
│ 갱신 (로컬 npm run / 배포 Admin 버튼) — 둘 다 같은 Neon DB             │
│                                                                      │
│ refresh({ maxNew: N }):                                              │
│  1. 미처리 판정: messages(user) 중 limitation_questions에 없는 id     │
│  2. batch N개:                                                        │
│     a. Voyage 임베딩                                                  │
│     b. Sonnet 평가 (quality/wiki/limitation) + 답변서 발췌 추출       │
│     c. limitation_questions INSERT (embedding = pgvector)            │
│     d. ANN 증분 클러스터 할당 (§2.3):                                 │
│        embedding <=> e <= EPS 이웃 검색 → 클러스터 할당/생성/outlier  │
│     e. 변경된 클러스터만 Sonnet 라벨 → limitation_clusters UPSERT     │
│  3. hasMore = 미처리 질문 더 있나 → 클라 자동 재호출                  │
│                                                                      │
│  ※ DB write라 EROFS 없음. batch라 Vercel timeout 없음.               │
└──────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│ 읽기                                                                  │
│  - GET /api/admin/limitations → DB 쿼리 (cluster/outlier 그룹핑)      │
│  - 지형도 빌드(_make-standalone-map.mjs) → DB SELECT                  │
│                                                                      │
│ 보정 (선택/주기)                                                      │
│  - rebuildAllClusters(): 전체 embedding 로드 → 정밀 DBSCAN 1회 →      │
│    cluster_id 일괄 재배치 (ANN 증분 누적 오차 정리)                   │
└──────────────────────────────────────────────────────────────────────┘
```

### 1.2 변경 영향 범위

| 영역 | 변경 | 위험 |
|---|---|:---:|
| `lib/db/schema.ts` | `limitationQuestions` + `limitationClusters` 테이블 | 낮 (별도 테이블) |
| `drizzle/` 마이그레이션 | 테이블 + HNSW 인덱스 | 중 (pgvector, chunk_embeddings 격리 확인) |
| `lib/limitations/refresh.ts` | 파일 I/O → DB, ANN 할당 호출 | 중 (핵심 재작성) |
| `lib/limitations/cluster-ann.ts` | 신규 — ANN 증분 + rebuildAll 보정 | 중 |
| `lib/limitations/dbscan.ts` | rebuildAll에서 재사용 (메모리 정밀 DBSCAN) | 낮 (유지) |
| `app/api/admin/limitations/route.ts` | JSON → DB 쿼리 | 중 |
| `scripts/seed-limitations.ts` | 신규 (JSON → DB 일회성) | 낮 |
| `scripts/_make-standalone-map.mjs` | JSON → DB 읽기 | 중 |
| chunk_embeddings / hybrid-rag / LimitationsView UI | 무수정 | 없음 |

---

## 2. Module Specification

### 2.1 DB 스키마 (`lib/db/schema.ts`)

```ts
import { pgTable, text, timestamp, jsonb, integer, boolean, vector, real } from 'drizzle-orm/pg-core';

// 한계 답변 추적 질문 (limitation-tracking 데이터)
export const limitationQuestions = pgTable('limitation_questions', {
  id:            text('id').primaryKey(),                  // messages.id
  question:      text('question').notNull(),
  answer:        text('answer').notNull(),
  questionCreatedAt: timestamp('question_created_at').notNull(),
  routedAgents:  jsonb('routed_agents').$type<string[]>().default([]).notNull(),
  embedding:     vector('embedding', { dimensions: 1024 }).notNull(),

  // Sonnet 평가
  quality:       text('quality').notNull(),                // answered|partial|no_data
  wiki:          text('wiki').default('').notNull(),
  limitation:    boolean('limitation').default(false).notNull(),
  limitationExcerpt: text('limitation_excerpt').default('').notNull(),

  // DBSCAN
  clusterId:     integer('cluster_id').default(-1).notNull(),

  // 지식 지형도 호환 (PCA 2D)
  pcaX:          real('pca_x').default(0).notNull(),
  pcaY:          real('pca_y').default(0).notNull(),
  placementWiki: text('placement_wiki').default('').notNull(),

  evaluatedAt:   timestamp('evaluated_at').defaultNow().notNull(),
});

// 클러스터 라벨 캐시
export const limitationClusters = pgTable('limitation_clusters', {
  clusterId:  integer('cluster_id').primaryKey(),
  label:      text('label').notNull(),
  memberIds:  jsonb('member_ids').$type<string[]>().notNull(),  // 캐시 검증
  updatedAt:  timestamp('updated_at').defaultNow().notNull(),
});
```

**마이그레이션 주의**: `npm run db:generate`로 SQL 생성 후, HNSW 인덱스를 chunk_embeddings 패턴대로 추가:
```sql
CREATE INDEX limitation_questions_embedding_idx
  ON limitation_questions USING hnsw (embedding vector_cosine_ops);
```
chunk_embeddings는 건드리지 않음 (별도 테이블).

### 2.2 `lib/limitations/cluster-ann.ts` (신규)

```ts
// Design Ref: §2.3 — pgvector ANN 증분 클러스터 할당 + 전체 재계산 보정.

import { sql } from '@vercel/postgres';
import { dbscan } from './dbscan';

const EPS = 0.40;
const MIN_PTS = 2;

/**
 * 신규 질문 1개를 ANN 이웃 검색으로 클러스터 할당.
 * @returns 할당된 clusterId (-1 = outlier)
 */
export async function assignClusterANN(questionId: string, embedding: number[]): Promise<{
  clusterId: number;
  affectedClusterIds: number[];   // 라벨 재생성 필요한 클러스터
}> {
  const vec = `[${embedding.join(',')}]`;

  // eps 내 이웃 (자기 자신 제외) — search.ts 패턴
  const { rows: neighbors } = await sql`
    SELECT id, cluster_id, embedding <=> ${vec}::vector AS dist
    FROM limitation_questions
    WHERE id != ${questionId} AND embedding <=> ${vec}::vector <= ${EPS}
    ORDER BY dist
    LIMIT 50
  `;

  // minPts: 자기 포함 2 → 이웃 1개 이상
  if (neighbors.length < MIN_PTS - 1) {
    return { clusterId: -1, affectedClusterIds: [] };   // outlier
  }

  const neighborClusters = [...new Set(
    neighbors.map(n => Number(n.cluster_id)).filter(c => c >= 0)
  )];

  if (neighborClusters.length === 0) {
    // 모든 이웃이 outlier → 새 클러스터 생성, 이웃 outlier들도 승격
    const newId = await nextClusterId();
    const outlierNeighborIds = neighbors
      .filter(n => Number(n.cluster_id) === -1)
      .map(n => n.id as string);
    await sql`
      UPDATE limitation_questions SET cluster_id = ${newId}
      WHERE id = ANY(${[questionId, ...outlierNeighborIds]})
    `;
    return { clusterId: newId, affectedClusterIds: [newId] };
  }

  // 가장 가까운 이웃의 클러스터에 합류 (병합은 보정에서 처리 — 근사)
  const target = neighborClusters[0];  // neighbors가 dist 정렬이므로 첫 클러스터가 최근접
  await sql`UPDATE limitation_questions SET cluster_id = ${target} WHERE id = ${questionId}`;
  // 여러 클러스터에 걸친 경우 = 잠재 병합 지점. 즉시 병합 안 하고 affected로 표시(라벨 갱신).
  return { clusterId: target, affectedClusterIds: neighborClusters };
}

async function nextClusterId(): Promise<number> {
  const { rows } = await sql`SELECT COALESCE(MAX(cluster_id), -1) + 1 AS next FROM limitation_questions`;
  return Number(rows[0].next);
}

/**
 * 전체 재계산 보정 — ANN 증분 누적 오차 정리.
 * 전체 embedding 로드 → 메모리 정밀 DBSCAN → cluster_id 일괄 갱신.
 * 수동/주기 실행 (데이터 적어 비용 작음).
 */
export async function rebuildAllClusters(): Promise<{ clusters: number; outliers: number }> {
  const { rows } = await sql`SELECT id, embedding::text AS emb FROM limitation_questions ORDER BY question_created_at`;
  const ids = rows.map(r => r.id as string);
  const embeddings = rows.map(r => (r.emb as string).slice(1, -1).split(',').map(Number));
  const labels = dbscan(embeddings, EPS, MIN_PTS);   // 기존 메모리 DBSCAN 재사용
  // 일괄 UPDATE
  for (let i = 0; i < ids.length; i++) {
    await sql`UPDATE limitation_questions SET cluster_id = ${labels[i]} WHERE id = ${ids[i]}`;
  }
  const clusterSet = new Set(labels.filter(l => l >= 0));
  return { clusters: clusterSet.size, outliers: labels.filter(l => l === -1).length };
}
```

**근사 한계 (정직)**: 가장 가까운 클러스터 합류만 하고 **즉시 병합(merge) 안 함**. 신규 질문이 두 클러스터를 잇는 경우 정밀 DBSCAN은 병합하지만 ANN 증분은 한쪽에만 붙임. → `rebuildAllClusters()`로 주기 보정. 137건 규모에선 보정 비용 작음(전체 DBSCAN 수십 ms + UPDATE N회).

### 2.3 `lib/limitations/refresh.ts` (DB 버전)

기존 파일 I/O 제거, DB 기반으로:

```ts
export async function refresh({ maxNew = DEFAULT_BATCH_SIZE } = {}): Promise<RefreshResult> {
  // 1. 미처리 질문 — messages에 있고 limitation_questions에 없는 user 질문
  const { rows: newRows } = await sql`
    SELECT u.id, u.content AS question, a.content AS answer,
           u.created_at AS "createdAt", COALESCE(a.routed_agents,'{}') AS "routedAgents"
    FROM messages u
    JOIN messages a ON (a.conversation_id = u.conversation_id AND a.role='assistant'
      AND a.id = (SELECT id FROM messages WHERE conversation_id=u.conversation_id
                  AND role='assistant' AND created_at > u.created_at ORDER BY created_at LIMIT 1))
    WHERE u.role='user' AND LENGTH(u.content) > 5
      AND u.id NOT IN (SELECT id FROM limitation_questions)
    ORDER BY u.created_at ASC
    LIMIT ${maxNew + 1}
  `;
  const hasMore = newRows.length > maxNew;
  const batch = newRows.slice(0, maxNew);
  if (batch.length === 0) return { processed: 0, hasMore: false, ... };

  // 2. Voyage 임베딩 + Sonnet 평가 (기존 judgeOne/extractLimitationSentence 재사용)
  const embeddings = await voyageEmbed(batch.map(r => r.question));
  const judgements = await judgeAllWithConcurrency(batch);

  // 3. PCA 좌표 (proj.json 있으면)
  const proj = await loadProj();   // proj.json은 정적 — 읽기 OK (지형도용)
  const coords = proj ? projectToPCA(embeddings, proj) : embeddings.map(() => [0,0]);

  // 4. INSERT + ANN 클러스터 할당
  const affected = new Set<number>();
  for (let i = 0; i < batch.length; i++) {
    const r = batch[i], j = judgements[i];
    const vec = `[${embeddings[i].join(',')}]`;
    await sql`INSERT INTO limitation_questions
      (id, question, answer, question_created_at, routed_agents, embedding,
       quality, wiki, limitation, limitation_excerpt, cluster_id, pca_x, pca_y, placement_wiki)
      VALUES (${r.id}, ${r.question}, ${r.answer}, ${r.createdAt}, ${JSON.stringify(r.routedAgents)},
       ${vec}::vector, ${j.quality}, ${j.wiki}, ${j.limitation}, ${j.excerpt}, -1,
       ${coords[i][0]}, ${coords[i][1]}, ${j.wiki || r.routedAgents[0] || ''})`;
    const { clusterId, affectedClusterIds } = await assignClusterANN(r.id, embeddings[i]);
    affectedClusterIds.forEach(c => affected.add(c));
  }

  // 5. 변경 클러스터 라벨 재생성 (limitation_clusters UPSERT)
  await relabelClusters([...affected]);

  return { processed: batch.length, hasMore, totalCount: ..., ... };
}
```

`judgeOne`, `extractLimitationSentence`, `voyageEmbed`, `projectToPCA`, `judgeAllWithConcurrency` 는 기존 코드 그대로 재사용 (파일 I/O 부분만 제거).

### 2.4 `scripts/seed-limitations.ts` (신규, 일회성)

```ts
// knowledge-map-questions.json (재평가 끝난 37건 한계 포함 137건) → limitation_questions
import { sql } from '@vercel/postgres';
const data = JSON.parse(fs.readFileSync('public/knowledge-map-questions.json','utf-8'));
for (const q of data.questions) {
  const vec = `[${q.embedding.join(',')}]`;
  await sql`INSERT INTO limitation_questions (...) VALUES (...) ON CONFLICT (id) DO NOTHING`;
}
// clusterLabels → limitation_clusters
for (const [cid, entry] of Object.entries(data.clusterLabels)) {
  await sql`INSERT INTO limitation_clusters (cluster_id, label, member_ids)
    VALUES (${Number(cid)}, ${entry.label}, ${JSON.stringify(entry.memberIds)})
    ON CONFLICT (cluster_id) DO UPDATE SET label=EXCLUDED.label, member_ids=EXCLUDED.member_ids`;
}
```
재임베딩·재평가 없이 그대로 이전. cluster_id도 기존 값 유지(이미 정밀 DBSCAN 결과).

### 2.5 `app/api/admin/limitations/route.ts` (DB 쿼리)

```ts
// JSON 파일 읽기 → DB
const { rows } = await sql`SELECT * FROM limitation_questions`;
const { rows: labels } = await sql`SELECT * FROM limitation_clusters`;
// 이후 그룹핑 로직(cluster/outlier)은 기존과 동일 — 데이터 소스만 DB
```
응답 형태 동일 → LimitationsView 무수정.

### 2.6 `scripts/_make-standalone-map.mjs` (DB 읽기)

```js
// questions.json 읽기 → DB SELECT
const { rows } = await sql`SELECT question, quality, routed_agents, wiki, pca_x, pca_y, placement_wiki FROM limitation_questions`;
// 기존 어댑터(옛 필드 변환) 로직 재사용
```

---

## 3. API Contract

### 3.1 `POST /api/admin/limitations/refresh`
- 변경: 내부가 DB 기반 refresh() 호출. 응답 형태(`RefreshResult`) 동일.
- EROFS 사라짐. lock 유지.

### 3.2 `GET /api/admin/limitations`
- 변경: DB 쿼리. 응답 형태(clusters/outliers) 동일.

### 3.3 신규 (선택) `POST /api/admin/limitations/rebuild`
- `rebuildAllClusters()` 호출 — 보정용. admin only. (Do phase에서 필요시 추가)

---

## 4. Data Model

`limitation_questions` / `limitation_clusters` 테이블 (§2.1). 기존 `public/knowledge-map-questions.json`은 시드 후 **읽기 안 함** (지형도도 DB로). 단 파일 자체는 남겨둠 (롤백 안전망).

---

## 5. Migration & Seed 순서

```
1. schema.ts에 테이블 2개 추가
2. npm run db:generate → SQL 생성
3. SQL에 HNSW 인덱스 추가 (수동 편집)
4. npm run db:migrate → Neon에 테이블 생성
5. npx tsx --env-file=.env.local scripts/seed-limitations.ts → 137건 이전
6. 검증: SELECT count(*) = 137, cluster 분포 = JSON과 동일
```

---

## 6. Test Plan

| ID | 시나리오 | 기대 |
|---|---|---|
| T1 | 마이그레이션 후 chunk_embeddings 쿼리 (hybrid-rag) | 정상 (무영향) |
| T2 | seed 후 `SELECT count(*)` | 137 |
| T3 | seed 후 cluster 분포 vs JSON | 동일 (cluster_id 보존) |
| T4 | 로컬 `npm run knowledge:questions` (새 질문 0) | ~즉시 종료, DB 변화 없음 |
| T5 | 배포 Admin "갱신" 버튼 | **EROFS 없이** 동작, DB write |
| T6 | DB에 새 질문 추가 후 갱신 → ANN 할당 | 적절한 클러스터/outlier 배정 |
| T7 | `rebuildAllClusters()` 실행 후 결과 | 정밀 DBSCAN 결과와 일치, ANN 누적오차 정리 |
| T8 | 지형도 빌드 (DB 읽기) | 최신 데이터 반영 |
| T9 | `/admin/limitations` 페이지 | 기존과 동일 표시 (cluster/outlier/발췌) |
| T10 | 로컬 갱신 → 배포 페이지 새로고침 | 같은 Neon이라 반영됨 |

---

## 7. Implementation Order

1. **module-schema**: schema.ts 테이블 2개 + `db:generate` + HNSW 인덱스 + `db:migrate`
2. **module-seed**: seed-limitations.ts → 137건 이전 + 검증 (T2,T3)
3. **module-cluster-ann**: cluster-ann.ts (assignClusterANN + rebuildAllClusters)
4. **module-refresh-db**: refresh.ts DB 버전 (파일 I/O 제거)
5. **module-api-db**: route.ts DB 쿼리
6. **module-map-db**: _make-standalone-map.mjs DB 읽기
7. **검증**: T1~T10, 특히 T5(배포 EROFS 해결) + T7(보정)

### 핵심 분기점
- **Step 2 후**: 137건 시드 결과가 JSON과 일치하는지 (cluster 분포). 틀리면 seed 로직 수정.
- **Step 3~4 후**: 로컬에서 새 질문 1~2개 만들어 갱신 → ANN 할당이 합리적인지. 이상하면 EPS/병합 규칙 조정 + rebuildAllClusters로 비교.

---

## 8. Risks & Mitigations

| 위험 | 완화 |
|---|---|
| ANN 증분이 정밀 DBSCAN과 다른 클러스터 (병합 누락) | `rebuildAllClusters()` 보정 함수 + T7 검증. 시드 직후 1회 rebuild로 baseline 확보 |
| pgvector 마이그레이션이 chunk_embeddings 영향 | 별도 테이블 + 별도 인덱스. T1로 검증 |
| HNSW 인덱스 생성 SQL을 drizzle이 자동생성 못 함 | 마이그레이션 SQL 수동 편집 (chunk_embeddings 마이그레이션 참고) |
| seed 시 embedding 형식 (JSON array → vector) | `[${arr.join(',')}]::vector` (search.ts 패턴) |
| 지형도 빌드가 DB 접근 필요 | `--env-file=.env.local`로 실행 (기존 스크립트 관행) |
| Neon 커넥션 — serverless 다중 호출 | `@vercel/postgres` 풀러 (chunk_embeddings도 사용 중) |
| 새 질문이 여러 클러스터 잇는 경우 병합 안 함 | 근사 수용 + 주기 rebuild. 거버넌스 규모에선 영향 작음 |

---

## 9. Out of Scope

- supplementation suggestions 테이블 (그 feature에서)
- chunk_embeddings / hybrid-rag 변경
- 1만+ 초고규모 (HNSW 파라미터 튜닝, 파티셔닝)
- 자동 주기 rebuild (Cron) — 수동 또는 API 트리거만
- LimitationsView UI 변경

---

## 10. Dependencies

- 라이브러리: 없음 (pgvector, @vercel/postgres, drizzle 모두 사용 중)
- 환경: `POSTGRES_URL`(Neon), `VOYAGE_API_KEY`, `ANTHROPIC_API_KEY`
- pgvector extension: 설치됨 (chunk_embeddings 작동)
- search.ts ANN 쿼리 패턴 재사용

---

## 11. Implementation Guide

### 11.1 Module Map

| 모듈 | 파일 | 역할 |
|---|---|---|
| `module-schema` | `lib/db/schema.ts` + 마이그레이션 | limitation_questions/clusters 테이블 + HNSW |
| `module-seed` | `scripts/seed-limitations.ts` (신규) | JSON → DB 137건 이전 |
| `module-cluster-ann` | `lib/limitations/cluster-ann.ts` (신규) | ANN 증분 할당 + rebuildAll 보정 |
| `module-refresh-db` | `lib/limitations/refresh.ts` | 파일 I/O → DB, ANN 호출 |
| `module-api-db` | `app/api/admin/limitations/route.ts` | DB 쿼리 그룹핑 |
| `module-map-db` | `scripts/_make-standalone-map.mjs` | DB 읽기 빌드 |

### 11.2 Recommended Session Plan

| 세션 | 모듈 | 시간 |
|---|---|---|
| **1 (DB 기반)** | module-schema + module-seed | ~1.5h (마이그레이션 + 137건 이전 검증) |
| **분기점** | seed 결과 JSON과 일치 확인 (cluster 분포) | — |
| **2 (클러스터+갱신)** | module-cluster-ann + module-refresh-db | ~2h (ANN 할당 + 갱신 동작) |
| **3 (읽기 전환)** | module-api-db + module-map-db | ~1h (API + 지형도) |

### 11.3 Session Guide

**전체**: `/pdca do limitation-storage`

**DB 기반만**: `/pdca do limitation-storage --scope module-schema,module-seed`

**클러스터+갱신**: `/pdca do limitation-storage --scope module-cluster-ann,module-refresh-db`

**읽기 전환**: `/pdca do limitation-storage --scope module-api-db,module-map-db`

각 세션 Do 시작 시 Decision Record + Success Criteria 체크리스트 표시. Step 2(seed) 후 분기점 검증 필수.
