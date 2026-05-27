# Plan: Limitation Storage — 파일 → Neon Postgres + pgvector ANN 증분 클러스터링

> **Feature**: limitation-storage
> **Date**: 2026-05-28
> **Phase**: Plan

---

## Executive Summary

| 항목 | 내용 |
|---|---|
| **Problem** | limitation-tracking이 결과를 `public/knowledge-map-questions.json` 파일에 쓰는데, Vercel serverless는 read-only fs라 배포 환경 "갱신" 버튼이 EROFS 에러로 실패(로컬만 작동). 또한 매 갱신마다 전체 embedding을 메모리에 로드해 N² 클러스터링 — 규모 확장 시 비효율 |
| **Solution** | 저장 계층을 파일 → Neon Postgres로 이전. `limitation_questions` 테이블에 embedding을 pgvector `vector(1024)` 컬럼으로 저장(기존 chunk_embeddings 패턴). 클러스터링은 pgvector ANN 증분 — 새 질문만 `embedding <=> $vec`로 이웃 검색해 클러스터 할당(전체 N² 회피, search.ts 재사용). 지형도 빌드도 DB 읽기로 전환 |
| **UX Effect** | 배포 환경 "지금 갱신" 버튼이 정상 작동(런타임 DB write). 로컬·배포가 같은 Neon DB 공유 → 어디서 갱신해도 즉시 반영. 클러스터링 효율 개선으로 규모 확장 대비 |
| **Core Value** | 갱신 기능을 Vercel 환경에서 실제 작동시키고, 클러스터링을 확장 가능한 구조로 — limitation-tracking을 "로컬 전용 프로토타입"에서 "운영 가능한 기능"으로 |

---

## Context Anchor

| 항목 | 내용 |
|---|---|
| **WHY** | 2026-05-28 실측 — 배포 환경 갱신 버튼이 `EROFS: read-only file system` 에러. Vercel serverless는 public/ 런타임 쓰기 불가. 파일 기반 저장의 근본 한계. 동시에 전체 메모리 클러스터링은 규모 확장 시 비효율 (사용자 지적) |
| **WHO** | 관리자 — 웹에서 한계 데이터 갱신. DB는 Neon (chunk_embeddings와 공유) |
| **RISK** | (1) ANN 증분 DBSCAN은 글로벌 재배치를 근사(정밀 DBSCAN 아님). (2) pgvector 마이그레이션 — chunk_embeddings 영향 없게. (3) 기존 137건 시드 누락. (4) 지형도 빌드 전환 누락 시 옛 데이터 |
| **SUCCESS** | (1) 배포 갱신 버튼 EROFS 없이 작동, (2) 기존 137건 DB 시드 완료, (3) ANN 증분 클러스터링 결과가 메모리 전체와 유사(클러스터 수·outlier 비슷), (4) 지형도 DB 읽기로 최신 반영, (5) chunk_embeddings/hybrid-rag 무영향 |
| **SCOPE** | `lib/db/schema.ts` (limitation_questions 테이블) + 마이그레이션 / `lib/limitations/refresh.ts` (파일→DB, ANN 증분) / `lib/limitations/dbscan.ts` (ANN 기반 재구성) / `app/api/admin/limitations/*` (DB 읽기) / `scripts/` (시드 + DB 대상 갱신) / `scripts/_make-standalone-map.mjs` (DB 읽기) |

---

## 1. 현재 문제

### 1.1 EROFS — 배포 갱신 불가

[refresh.ts](lib/limitations/refresh.ts)의 `atomicWrite`가 `public/knowledge-map-questions.json`에 씀:
```
EROFS: read-only file system, open '/var/task/public/knowledge-map-questions.json.tmp'
```
- 로컬 `npm run` → fs 쓰기 OK ✅
- Vercel "갱신" 버튼 → read-only fs → ❌

Vercel serverless는 `/var/task`(배포 코드) 쓰기 불가. `/tmp`만 가능하나 ephemeral이라 캐시 부적합.

### 1.2 전체 메모리 클러스터링 비효율

[refresh.ts](lib/limitations/refresh.ts)가 매 갱신 시 전체 questions의 embedding을 로드 → `dbscan()`이 N² 거리 계산. 137건은 무문제지만 증분 갱신인데 클러스터링만 전체 재계산 — 규모 확장 시 병목.

---

## 2. 해결 — Neon Postgres + pgvector

### 2.1 DB 저장 위치 (확인됨)

- `POSTGRES_URL` = **Neon serverless Postgres** (`...neon.tech/neondb`)
- `chunk_embeddings`(hybrid-rag)가 이미 Neon에 pgvector로 저장 중 → 동일 패턴 재사용
- 로컬 `npx tsx`로 시드/갱신해도 POSTGRES_URL이 원격 Neon을 가리켜 **원격 DB에 write**
- 배포 Vercel 앱도 같은 POSTGRES_URL → 같은 데이터. **로컬/배포 DB 공유**

