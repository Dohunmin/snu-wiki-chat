# Design: RAG 비용 절감 — 전역 top-K 검색 코어 (Option C 실용 균형)

> **Feature**: rag-cost-reduction
> **Date**: 2026-06-03
> **Phase**: Design (ready for `/pdca do rag-cost-reduction --scope module-N`)
> **Plan**: [rag-cost-reduction.plan.md](../../01-plan/features/rag-cost-reduction.plan.md)
> **Related**: [college-grad-wiki](../../01-plan/features/college-grad-wiki.plan.md)(검색 코어 위에 올라탐), [retrieval-confidence-gate](../../01-plan/features/retrieval-confidence-gate.plan.md)
> **선택 아키텍처**: **Option C — 실용 균형** (검색 파이프라인만 신규 모듈로 분리, 위키별 조립·citation 위생화는 `getContext` 재사용)

---

## Context Anchor (Plan에서 승계)

| 항목 | 내용 |
|---|---|
| **WHY** | 질문당 ~$0.40 중 95%가 입력 13만 토큰, ~70%가 무관 위키. 현 위키는 전체 계획의 <10%이고, "위키 통째 덤프" 구조는 코퍼스 성장에 비용↑·정밀도↓로 스케일 안 됨. 전역 top-K는 코퍼스 크기에 불변 → college-grad-wiki Phase 1 **전에** 검색 코어를 정리. |
| **WHO** | 전체 사용자(동일 품질·저비용) + 운영자(API 비용). 미래: college/grad 26+ 조직. |
| **RISK** | (R1) 컨텍스트 축소 → 닫힌 권위 코퍼스 사실 누락/교차확인(P4) 붕괴. (R2) 키워드로만 잡히는 희귀 고유명사 전역 경쟁 탈락. (R3) silent regression(키워드 살되 교차근거만 소실). (R4) 베이스라인 수치(266청크)가 현 budget=22와 어긋날 수 있음 → 재측정. (R5) 전역 검색이 lensPersona(leesj) 누출. |
| **SUCCESS** | 비용 하락 + golden-qa 회귀 0 + 실제 gold eval answerable→partial 후퇴 0 + 교차근거 위키 분포 비후퇴 + fact/stance 누락 0 + 인용 [N] 집합 누락 0. |
| **SCOPE** | 수정: `lib/embed/{search,rrf,voyage}.ts`, `lib/agents/{router,wiki-agent}.ts`, `lib/llm/{prompts,client}.ts`, `app/api/chat/route.ts`. 신규: `lib/embed/global-retrieve.ts`. 비스코프: LLMLingua 압축, batch API(drop), adaptive-K 단독. |

---

## 1. Overview

### 1.1 목표
"위키 선택 → 위키별 chunkCap 덤프" 검색 구조를 **"전 코퍼스 청크 단위 top-K"** 로 전환하되, **citation 위생화·[N] 넘버링·recency·entity·sources 조립 같은 전투 검증된 코드는 건드리지 않는다**. 검색(retrieve)은 신규 모듈로 분리하고, 조립(assemble)은 `getContext`를 재사용한다.

### 1.2 Option C 핵심 데이터 흐름
```
[router] routeQuery(query, role)
  │
  ├─ globalTopK(query, role, opts)         ← 신규 lib/embed/global-retrieve.ts
  │     1. searchVectorGlobal  (search.ts: WHERE wiki_id 제거 + allowlist 가드 + college/tier 필터)
  │     2. 위키별 키워드 후보 풀(WikiAgent.keywordCandidates) → RRF 융합 (wikiId 키)
  │     3. (선택) Voyage rerank-2.5 → finalK 통과
  │     4. protected union (concept guaranteed pages)
  │     → GlobalChunk[] { wikiId, type, id, title, chunk, score, similarity }
  │
  ├─ partition by wikiId → candidatesByWiki: Map<wikiId, GlobalChunk[]>
  ├─ dispatchWikis = (top-K에 등장한 위키) ∪ (alwaysContext) ∪ (concept-forced) ∪ (recency-eligible if recency)
  │
  └─ for each wiki in dispatchWikis:
        wikiAgent.getContext(query, role, isGlobal, {
          vectorCandidates: candidatesByWiki.get(wikiId) ?? [],   ← 신규 옵션
          guaranteedPageIds, chunkCap,
        })
        // getContext: vectorCandidates 있으면 자체 searchVector/RRF 생략,
        //             validIds 위생화 → coverage → recency → entity → [N]헤더 → sources 그대로
  → AgentContext[]   (citations.buildNumberedContexts 100% 호환)

★ 무관·비protected 위키 = getContext 호출 안 됨 → 0 토큰 (핵심 절감)
```

