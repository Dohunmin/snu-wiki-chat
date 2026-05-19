# Plan: Hybrid RAG — 키워드 매칭의 동의어 한계를 의미 검색으로 보완

> **Feature**: hybrid-rag
> **Date**: 2026-05-18
> **Phase**: Plan
> **PoC Target**: `finance` 위키 (재무정보공시)
> **Long-term Target**: 9개 위키 전체

---

## Executive Summary

| 항목 | 내용 |
|---|---|
| **Problem** | "대학원생 장학금 10년 추이" 같은 동의어 의존 질문에 `학생경비`·`학문후속세대 지원금`·`등록금 면제` 같은 관련 청크가 점수 0이 되어 컨텍스트에서 누락 → 실제 자료가 있음에도 "자료 없습니다" 답변. 키워드 literal 매칭의 본질적 한계 |
| **Solution** | **하이브리드 RAG** — 기존 키워드/메타데이터 검색에 임베딩 기반 의미 검색을 *추가*. Voyage 3 multilingual + pgvector + RRF(Reciprocal Rank Fusion). 라우터/엔티티 역참조/concept-index/권한 다층 방어/Lens 모드 등 *모든 기존 자산 보존* |
| **UX Effect** | 동의어/유사 의미 질문에서 풍부한 답변 (예: "장학금" → "학생경비·지원금·면제" 모두 회수). 기존 작동하는 질문은 회귀 없음 (Golden Q&A 20개로 보장) |
| **Core Value** | "*P1(할루시네이션 금지) 원칙 유지하면서도 P5(한계 인정)로 도망치지 않게 만든다.* 데이터가 있으면 답한다." |

---

## Context Anchor

| 항목 | 내용 |
|---|---|
| **WHY** | 2026-05-18 갭 사례 — `대학원생 장학금 10년` 질문에 finance 위키의 학생경비 8개년 표·plan의 학문후속세대 지원금 인상·vision의 박사 기본장학금 신설 계획 등 풍부한 자료가 있는데도 시스템이 "자료 없음"으로 답함. 단어 literal 매칭의 동의어 누락이 거버넌스 도구의 신뢰성을 직접 위협 |
| **WHO** | 총장 후보자·관리자 — 정책 비교/시뮬레이션을 위해 *데이터 누락 없는* 답변이 필요. PoC 사용자는 개발자(도훈민) 본인이 검증 |
| **RISK** | (R1) 벡터 검색이 너무 fuzzy해서 노이즈 청크가 컨텍스트 오염 → RRF + chunk cap 30 유지로 완화. (R2) 임베딩 비용·지연 → finance 1개만 ~$1 일회성, 쿼리당 +50~150ms. (R3) 기존 답변 회귀 → Golden Q&A 20개 자동 비교. (R4) pgvector 마이그레이션 실수 → 기존 테이블 영향 없는 새 테이블만 추가 |
| **SUCCESS** | (1) 갭 사례 "대학원생 장학금 10년" 질문에 관련 청크 ≥3개 회수 + 시계열 데이터 인용 답변. (2) Golden Q&A 20개 중 ≥18개가 RAG 도입 전과 동등 또는 개선 (회귀 없음). (3) 쿼리당 추가 지연 ≤200ms, 추가 토큰 0 (검색 결과만 교체). (4) PoC 후 전체 9개 확장 청사진 명확 |
| **SCOPE** | **PoC**: finance 1개 위키만. 신규 파일 `lib/embed/`·`scripts/build-embeddings.ts`·`drizzle/0xxx_pgvector.sql`. 수정 `lib/agents/wiki-agent.ts` (RRF 융합), `lib/db/schema.ts` (테이블 추가), `scripts/build-wiki-data.ts` (임베딩 트리거). 다른 위키·UI는 비스코프 |

---

## 1. 문제 정의

### 1.1 갭 사례 (2026-05-18)