### 2.2 신규 테이블 `limitation_questions`

```ts
// lib/db/schema.ts — chunk_embeddings 패턴 따름
export const limitationQuestions = pgTable('limitation_questions', {
  id:           text('id').primaryKey(),              // messages.id (user 질문)
  question:     text('question').notNull(),
  answer:       text('answer').notNull(),
  createdAt:    timestamp('created_at').notNull(),
  routedAgents: jsonb('routed_agents'),               // string[]
  embedding:    vector('embedding', { dimensions: 1024 }).notNull(),

  // Sonnet 평가
  quality:      text('quality').notNull(),            // answered | partial | no_data
  wiki:         text('wiki'),
  limitation:   boolean('limitation').default(false).notNull(),
  limitationExcerpt: text('limitation_excerpt'),

  // DBSCAN
  clusterId:    integer('cluster_id').default(-1).notNull(),

  // 지식 지형도 호환
  pcaX:         text('pca_x'),                         // 또는 jsonb pcaCoord
  pcaY:         text('pca_y'),
  placementWiki: text('placement_wiki'),

  evaluatedAt:  timestamp('evaluated_at').defaultNow().notNull(),
});

// 클러스터 라벨 (캐싱)
export const limitationClusters = pgTable('limitation_clusters', {
  clusterId:    integer('cluster_id').primaryKey(),
  label:        text('label').notNull(),
  memberIds:    jsonb('member_ids').notNull(),         // string[] (캐시 검증)
  updatedAt:    timestamp('updated_at').defaultNow().notNull(),
});
```

pgvector ANN 인덱스(HNSW/IVFFlat)는 chunk_embeddings 패턴 따라 마이그레이션에 추가.

### 2.3 ANN 증분 클러스터링

기존 전체 N² → 새 질문만 DB ANN 이웃 검색:

```
새 질문 처리:
  1. Voyage 임베딩 → limitation_questions에 insert (embedding 포함)
  2. ANN 쿼리 (search.ts 패턴):
     SELECT id, cluster_id, embedding <=> $newvec AS dist
     FROM limitation_questions
     WHERE embedding <=> $newvec < 0.40   -- eps
     ORDER BY dist LIMIT 20
  3. 이웃(dist < eps)이 minPts-1(=1) 이상:
     - 이웃들의 cluster_id 중 가장 흔한 것에 합류
     - 이웃이 모두 outlier(-1)면 → 새 클러스터 생성, 이웃들도 함께 승격
  4. 이웃 없으면 → outlier (cluster_id = -1)
  5. 새/변경 클러스터만 Sonnet 라벨링 (기존 캐싱 유지)
```

**전체 N² 회피** — 새 질문 수 × ANN 쿼리(인덱스 O(log N))만.

**근사 한계 (정직)**: 정밀 DBSCAN의 글로벌 재배치(기존 outlier가 새 점으로 클러스터 승격되며 연쇄 병합)를 부분 근사. 거버넌스 규모에선 충분. 필요 시 "전체 재클러스터링" 함수 별도 제공 (가끔 보정).

### 2.4 갱신 흐름 (DB 버전)

```
suggest 아님 — refresh:
  1. DB에서 미처리 질문 판정: messages에 있는데 limitation_questions에 없는 id
  2. batch N개:
     a. Voyage 임베딩
     b. Sonnet 평가 (quality/wiki/limitation) + 답변에서 발췌 추출
     c. limitation_questions insert
     d. ANN 증분 클러스터 할당 (§2.3)
     e. 변경 클러스터 라벨링 → limitation_clusters upsert
  3. hasMore = 미처리 질문 더 있나
```

batch는 그대로 (Vercel timeout 회피). DB write라 EROFS 없음.

### 2.5 데이터 이전 (시드)

```
scripts/seed-limitations.ts (신규, 일회성):
  1. public/knowledge-map-questions.json 읽기 (재평가 끝난 137건, embedding 포함)
  2. limitation_questions 테이블에 insert
  3. clusterLabels → limitation_clusters
  → 재임베딩·재평가 불필요 (이미 품질 정화된 데이터 그대로 이전)
```

### 2.6 API + 지형도 전환

- `app/api/admin/limitations/route.ts` (GET): JSON 파일 읽기 → DB 쿼리 (cluster/outlier 그룹핑)
- `app/api/admin/limitations/refresh/route.ts` (POST): refresh() DB 버전 호출
- `scripts/_make-standalone-map.mjs`: questions.json 읽기 → DB 쿼리로 전환 (지형도 최신 반영)

---

## 3. 구현 범위