### 1.3 왜 C인가 (설계 결정)
적대적 검증(Plan §3)이 명시 경고: **"전역 top-K를 router 재작성으로 구현해 조립을 이관하면 회귀 표면이 크다"**(= Option B). C는 **검색 로직만** 깨끗한 모듈로 분리하고, `getContext`의 `validIds` 위생화(`wiki-agent.ts:347-363`)·recency·entity·sources·`## title (id)` 헤더 포맷을 **그대로 재사용**한다. 이로써 `citations.buildNumberedContexts`(헤더 정규식 + `ctx.sources` 의존)가 무수정 호환된다.

---

## 2. Module Map (신규/수정)

| # | 파일 | 변경 | Phase |
|---|---|---|---|
| M0a | `scripts/golden-qa.ts` | finance 단독 → 9위키 확장 + `--baseline` 비교, regression `exit(1)` | 0 |
| M0b | `scripts/eval-gold.ts` | baseline vs 변경후 verdict 후퇴 집계 + 교차근거 위키 분포 diff | 0 |
| M0c | `app/api/chat/route.ts` | 스트림 루프(206-222)에 `message_delta.stop_reason` + `usage` 로깅(`finalMessage()`) | 0 |
| M1a | `lib/llm/prompts.ts` | `agentList`·tier2 경고를 system '맨 끝' 분리(캐시 프리픽스 안정) | 1 |
| M1b | `app/api/chat/route.ts` | system을 `cache_control:ephemeral` 배열로, isContinuation시 본문 캐싱 | 1 |
| M1c | `lib/llm/client.ts` | `MAX_TOKENS 16000→12000` + `LLM_MODEL_LIGHT` 상수(후속용) | 1 |
| M1d | `lib/agents/wiki-agent.ts` | entity 블록(437-442) `cap()` + 매칭강도 top-3 + 단어길이 가드 | 1 |
| M2a | `lib/embed/rrf.ts` | `FusedChunk.similarity?`·`kwScore?` 추가, **both 케이스(94-101) similarity 병합** | 2 |
| M2b | `lib/agents/wiki-agent.ts` | RRF 재분리(312-339)에 similarity·kwScore 전파 + cutoff 필터(399 직전) | 2 |
| M2c | `lib/agents/router.ts` | 선택단계(152-160) 위키 cutoff + fallback(177) 보수화 | 2 |
| **M3a** | `lib/embed/search.ts` | **`searchVectorGlobal()` 신규** (WHERE wiki_id 제거 + allowlist + college/tier) | 3 |
| **M3b** | `lib/embed/rrf.ts` | RRF 키 `type:id` → `wikiId:type:id`(전역 충돌 방지) | 3 |
| **M3c** | `lib/embed/voyage.ts` | `rerankDocuments(query, docs, topN)` 신규 (rerank-2.5) | 3 |
| **M3d** | `lib/embed/global-retrieve.ts` | **신규 — `globalTopK()` 파이프라인** | 3 |
| **M4a** | `lib/agents/wiki-agent.ts` | `getContext` `options.vectorCandidates` 분기(자체 검색 생략) + `keywordCandidates()` 팩토링 | 3 |
| **M4b** | `lib/agents/router.ts` | `globalTopK` 호출 → partition → protected dispatch (env `GLOBAL_TOPK_ENABLED`) | 3 |
| M5 | `scripts/measure-context-size.ts` + shadow harness | 베이스라인 재측정 + shadow eval 비교 | 3 |

---

## 3. 컴포넌트 상세 설계

### 3.1 `searchVectorGlobal` (M3a, `lib/embed/search.ts`)
현 `searchVector`(37-83)의 복제 변형. **유일한 SQL 차이 = `WHERE wiki_id = $` 제거**. 보안·필터는 추가.