```
사용자 질문: "대학원생 장학금이 최근 10년 사이에 증가했어?"
                ↓
시스템 라우팅: finance, plan, vision, senate, status 5개 위키 선택 ✓
                ↓
WikiAgent 청크 스코어링:
  finance.json `비용구조.fact` (학생경비 8개년 표):
    → "장학금" 단어 0회, "대학원생" 단어 0회 → score = 0 → 누락 ❌
  plan.json `2026-섹션3-추진성과` (학문후속세대 지원금 인상):
    → "장학금" 단어 거의 없음 (지원금이라 부름) → 낮은 점수 → 부분 누락 ❌
  finance.json `예산-세출구조.fact` (대학원 운영비 10개년 추이):
    → "장학금"·"대학원생" 매칭 약함 → 누락 ❌
                ↓
LLM 답변: "제공된 위키 자료에는 대학원생 장학금의 최근 10년간 추이나
        증감에 관한 구체적인 수치·통계 데이터가 포함되어 있지 않습니다."
        (P1 충실하나 P5로 도망)
```

### 1.2 문제의 본질

키워드 literal 매칭의 동의어/유사어 미연결 — 거버넌스 도메인에서 특히 빈발:

| 사용자 단어 | 실제 위키 단어 | 매칭? |
|---|---|---|
| 장학금 | 학생경비 (재무 카테고리) | ❌ |
| 장학금 | 학문후속세대 지원금 (plan) | ❌ |
| 장학금 | 등록금 면제 (정책) | ❌ |
| 의결 | 가결/부결 | ❌ |
| 본회의 | 평의원회 회의 | ❌ |
| 재정 | 예산·결산·세입·세출 | 🟡 부분 |

### 1.3 왜 지금 RAG인가

이전 plan(`multi-wiki-integration`)에서 **비스코프(§11)로 "벡터 임베딩 검색 도입 (장기 과제, 별도 plan)"** 으로 명시. 위키 9개·페이지 타입 7개·concept-index 75개·alwaysContext·Lens 모드 등 기반은 완성 → **이제 검색 품질 갭이 가장 큰 병목**.

---

## 2. 해결 방식 — 하이브리드 RAG

### 2.1 핵심 원칙

**RAG는 키워드 검색을 *대체*하지 않고 *증강*한다.**

```
Before:
  쿼리 → 키워드 매칭 → 상위 N개 청크 → LLM
       (literal only)

After:
  쿼리 → 키워드 매칭 → 키워드 top-K
       ↘
        ↘ 벡터 유사도 검색 → 벡터 top-K
       ↗
  ──── RRF 융합 ────  최종 상위 N개 청크 → LLM
       (의미적 매칭 추가)
```

### 2.2 RRF (Reciprocal Rank Fusion)

키워드 순위와 벡터 순위를 *순위 기반*으로 결합. 가중치 튜닝 1개만 필요해 안정적, 업계 표준.

```
final_score(chunk) = 1 / (k + rank_keyword)  +  1 / (k + rank_vector)
  where k = 60 (기본값, 작은 순위 차이 흡수용)

예시:
  Chunk A: keyword 순위 3위, vector 순위 1위
    → 1/63 + 1/61 = 0.0322
  Chunk B: keyword 순위 1위, vector 순위 5위
    → 1/61 + 1/65 = 0.0318
  Chunk C: keyword 누락, vector 순위 2위
    → 0 + 1/62 = 0.0161
  Chunk D: keyword 1위, vector 누락
    → 1/61 + 0 = 0.0164

→ A·B가 상위 (양쪽 모두 잡힌 청크), C·D는 하나만 잡힌 청크보다 후순위
```

**왜 RRF인가**:
- 가중치 1개(k)만 튜닝, 점수 스케일 정규화 불필요
- 한쪽 검색이 0점이어도 다른 쪽이 살림 (recall ↑)
- 양쪽 모두 잡힌 청크는 자연스럽게 부스트 (precision ↑)

### 2.3 임베딩 모델 — Voyage 3 multilingual

| 항목 | 선택 이유 |
|---|---|
| 한국어 성능 | 한국어 거버넌스 도메인에서 OpenAI보다 우수 (벤치마크 기준) |
| Anthropic 파트너십 | 같은 결제 생태계 (Claude 이미 사용 중) → 추가 가입만 필요 |
| 컨텍스트 길이 | 16K 토큰 — 긴 청크도 한 번에 처리 |
| 비용 | ~$0.06/1M 토큰 — finance 위키 전체 ~$0.50 일회성 |

### 2.4 pgvector — 별도 인프라 없이