| 파일 | 변경 | 라인 |
|---|---|---:|
| `lib/db/schema.ts` | `limitationQuestions` + `limitationClusters` 테이블 | ~40 |
| `drizzle/` 마이그레이션 | 테이블 + pgvector 인덱스 생성 SQL | 자동생성 |
| `lib/limitations/refresh.ts` | 파일 I/O → DB I/O, ANN 증분 클러스터링 | ~150 변경 |
| `lib/limitations/dbscan.ts` | ANN 증분 할당 함수로 재구성 (또는 보정용 전체 재계산 유지) | ~60 |
| `lib/limitations/types.ts` | DB row 타입 정합 | ~10 |
| `app/api/admin/limitations/route.ts` | DB 쿼리로 그룹핑 | ~40 변경 |
| `app/api/admin/limitations/refresh/route.ts` | DB refresh 호출 (큰 변경 없음) | ~5 |
| `scripts/seed-limitations.ts` | 신규 — JSON → DB 시드 (일회성) | ~50 |
| `scripts/embed-questions.ts`, `reevaluate-limitations.ts` | DB 대상으로 | ~20 |
| `scripts/_make-standalone-map.mjs` | DB 읽기로 전환 | ~30 변경 |

**합계**: ~450줄, 신규 1개 파일 + 테이블 2개.

### 무수정
- `chunk_embeddings` / hybrid-rag (`lib/embed/*`) — 영향 없음
- LimitationsView UI — API 응답 형태 동일하면 무변경
- 다른 기능

---

## 4. Success Criteria

| ID | 기준 | 측정 |
|---|---|---|
| **SC1** | `limitation_questions` 테이블 + pgvector 인덱스 생성, chunk_embeddings 무영향 | 마이그레이션 후 양쪽 쿼리 |
| **SC2** | 기존 137건 JSON → DB 시드 완료 (재임베딩 없이) | `SELECT count(*)` = 137 |
| **SC3** | 배포 환경 "갱신" 버튼 EROFS 없이 작동 | Vercel에서 실측 |
| **SC4** | ANN 증분 클러스터링 결과가 메모리 전체와 유사 (클러스터 수·outlier ±20%) | 시드 후 비교 |
| **SC5** | 지형도(knowledge-map.html) DB 읽기로 빌드 — 최신 데이터 반영 | 빌드 후 확인 |
| **SC6** | 로컬 갱신 → 배포에서 즉시 반영 (같은 Neon DB) | 로컬 갱신 후 배포 페이지 확인 |
| **SC7** | LimitationsView 기존과 동일하게 표시 (cluster/outlier/발췌) | UI 수동 |

---

## 5. Risks

| 위험 | 완화 |
|---|---|
| ANN 증분이 정밀 DBSCAN과 다른 클러스터 생성 | 시드 직후 메모리 전체 결과와 비교(SC4). 큰 차이면 "전체 재클러스터링" 보정 함수 사용. eps/minPts 동일 유지 |
| pgvector 마이그레이션이 chunk_embeddings 영향 | 별도 테이블이라 격리. 마이그레이션 후 chunk_embeddings 쿼리 검증 |
| Neon 연결 — Vercel serverless 커넥션 풀 | 기존 `@vercel/postgres`(서버리스 최적 풀러) 재사용. chunk_embeddings도 이미 그렇게 작동 |
| 시드 시 embedding 형식 (JSON array → pgvector literal) | search.ts의 `[${arr.join(',')}]::vector` 패턴 재사용 |
| 지형도 빌드가 로컬에서 DB 접근 (POSTGRES_URL 필요) | 빌드 스크립트도 `--env-file=.env.local`로 실행. 이미 다른 스크립트가 그렇게 함 |
| 글로벌 재배치 근사로 클러스터 품질 저하 누적 | 주기적(또는 수동) 전체 재클러스터링 함수로 보정. 데이터 적어 비용 작음 |

---

## 6. Out of Scope

- supplementation-suggestion 본 기능 (이번엔 questions 저장만; suggestions 테이블은 그 feature에서)
- chunk_embeddings / hybrid-rag 변경
- 1만 건+ 초고규모 최적화 (HNSW 파라미터 튜닝, 파티셔닝)
- 실시간 자동 갱신 (Cron) — 별도
- LimitationsView UI 변경 (API 응답 형태 유지)

---

## 7. Dependencies

- 외부 라이브러리: 없음 (pgvector, @vercel/postgres, drizzle 모두 사용 중)
- 환경 변수: 기존 `POSTGRES_URL`(Neon), `VOYAGE_API_KEY`, `ANTHROPIC_API_KEY`
- DB 마이그레이션: `npm run db:generate` + `db:migrate` (테이블 2개 + 인덱스)
- pgvector extension: 이미 설치됨 (chunk_embeddings 작동 중)
- 기존 `lib/embed/search.ts` ANN 쿼리 패턴 재사용