```ts
export interface GlobalVectorResult extends VectorSearchResult { wikiId: string; }

export async function searchVectorGlobal(
  query: string,
  userRole: Role,
  k: number,
  opts: {
    allowedWikiIds: string[];     // ★ 보안: routable allowlist (lensPersona/adminOnly 제외)
    college?: string;             // college-grad-wiki 합성 (현재 NULL only)
    tier?: number;                // college-grad-wiki 합성
  },
): Promise<GlobalVectorResult[]>
```
```sql
SELECT id, wiki_id, page_id, page_type, chunk_text, metadata,
       embedding <=> ${lit}::vector AS distance
FROM chunk_embeddings
WHERE wiki_id = ANY(${allowedWikiIds})            -- ★ allowlist = 다층 보안 (R5)
  AND (${sensitiveAllowed} OR sensitive = FALSE)  -- 기존 권한 필터 유지
  ${opts.college ? sql`AND (college = ${opts.college} OR college IS NULL)` : sql``}
  ${opts.tier    ? sql`AND tier = ${opts.tier}` : sql``}
ORDER BY embedding <=> ${lit}::vector
LIMIT ${k}
```
- **`wiki_id`는 컬럼**(`searchVector`가 이미 `WHERE wiki_id`로 씀)이라 `SELECT wiki_id`로 직접 획득 — id 문자열 파싱 불필요.
- `allowedWikiIds` = `getRoutableAgents(role).map(a=>a.config.id)` → leesj(lensPersona)·비admin의 adminOnly 자동 제외(R5 차단, **양성 allowlist라 신규 위키 누출도 원천 방지**).
- `college`/`tier` 술어는 college-grad-wiki(§5) 대비 미리 시그니처에 둠. 현 9위키는 college 컬럼 NULL이라 `OR college IS NULL`로 무영향.

### 3.2 `globalTopK` (M3d, 신규 `lib/embed/global-retrieve.ts`)
```ts
export interface GlobalChunk {
  wikiId: string; type: PageType; id: string; title: string;
  chunk: string; score: number; similarity: number; topic?: string; date?: string; meta?: ChunkMetadata;
  protected?: boolean;   // guaranteed/recency = rerank cutoff 면제
}

export async function globalTopK(query: string, userRole: Role, opts: {
  candidateK: number;          // 후보 풀 (예 80)
  finalK: number;              // 최종 통과 (예 24)
  allowedWikiIds: string[];
  keywordPool: KeywordRankedChunk[];   // 라우터가 모은 cross-wiki 키워드 후보 (wikiId 태그)
  forceIncludeIds?: Map<string, Set<string>>;  // concept guaranteed pages (wikiId → pageIds)
  rerank?: boolean;
  college?: string; tier?: number;
}): Promise<GlobalChunk[]>
```
**파이프라인**:
1. `vec = searchVectorGlobal(query, role, candidateK, {allowedWikiIds, college, tier})`.
2. `fused = rrfFuse(keywordPool, vec, {k:60, limit:candidateK})` — **RRF 키에 wikiId 포함(M3b)** 해 위키 간 동명 페이지 충돌 방지. 희귀 고유명사 recall 보강(R2 방어).
3. `forceIncludeIds`의 청크가 fused에 없으면 targeted 조회로 union + `protected=true`(rerank/cutoff 면제).
4. `rerank` 시 `rerankDocuments(query, fused\protected, finalK - protectedCount)` → protected와 병합.
5. 최종 `finalK` slice, `GlobalChunk[]` 반환.
- 실패(Voyage/DB) 시 throw → **router가 catch해 레거시 per-wiki 경로로 fallback**(회귀 안전).

### 3.3 `rrfFuse` 확장 (M2a + M3b, `lib/embed/rrf.ts`)
- **M2a(Phase 2)**: `FusedChunk`에 `similarity?`·`kwScore?` 추가. **both 케이스(키워드+벡터 동시 매칭, 94-101)에서 `vectorIndex.get(key)?.similarity`를 병합**(검증 핵심 지적 — 누락 시 가장 신뢰할 청크가 similarity=undefined). `kwScore` = RRF로 덮이기 전 키워드 원점수 보존(강매칭 면제 판정용).
- **M3b(Phase 3)**: 키 포맷 `type:id` → `wikiId:type:id`. 전역 융합 시 위키 간 동명 페이지(예: 여러 위키의 "대학운영계획") 충돌 차단. 레거시 per-wiki 호출은 단일 wikiId라 호환.