Vercel Postgres에 `CREATE EXTENSION vector;` 한 줄로 도입. 신규 테이블 `chunk_embeddings` 만 추가 (기존 테이블 영향 0).

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE chunk_embeddings (
  id          TEXT PRIMARY KEY,           -- {wiki}:{page_id}:{chunk_idx}
  wiki_id     TEXT NOT NULL,
  page_type   TEXT NOT NULL,              -- source/fact/stance/overview/topic/entity
  page_id     TEXT NOT NULL,
  chunk_idx   INTEGER NOT NULL,
  chunk_text  TEXT NOT NULL,
  embedding   VECTOR(1024) NOT NULL,      -- Voyage 3 = 1024차원
  sensitive   BOOLEAN DEFAULT FALSE,      -- 권한 필터링용
  metadata    JSONB,                       -- title, topic, holder 등
  content_hash TEXT NOT NULL,             -- 증분 갱신용
  created_at  TIMESTAMP DEFAULT NOW()
);

CREATE INDEX chunk_embeddings_vec_idx
  ON chunk_embeddings USING ivfflat (embedding vector_cosine_ops);

CREATE INDEX chunk_embeddings_wiki_idx ON chunk_embeddings (wiki_id);
```

### 2.5 권한 다층 방어 — 벡터 검색에도 동일 적용

```sql
-- 검색 시 sensitive 필터 + wiki_id 필터
SELECT id, chunk_text, embedding <=> $1 as distance
FROM chunk_embeddings
WHERE wiki_id IN ($2, $3, ...)        -- 라우터가 선택한 위키만
  AND (sensitive = false OR $4 = true) -- canAccessSensitive(role)
ORDER BY embedding <=> $1
LIMIT $5;
```

`adminOnly`(leesj) 위키는 라우터에서 이미 제외 → 임베딩이 만들어지더라도 일반 사용자 쿼리 시 `wiki_id IN` 필터로 차단.

---

## 3. 보존되어야 할 자산 — 무엇이 *바뀌지 않는가*

| 영역 | 현재 동작 | After RAG | 변경 여부 |
|---|---|---|:---:|
| 9개 위키 + 7가지 페이지 타입 | 그대로 | 그대로 | ✅ 보존 |
| 라우터 4단계 (Tier 0/Stage 1/concept/적응형) | router.ts | 그대로 | ✅ 보존 |
| Entity 역참조 + guaranteed +5 | wiki-agent.ts | 그대로 (벡터 결과 *위에* 가산) | ✅ 보존 |
| `alwaysContext` (status 항상 포함) | 라우터 플래그 | 그대로 | ✅ 보존 |
| `adminOnly + lensPersona` (leesj) | 라우터 가드 | 그대로 + 임베딩도 분리 | ✅ 보존 |
| Sensitive 다층 방어 | wiki-agent.ts 108줄 | + pgvector 쿼리에도 필터 | ✅ 강화 |
| Lens 모드 (lens.ts) | stance 별도 처리 | 그대로 (PoC 비스코프) | ✅ 보존 |
| 인라인 출처 `[위키] 문서ID` | prompts.ts P2 | 그대로 (벡터 검색 결과도 같은 ID 체계) | ✅ 보존 |
| concept-index 75개 | 라우팅 forced wikis | 그대로 | ✅ 보존 |
| SSE 4종 이벤트 | chat/route.ts | 그대로 | ✅ 보존 |
| 직전 3교환 대화 메모리 | chat/route.ts:139 | 그대로 | ✅ 보존 |
| 청크 분할 `## 헤더` | wiki-agent.ts splitIntoChunks | 그대로 (벡터도 같은 청크 단위) | ✅ 보존 |
| fact/stance/overview 통째 처리 | wiki-agent.ts 188-240 | 그대로 (메타데이터만 임베딩) | ✅ 보존 |

**변경되는 단 한 곳**: `WikiAgent.getContext()` 내 청크 스코어링 — 키워드 점수 *옆에* 벡터 점수 추가 후 RRF로 합산.

---

## 4. PoC 범위 — finance 위키만

### 4.1 왜 finance인가

- 갭 사례가 직접 등장한 위키 (장학금·학생경비)
- fact 페이지 7개, source 26개 — 검증 케이스 풍부
- 8~10개년 시계열 데이터 — 의미 검색 효과 명확
- 비교적 작은 규모 → 임베딩 비용 ~$0.50, 빌드 1분 이내

### 4.2 PoC에서 *하는 것*

- ✅ pgvector 설치 + `chunk_embeddings` 테이블
- ✅ finance.json의 *모든 페이지 타입* 임베딩 (source 청크 + fact/topic/entity 통째)
- ✅ `WikiAgent`에 RRF 융합 옵션 추가 (config로 위키별 ON/OFF)
- ✅ finance 위키만 RAG ON, 나머지 8개는 키워드만
- ✅ Golden Q&A 20개 자동 비교 스크립트
- ✅ 갭 사례 질문 직접 검증

### 4.3 PoC에서 *안 하는 것*

- ❌ 다른 8개 위키 임베딩 (Phase 2 이후)
- ❌ 증분 갱신 (PoC는 전체 재생성)
- ❌ UI 변경 (검색 결과 시각화 등)
- ❌ Lens 모드 RAG 적용 (stance는 lens.ts에서 별도 처리)
- ❌ Obsidian webhook 자동화

---

## 5. 데이터 모델 변경

### 5.1 신규 — DB 스키마

```typescript
// lib/db/schema.ts 추가
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

### 5.2 신규 — AgentConfig 확장

```typescript
// lib/agents/types.ts
export interface AgentConfig {
  // ... 기존 필드 유지
  ragEnabled?: boolean;  // true면 RAG ON, false/undefined면 키워드만 (기본 false)
}
```

```json
// data/agents.config.json — finance만 활성화
{
  "agents": [
    { "id": "finance", "name": "재무정보공시", "ragEnabled": true, ... },
    { "id": "senate", ... }  // ragEnabled 없음 → 키워드만 (PoC 안전)
  ]
}
```

### 5.3 신규 — 임베딩 메타데이터

```typescript
// lib/embed/types.ts
export interface ChunkMetadata {
  title: string;
  pageType: PageType;
  // page type별 보강 메타
  topic?: string;       // stance·topic
  holder?: string;      // stance
  category?: string;    // fact
  yearsCovered?: string; // fact
  편?: string;         // overview
}
```

---

## 6. 구현 단계 (Phase 1-6, PoC 기준)

### Phase 1 — 인프라 (1일)
- [ ] Vercel Postgres에 `CREATE EXTENSION vector;`
- [ ] Drizzle 마이그레이션: `chunk_embeddings` 테이블
- [ ] `lib/db/schema.ts`에 `chunkEmbeddings` 정의 + pgvector 드라이버 추가
- [ ] Voyage API 키 발급 + `.env.local`에 `VOYAGE_API_KEY` 추가

**Deliverable**: `npm run db:migrate` 성공, 빈 테이블 생성 확인.

### Phase 2 — 임베딩 생성 모듈 (1-2일)
- [ ] `lib/embed/voyage.ts` — Voyage API 클라이언트 (배치 임베딩, 재시도, 토큰 제한 처리)
- [ ] `lib/embed/chunker.ts` — finance.json의 모든 페이지 타입을 임베딩 가능 단위로 변환
  - source: 기존 `splitIntoChunks` 재사용
  - fact/stance/overview/topic/entity: 통째 1개 청크 (메타데이터로 보강)
- [ ] `scripts/build-embeddings.ts` — 위키별 임베딩 빌드 진입점
  - 입력: wikiId
  - 동작: `data/{wikiId}.json` 읽기 → 청크화 → Voyage API → DB INSERT (UPSERT by id+content_hash)

**Deliverable**: `npx tsx scripts/build-embeddings.ts finance` 실행 시 finance 청크 전체 DB 저장, 비용 측정 출력.

### Phase 3 — 하이브리드 검색 (2일) — **핵심**
- [ ] `lib/embed/search.ts` — pgvector top-K 검색 함수
  ```typescript
  searchVector(query: string, wikiId: string, role: Role, k: number): Promise<RankedChunk[]>
  ```
- [ ] `lib/agents/wiki-agent.ts`에 RRF 융합 로직 추가
  - 기존 키워드 스코어링 결과 = `keywordTop` (순위 매김)
  - 벡터 검색 결과 = `vectorTop` (순위 매김)
  - `ragEnabled` 위키만 `rrfFuse(keywordTop, vectorTop, k=60)` 실행
  - 비활성 위키는 키워드만
- [ ] `entity 역참조 guaranteedIds`는 RRF *이후* 별도 가산 (보존)

**Deliverable**: finance에 대한 쿼리에서 키워드 매칭 0인 의미 관련 청크가 컨텍스트에 들어감.

### Phase 4 — Golden Q&A 회귀 테스트 (1일)
- [ ] `scripts/golden-qa.ts` — 25개 질문 셋 정의 (회귀 20 + 갭 사례 5)
  - 회귀: 이사회·평의원회·AI·재정·연구 등 현재 잘 동작하는 질문
  - 갭 사례: "대학원생 장학금 10년", "강사료 변천", "기숙사 수용 추이" 등
- [ ] 자동 비교: RAG OFF vs RAG ON 답변 → 토큰 수·인용 출처 수·핵심 키워드 포함 여부 측정
- [ ] 결과 리포트: `docs/03-analysis/hybrid-rag-poc.report.md`

**Deliverable**: 회귀 20개 중 ≥18개 동등/개선 + 갭 사례 5개 중 ≥3개 개선 확인.

### Phase 5 — 빌드 파이프라인 통합 (반일)
- [ ] `scripts/build-wiki-data.ts` 마지막에 `ragEnabled` 위키들 자동 임베딩 트리거
- [ ] `npm run wiki:build` 한 번 실행으로 JSON + 임베딩 모두 갱신
- [ ] 콘솔 로그: 위키별 청크 수, 임베딩 비용, 소요 시간

**Deliverable**: 단일 명령으로 전체 파이프라인 작동.

### Phase 6 — PoC 결과 정리 (반일)
- [ ] PoC 보고서 작성: 갭 해소 여부, 회귀 결과, 비용·지연 측정
- [ ] 전체 9개 확장 청사진 (다음 plan): finance 외 위키의 특이사항, 비용 추정, 증분 갱신 도입 시점

**Deliverable**: 도훈민 본인이 *직접 챗 UI에서* 갭 사례 질문을 다시 던져 풍부한 답변 받음.

---

## 7. 위험 및 완화

| Risk | 영향 | 완화 |
|---|---|---|
| **R1** 벡터 검색이 너무 fuzzy해서 노이즈 청크 컨텍스트 오염 | 중 | RRF가 양쪽 잡힌 청크 우선. chunk cap 30 유지. 회귀 테스트로 노이즈 증가 시 즉시 감지 |
| **R2** 임베딩 API 호출 비용/지연 | 저 | finance 위키 ~$0.50 일회성, 쿼리당 +50~150ms (1024차원 단일 호출). 캐싱 가능 |
| **R3** 기존 답변 회귀 | 고 | `ragEnabled` 위키별 플래그 → finance만 ON. Golden Q&A 자동 비교. 회귀 발생 시 즉시 OFF 가능 |
| **R4** pgvector 마이그레이션 실수 | 저 | 신규 테이블만 추가, 기존 6개 테이블 영향 0. 롤백 = `DROP TABLE chunk_embeddings;` |
| **R5** 권한 필터링 누락 → sensitive 자료 노출 | 고 | (a) wiki_id IN 필터 (라우터가 admin/sensitive 1차 차단), (b) sensitive 컬럼 필터 (2차), (c) leesj는 임베딩 자체 생성 안 함 (3차) |
| **R6** Voyage API 다운 → 검색 실패 | 중 | try/catch로 RAG 실패 시 키워드 단독 fallback. `console.error` 로깅 |
| **R7** content_hash 충돌 (다른 청크가 같은 hash) | 매우 저 | SHA-256 사용. 충돌 시 chunk_idx로 unique 보장 |
| **R8** Vercel serverless cold-start에 pgvector 인덱스 로딩 지연 | 저 | ivfflat 인덱스는 메모리 기반, 첫 쿼리만 ~500ms. Vercel KV 캐시 도입 가능 (Phase 2 이후) |
| **R9** PoC 1개 위키로는 cross-wiki 효과 검증 불가 | 중 | 갭 사례 질문은 단일 finance 위키만으로도 충분히 검증 가능 (학생경비 자체가 finance 내) |

---

## 8. 검증 시나리오 — Golden Q&A 25개

### 8.1 회귀 그룹 (20개) — 현재 잘 작동하는 질문, 답변 *동등 이상* 유지

| # | 질문 | 기대 |
|---|------|------|
| 1 | "2024년 종합재무제표 운영수익 얼마야?" | 21,438억 (출처: 수입구조.fact) |
| 2 | "2020 ~ 2024 인건비 추이" | 7,788 → 9,777억 (출처: 비용구조.fact) |
| 3 | "법인회계 자산 8년간 변화" | 자산구성.fact 인용 |
| 4 | "산학협력단 운영수익 추이" | 주체별-운영수익.fact |
| 5 | "당기운영차익 8개년" | 주체별-당기운영차익.fact |
| 6 | "2024년 세출 예산 구조" | 예산-세출구조.fact |
| 7 | "기부금 수익 변동" | 수입구조.fact |
| 8 | "관리운영비 비중" | 비용구조.fact |
| 9 | "발전재단 자산" | 자산구성.fact |
| 10 | "법인 단독 적자 연도" | 2018·2019 (출처: 법인회계-운영계산서.fact) |
| 11 | "연구비 2017→2024 성장률" | +45.2% |
| 12 | "사업비 비중 변화" | 예산-세출구조.fact |
| 13 | "단과대 발전재단 현황" | 자산구성.fact |
| 14 | "정부출연금 비중" | 수입구조.fact |
| 15 | "교육부대수입 신설 시점" | 2023년 (출처: 수입구조.fact) |
| 16 | "2018 적자 원인" | 인건비 +457억 + 등록금·정부출연금 감소 |
| 17 | "2024 차익 역대 최고 이유" | 정부출연금 +520억 + 기타비용 소멸 |
| 18 | "교내타회계전입금 재분류" | 2021년 |
| 19 | "보수인상 추이" | 예산-세출구조.fact 인건비 상세 |
| 20 | "산학협력수익 비중" | 38.8% (2024) |

### 8.2 갭 사례 그룹 (5개) — 현재 답변 못 함, RAG 도입 후 답변 *개선*

| # | 질문 | 현재 답변 | 기대 (RAG ON) |
|---|------|----------|--------------|
| 21 | "대학원생 장학금이 최근 10년 사이에 증가했어?" ⭐ | "자료에 없음" | 학생경비 8개년 +33% 인용 |
| 22 | "강사료 변천 보여줘" | 부분 | 2019 강사법(방학 강사료) + 인건비 추이 |
| 23 | "학생 1인당 지원 추세" | 부분 | 학생경비 / 재학생 수 비교 |
| 24 | "재정 지원 어디서 가장 늘었어?" | 부분 | 정부출연금·산학협력·기부금 항목별 |
| 25 | "예산 중 학생에게 가는 돈 비중" | "자료 없음" | 학생경비 비중 8.0% (2024) |

### 8.3 측정 지표

| 지표 | 측정 방법 | 합격선 |
|---|---|---|
| 회귀 통과율 | Q1-20 답변에 핵심 수치·출처 포함 여부 자동 체크 | ≥18/20 (90%) |
| 갭 개선율 | Q21-25 답변에 *현재 누락된* 관련 청크가 포함되는지 | ≥3/5 (60%) |
| 쿼리당 지연 추가 | RAG OFF vs ON p50 지연 차이 | ≤200ms |
| 쿼리당 토큰 변화 | input/output 토큰 변화 | input ±10%, output 변화 없음 |
| 출처 다양성 | 답변 인용 출처 수 | 평균 ≥2 (RAG ON 시 ≥3 기대) |

---

## 9. Success Criteria

| # | 기준 | 측정 |
|---|------|------|
| **SC1** | pgvector 설치 + `chunk_embeddings` 테이블 정상 작동 | `npm run db:migrate` 무에러, INSERT/SELECT 동작 |
| **SC2** | finance 위키 전체 임베딩 성공 | `scripts/build-embeddings.ts finance` 무에러, DB row 수 ≥ 청크 수 |
| **SC3** | 하이브리드 RRF 융합 작동 | finance 쿼리 시 keyword 0점 청크가 vector로 회수되는 사례 ≥1개 (디버그 로그) |
| **SC4** | 갭 사례 해소 — "대학원생 장학금 10년" | 답변에 학생경비 시계열 인용 + 학문후속세대 지원금 인상 인용 모두 등장 |
| **SC5** | 회귀 없음 | Golden Q&A 1-20 중 ≥18개 동등/개선 |
| **SC6** | 갭 개선 | Golden Q&A 21-25 중 ≥3개 풍부한 답변 |
| **SC7** | 권한 다층 방어 유지 | tier2 사용자 쿼리 시 sensitive 청크 응답에 등장 0건 |
| **SC8** | 다른 8개 위키 영향 없음 | senate/board/plan/vision/history/status/yhl-speeches/leesj 쿼리 시 RAG 미작동 확인, 답변 변화 없음 |
| **SC9** | Vercel 배포 작동 | 프로덕션 배포 후 finance 쿼리 동일 작동 |
| **SC10** | 전체 확장 청사진 | PoC 보고서에 9개 확장 시 비용·지연·증분 갱신 도입 시점 명시 |

---

## 10. 향후 확장 (PoC 이후 로드맵) — **공격적 타임라인**

> 사용자 의지: Phase B는 **1주일 내**, Phase C·D는 **1-2개월 내**.
> PoC 검증되는 즉시 전체 확장으로 들어가고, 운영 자동화·Lens·critic 같은 고급 기능도 동시 진행.

### 10.1 Phase A (PoC 완료 직후, ~2-3일)
- 다른 fact 풍부한 위키(plan, vision, history) RAG 활성화 우선
- 각 위키 임베딩 비용·지연 측정 → 비용 cap 정책 즉시 결정

### 10.2 Phase B (1주일 내) ⚡ **공격적**

#### 10.2.1 실제 진행 상황 (2026-05-19 ~ 2026-05-30)

| 항목 | 상태 | 메모 |
|------|:---:|------|
| **8개 위키 RAG 활성화** | ✅ | senate(289) + board(182) + plan(134) + vision(77) + history(85) + status(13) + yhl-speeches(75) + finance(166) = **1,021 청크 임베딩** |
| leesj 임베딩 | ⏳ | adminOnly + lensPersona — Phase C에서 lens-specific 처리 |
| **Semantic Routing** | ✅ | `lib/embed/search.ts:semanticRoutingHints()`, `router.ts`에서 concept-index와 병렬 호출 |
| **Tiered SemRoute 임계값** | ✅ | absoluteMax=1.0 (top-1), tightMax=0.85 (top-2+) — precision/recall 균형 |
| **Forced wiki cap priority** | ✅ | `router.ts:152-172` — SemRoute/concept-index/alwaysContext 위키 cap에서 우선 보존 |
| 증분 갱신 도입 | ✅ | `scripts/build-embeddings.ts` content_hash 비교 (이미 PoC에서 구현) |
| Vercel KV 캐싱 | 🔵 | Phase C 이월 (현재 비용·지연 OK) |
| Golden Q&A 50개 + end-to-end | 🔵 | Phase C 이월 (현재 15개로 충분 검증) |

#### 10.2.2 새 Success Criteria (Phase B)
- **SC11** ✅ 8개 위키 모두 임베딩 완료 (1,021 청크, $0)
- **SC12** ✅ Semantic Routing 작동 — distance 기반 자동 위키 추천
- **SC13** ✅ Forced wiki cap priority — SemRoute 추천 위키가 cap에서 잘리지 않음
- **SC14** ✅ 5개 갭 쿼리(강사료·외국인·교원·장학금·지원금) 모두 finance 포함 라우팅

### 10.3 Phase C (1-2개월 내) ⚡

> **북극성**: *"소스화된 위키 정보를 누락 없이, 필요한 만큼만 잘 가져온다."* (2026-05-19 사용자 명확화)
> Phase C는 이 목표를 *측정 가능한 수준*으로 끌어올리는 단계.

- Lens 모드(leesj)에 RAG 적용 (stance 의미 매칭)
- ~~concept-index를 임베딩 기반으로 자동 생성~~ → Phase B의 Semantic Routing이 사실상 대체. concept-index는 *수동 큐레이션 부스트*용으로만 유지
- Obsidian watch → 자동 재빌드·재임베딩
- **소스 단편화 보완** — 청크 매칭 시 *source 전체* 컨텍스트 옵션 (이미 entity 역참조에 있는 패턴을 벡터 매칭에도 확장). "수치는 잡았는데 단위 누락" 같은 청크 한계 해소
- **End-to-end Golden Q&A 자동화** — `/api/chat` 호출로 실제 라우팅 포함 검증 (PoC의 약점 해소)

### 10.4 Phase D (1-2개월 내) ⚡
- 답변 후 critic 에이전트 (출처 검증·할루시네이션 재검출)
- 멀티스텝 reasoning (Claude tool_use API)
- 사용자별 메모리 (프로필·가치관 가중치)

> **공격적 타임라인 위험 관리**: Phase B를 1주일 내 끝내려면 **PoC(Phase 1-6) 동안 ragEnabled 플래그·증분 갱신 인터페이스를 미리 설계**해서 위키 추가가 *config 한 줄*로 끝나도록 해야 함 → 이는 Design 단계에서 **Option C(Pragmatic Balance)** 선택 시 자연스럽게 보장됨.

---

## 11. 의도적 비스코프 (Out of Scope)

- 다른 8개 위키 임베딩 (Phase A 이후)
- 증분 갱신 (PoC는 전체 재생성)
- UI 변경 (검색 결과 시각화·임베딩 점수 노출)
- Lens 모드 RAG (별도 plan)
- 멀티스텝 reasoning / tool_use
- 답변 후 critic 검증
- 사용자별 메모리
- concept-index 자동 생성

---

## 12. 변경 파일 목록 (PoC)

| 파일 | 변경 내용 | Phase |
|------|---------|:---:|
| `drizzle/0xxx_pgvector.sql` | **신규** — vector 확장 + chunk_embeddings 테이블 + 인덱스 | 1 |
| `lib/db/schema.ts` | chunkEmbeddings 정의 추가 | 1 |
| `lib/embed/voyage.ts` | **신규** — Voyage API 클라이언트 | 2 |
| `lib/embed/chunker.ts` | **신규** — 페이지 타입별 임베딩 단위 변환 | 2 |
| `lib/embed/search.ts` | **신규** — pgvector top-K 검색 | 3 |
| `lib/embed/rrf.ts` | **신규** — RRF 융합 함수 | 3 |
| `scripts/build-embeddings.ts` | **신규** — 위키별 임베딩 빌드 | 2 |
| `scripts/golden-qa.ts` | **신규** — 25개 Q&A 자동 비교 | 4 |
| `scripts/build-wiki-data.ts` | ragEnabled 위키 자동 트리거 추가 | 5 |
| `lib/agents/wiki-agent.ts` | RRF 융합 옵션 추가 (`ragEnabled` 분기) | 3 |
| `lib/agents/types.ts` | AgentConfig에 `ragEnabled?: boolean` 추가 | 1 |
| `data/agents.config.json` | finance만 `ragEnabled: true` | 1 |
| `package.json` | `voyageai`, `pgvector` (drizzle용), 스크립트 추가 | 1 |
| `.env.local` | `VOYAGE_API_KEY` 추가 | 1 |

---

## 13. 참고

- 갭 사례 대화 로그: 2026-05-18 세션 (대학원생 장학금 질문)
- 기존 plan: `docs/01-plan/features/smart-retrieval.plan.md`, `multi-wiki-integration.plan.md`
- 시스템 보고서: `CLAUDE.md`, `docs/SNU_거버넌스_위키_시스템_보고서.md`
- 라우팅 분석: `docs/라우팅_스코어링_상세.md`
- RRF 논문: Cormack et al. 2009, "Reciprocal Rank Fusion outperforms Condorcet and individual Rank Learning Methods"
- pgvector: https://github.com/pgvector/pgvector
- Voyage AI: https://docs.voyageai.com/docs/embeddings

---

## 14. 다음 단계

1. **Plan 승인** ← 지금
2. **Design** — `/pdca design hybrid-rag` (3가지 아키텍처 옵션 제시 예정)
   - Option A: 최소 변경 (WikiAgent 내부에만 RRF 추가)
   - Option B: 클린 아키텍처 (검색 레이어 완전 분리 — `lib/search/` 신설)
   - Option C: 실용적 균형 (기존 인터페이스 유지 + 새 `lib/embed/` 추가, 추천)
3. **Do** — Phase 1-6 순차 구현 (실제 코드)
4. **Check** — Golden Q&A 25개 자동 실행 + 갭 사례 직접 검증
5. **Report** — PoC 결과 + 9개 확장 청사진