### 3.4 `rerankDocuments` (M3c, `lib/embed/voyage.ts`)
```ts
export async function rerankDocuments(
  query: string, docs: { id: string; text: string }[], topN: number,
): Promise<{ id: string; relevanceScore: number }[]>
```
- Voyage `rerank-2.5` 엔드포인트. `embedSingleBatch`의 키/재시도/지수백오프 재사용. 실패 시 throw → `globalTopK`가 catch해 RRF 순서 유지(rerank 생략 fallback).
- topN은 고정값 아닌 **relevance 임계(예 0.3) adaptive cutoff** 옵션 — 다면 질문 보조측면 탈락 방지(Plan Open Decision #4).

### 3.5 `getContext` vectorCandidates 분기 (M4a, `lib/agents/wiki-agent.ts`)
```ts
interface GetContextOptions {
  chunkCap?: number; guaranteedPageIds?: Set<string>; lensMode?: boolean;
  vectorCandidates?: GlobalChunk[];   // ★ 신규 — 전역 모드: 사전 융합된 이 위키 청크
}
```
- **`vectorCandidates` 있으면(전역 모드)**: RAG 블록(282-344)의 자체 `searchVector`+`rrfFuse` **생략**. 주입 청크를 `scoredChunks`/`labeledItems`로 매핑 → **`validIds` 위생화(347-363) 그대로 적용**(이 위키 데이터 기준이라 정합) → coverage(373-410)·recency(412-433)·entity(435-442)·`## (id)` 헤더·`sources`(470-477) **전부 unchanged**.
- **`vectorCandidates` 없으면(레거시)**: 현 동작 100% 유지(`GLOBAL_TOPK_ENABLED=false` 또는 globalTopK 실패 fallback).
- **`keywordCandidates(query, role, limit)` 팩토링**: getContext의 키워드 스코어링(소스 점수·청크 점수·labeled, 현 ~133-240)을 호출 가능 메서드로 추출. 라우터가 routable 위키별로 호출해 `globalTopK`의 `keywordPool` 구성. getContext 내부 fallback도 이 메서드 재사용(중복 제거).

### 3.6 `routeQuery` 전역 분기 (M4b, `lib/agents/router.ts`)
```ts
if (process.env.GLOBAL_TOPK_ENABLED === 'true' && !hasGlobalKeyword) {
  try {
    const allowedWikiIds = agents.map(a => a.config.id);
    const keywordPool = collectKeywordPool(agents, query, userRole);   // 각 WikiAgent.keywordCandidates
    const { guaranteedPages } = conceptResult;
    const chunks = await globalTopK(query, userRole, {
      candidateK: 80, finalK: 24, allowedWikiIds, keywordPool,
      forceIncludeIds: guaranteedPages, rerank: true,
    });
    const byWiki = partitionByWiki(chunks);
    const dispatch = new Set([
      ...byWiki.keys(),
      ...agents.filter(a => a.config.alwaysContext).map(a => a.config.id),  // status
      ...forcedWikis,                                                       // concept-forced
      ...(isRecencyQuery ? recencyEligibleWikiIds(agents) : []),            // date 보유 위키
    ]);
    const contexts = await Promise.all([...dispatch].map(id => {
      const agent = registry.get(id);
      return agent.getContext(query, userRole, false, {
        vectorCandidates: byWiki.get(id) ?? [],
        guaranteedPageIds: guaranteedPages.get(id),
        chunkCap: (byWiki.get(id)?.length ?? 0) + PROTECTED_HEADROOM,
      });
    }));
    return assembleResult(contexts);   // 기존 confidence 필터 재사용
  } catch (err) {
    console.error('[globalTopK] failed, falling back to per-wiki', err);
    // ↓ 레거시 경로로 폴스루
  }
}
// ── 기존 per-wiki 경로 (152-233) 그대로 ──
```
- **protected dispatch**가 핵심 안전장치: 전역 top-K에 안 떠도 alwaysContext(status)·concept-forced·recency 위키는 dispatch → 큐레이션·현황·최신성 누락 0(R1/R3 방어).
- `recencyIntent` 감지는 현재 wiki-agent 내부 → 라우터로 끌어올려(`detectRecencyIntent` 재사용) dispatch 판단에 사용.

---

## 4. Protected-Slot 전략 (닫힌 권위 코퍼스 가드)

| Slot | 보호 방법 | 근거 |
|---|---|---|
| **concept guaranteed** | `globalTopK.forceIncludeIds` union + `protected=true`(rerank/cutoff 면제) + 해당 위키 dispatch | 수동 큐레이션 cross-wiki 매핑 누락 차단 |
| **recency** | recency-eligible 위키 dispatch → `getContext` 내 기존 recency 주입(412-433) 그대로 | "최신 안건 자료없음" 오답 방지(가드 도입 사유) |
| **entity** | 매칭 위키 dispatch → `getContext` 내 entity 블록(435-442, Phase 1에서 cap 적용됨) | 인물·기구 질문 핵심 |
| **fact/stance** | RRF 키워드 풀에 포함(`keywordCandidates`가 labeled 반환) + rerank 면제 검토 | 수치·재무 표면 relevance 낮아 cross-encoder가 후순위로 밀 위험 |
| **alwaysContext(status)** | 무조건 dispatch(`ALWAYS_CONTEXT_CAP`) | 대학현황 베이스라인 맥락 |

---

## 5. college-grad-wiki 합성 (§0.2 Plan)

- college의 `college`/`tier` 메타필터(college-grad-wiki §6.3)는 **`searchVectorGlobal`의 `WHERE` 술어로 직접 합성**(3.1) → 별도 검색 경로 불필요. `detectCollege(query)` 결과를 `globalTopK({college})`에 전달.
- college-grad-wiki **SC-10("기존 chunk-budget 준수")·per-wiki `searchVector` 가정은 본 설계로 갱신** 필요 → college design 단계에서 "global top-K + 메타필터"로 재작성(별도 조정 항목).
- college의 T3(구조화 캐시·LLM 스킵)·T4(라이브 페치)는 임베딩 컨텍스트 밖이라 **본 설계와 직교**(무충돌).
- 순서: **본 feature Phase 3 머지 → college-grad-wiki Phase 1 착수**.

---

## 6. 보안 설계

| 위협 | 방어 |
|---|---|
| **lensPersona(leesj) 전역 누출(R5)** | `searchVectorGlobal`이 `wiki_id = ANY(allowedWikiIds)` 양성 allowlist 강제. allowlist = `getRoutableAgents(role)`(lensPersona·비admin adminOnly 제외). 신규 위키 추가돼도 명시 포함 전엔 누출 0. |
| sensitive 자료 | 기존 `(sensitiveAllowed OR sensitive=FALSE)` WHERE 유지(다층). |
| 회귀 테스트 | shadow eval에 "비admin이 leesj 청크 0건" 보안 케이스 포함(M5). |

---

## 7. 검증 & Shadow 모드 (M5)

1. **베이스라인 재측정**: `measure-context-size.ts`로 현 코드(budget=22) 실측 기준선 확정(R4 — 266청크/13만이 budget 22와 모순될 수 있음).
2. **Shadow 모드**: `searchVectorGlobal`/`globalTopK`만 추가하되 실답변엔 미적용. eval-gold 평가자에만 전역 컨텍스트 통과 → 현/전역 verdict 비교.
3. **승격 게이트(동시 충족)**: `answerable→partial/internal-gap 후퇴 0` + `fact/stance 누락 0` + `인용 [N] 집합 누락 0` + `교차근거 위키 분포 비후퇴` + `leesj 누출 0`.
4. **롤아웃**: `GLOBAL_TOPK_ENABLED` env 플래그 보수적 기본값(false) → 단계 활성화.
5. **무비용 회귀**: `npm run qa:golden`(9위키 확장, LLM 0). LLM 검증(eval-gold ~$0.3/회)은 **비용 명시 후 실행**.

---

## 8. Phase ↔ Module 매핑 / 의존

```
Phase 0 (무비용)   : M0a M0b M0c                 ─ 게이트·계측 (모든 후속 전제)
Phase 1 (무위험)   : M1a M1b M1c M1d             ─ 캐싱·max_tokens·entity cap (병행 가능)
Phase 2 (저위험)   : M2a M2b M2c                 ─ similarity 전파 인프라(Phase 3가 재사용) + 레거시 cutoff
Phase 3 (구조전환) : M3a M3b M3c M3d → M4a M4b → M5
                     검색코어 신규 → 통합(env 플래그) → shadow 검증·롤아웃
```
- M2의 similarity 전파 인프라는 **Phase 3 globalTopK의 임계/cutoff에도 재사용**(낭비 아님).
- M3a~M3d(검색 모듈)는 M4(통합)와 분리 가능 — 먼저 모듈+단위테스트 후 통합.

---

## 9. 리스크 & 롤백

| ID | 리스크 | 완화 | 롤백 |
|---|---|---|---|
| R1 | 전역 경쟁이 교차근거·정형데이터 탈락 | protected-slot(§4) + 키워드 RRF 병합 | `GLOBAL_TOPK_ENABLED=false` |
| R2 | 희귀 고유명사 전역 탈락 | keywordPool RRF 병합 필수 | 동상 |
| R3 | silent regression | 교차근거 위키 분포 diff 게이트(M0b) | 동상 |
| R4 | 베이스라인 수치 오염 | M5 재측정 선행 | — |
| R5 | leesj 전역 누출 | allowlist 양성 강제(§6) + 보안 회귀 테스트 | — |
| R6 | getContext 이중모드 복잡도 | vectorCandidates 분기 격리 + 레거시 경로 무수정 | 분기 1개 제거 |

---

## 10. 해소된 설계 질문 / 잔여

**해소**: 검색 위치=C(모듈 분리, 조립 재사용) / wikiId 획득=SELECT 컬럼(파싱 X) / 보안=allowlist / citation 호환=getContext 재사용 / college 합성=WHERE 술어.

**잔여(→ Do 중 결정 또는 Plan Open Decisions)**: ① 유사도 임계 정책(전역 금지, 위키별 상대 vs dist 통일) ② rerank topN vs relevance cutoff ③ Tier0 globalKeyword 전역화 여부 ④ `candidateK`/`finalK` 튜닝값(shadow 데이터로).

---

## 11. Implementation Guide

### 11.1 구현 순서 원칙
Phase 0(게이트) → Phase 1(무위험) → Phase 2(similarity 인프라) → Phase 3(검색코어→통합→shadow). **각 모듈은 게이트 통과 후 머지.** Phase 3 전 베이스라인 재측정 필수.

### 11.2 핵심 파일/계약
- `searchVectorGlobal`: `WHERE wiki_id = ANY(allowlist)` (양성 보안) + college/tier 술어.
- `getContext({vectorCandidates})`: 주입 시 자체 검색 생략, 위생화·조립 그대로.
- 출력 계약 불변: `## title (id) | meta` 헤더 + `ctx.sources` → `buildNumberedContexts` 호환.

### 11.3 Session Guide (Module Map + 권장 세션 분할)

| Session | --scope | 모듈 | 산출 | 게이트 |
|---|---|---|---|---|
| S1 | `module-0` | M0a M0b M0c | golden-qa 9위키 + eval-gold 비교모드 + usage/stop_reason 로깅 | 현 코드 전부 PASS(베이스라인 그린) |
| S2 | `module-1` | M1a M1b M1c M1d | 캐싱·max_tokens·entity cap | golden-qa 출력 동일성(lens·tier2) + 캐시 적중률 로깅 |
| S3 | `module-2` | M2a M2b M2c | similarity 전파 + 레거시 cutoff | 임계 sweep + answerable 후퇴 0 + 교차근거 비후퇴 |
| S4 | `module-3` | M3a M3b M3c M3d | searchVectorGlobal·rrf wikiId·rerank·globalTopK (단위테스트, 미통합) | 단위: allowlist 보안·wikiId 키·rerank fallback |
| S5 | `module-4` | M4a M4b | getContext vectorCandidates 분기 + router dispatch + protected slot (env 플래그) | shadow: verdict/citation/분포/leesj 동시 게이트 |
| S6 | `module-5` | M5 | 베이스라인 재측정 + shadow harness + 단계 롤아웃 | 비용 실측 ≥40% + 품질 게이트 |

권장: **S1·S2 먼저 즉시(무위험·무비용)**, S3는 배선 검증 후, S4~S6는 shadow 데이터 확인하며 단계 진행. college-grad-wiki는 S5 머지 후.

---

## 12. 다음 단계

```
/pdca do rag-cost-reduction --scope module-0     # 무비용 게이트·계측부터
```
이후 module-1 → 2 → 3 → 4 → 5 순. LLM 검증 실행은 비용 명시 후. Phase 3 진입 전 `measure-context-size.ts` 재측정.
