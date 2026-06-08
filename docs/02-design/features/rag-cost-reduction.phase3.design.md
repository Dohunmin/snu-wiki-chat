# Design: Phase 3 — 전역 top-K 검색 코어 (상세 설계)

> **Feature**: rag-cost-reduction / Phase 3
> **Date**: 2026-06-03
> **Phase**: Design (deep) — `rag-cost-reduction.design.md` §3·§7·§8을 Phase 3에 한해 심화·대체
> **선행 완료**: module-0(검증 인프라)·module-1(위생)·module-2(similarity 배선) — 브랜치 `rag-cost-reduction` c8163e3·824f3d0
> **전제**: Option C(검색 파이프라인만 신규 모듈, getContext 조립·citation 위생화 재사용) 확정

---

## 0. 정직한 출발점 (왜 이건 다른가)

module-1·2는 **측정상 ~2%만 절감**했다. 이유가 명확하다: 그것들은 "이미 고른 위키 안에서 청크를 깎는" 것이었는데, **진짜 토큰 낭비는 "위키를 6개나 골라 각자 덤프하는"(inter-wiki over-retrieval)** 데서 온다. 실측: 평균 질문이 **46.6k자 / 위키 6개**, 무거운 질문은 138k자(그중 ~70%가 무관 위키).

Phase 3는 이 구조를 바꾼다 — 표준 production RAG처럼 **"위키 선택→덤프"를 "전 코퍼스 청크 단위 top-K"로**. 이건 cheap fix와 **구조적으로 다르다**(근본원인을 직접 제거).

**그러나 — 또 과장하지 않는다. 두 가지 리스크를 정면으로 다룬다:**
1. **절감이 기대만큼 안 날 수 있다** — protected 슬롯(status·recency·fact 등)이 토큰을 점유하면 절감폭이 준다. → **§1: 빌드 전에 무료로 절감을 먼저 추정·증명**한다.
2. **품질이 깨질 수 있다** — 닫힌 권위 코퍼스에서 큐레이션/정형/최신 데이터가 전역 경쟁에 밀리면 사실 누락. → **§5: protected-slot으로 강제 보존 + §6: shadow로 증명 후에만 flip**.

---

## 1. ⭐ Step 0 — 빌드 전 무료 절감 추정 (돈 쓰기 전 게이트)

**아무것도 만들기 전에**, 전역 top-K가 실제로 얼마나 줄일지 **무료로(Voyage만)** 추정한다. 이게 빈약하면 Phase 3를 안 짓는다.

`scripts/estimate-global-topk.ts` (신규, LLM 0):
```
실제 gold 61질문 각각:
  routeQuery로 현재 선택된 위키별 컨텍스트 char수 측정 (= 현 베이스라인)
  semanticRoutingHints의 위키별 min-dist로 위키를 근접순 정렬
  "상위 2개 위키 + protected(status·concept·recency) char" vs "전체 char" 비율 계산
출력: 질문별 / 평균 "전역 top-K가 보존할 char 비율" → 1 - 그 비율 = 추정 절감률
```
- **게이트**: 추정 평균 절감 **< 25%면 Phase 3 보류**(투자 대비 효과 부족, 다른 방향 재검토). **≥ 35%면 진행**. 25~35%면 사용자 판단.
- 비용 **$0**(Voyage 임베딩만, 이미 routing이 쓰는 것). 시간 ~3분.
- 이 단계가 이전 실패(짓고 나서 효과 없음을 발견)를 막는다.

> 정직한 예상: 무거운 질문은 ~60-75%, 평균은 ~30-45% 추정. 단 **추정이지 약속이 아니다** — Step 0이 실측으로 확정.

---

## 2. 토큰 예산 모델 (절감이 어디서 나오나)

평균 질문 46.6k자 = 대략:
| 구성 | 추정 비중 | Phase 3 후 |
|---|---|---|
| 관련 위키(1~2개) 청크 | ~30~40% | **유지**(전역 top-K가 고름) |
| 무관 위키(3~5개) 비-protected 청크 | ~45~60% | **제거**(top-K 경쟁 탈락) ← 절감 핵심 |
| protected(status 5청크 + 발동 시 recency/entity/fact) | ~10~20% | **유지**(강제 보존) |

→ 절감 = "무관 위키 비-protected 청크". protected가 클수록 절감↓. 그래서 finalK(§4)와 protected 범위(§5)가 절감/품질의 균형점. **Step 0이 이 비중을 질문별로 실측**한다.

---

## 3. 아키텍처 (Option C) — 데이터 흐름

```
routeQuery(query, role)
  │  [GLOBAL_TOPK_ENABLED=true && !hasGlobalKeyword 일 때만]
  ├─ allowedWikiIds = getRoutableAgents(role).map(id)        ← lensPersona/adminOnly 제외(보안)
  ├─ keywordPool   = routable 위키들의 WikiAgent.keywordCandidates(query)  ← 희귀 고유명사 recall(§5.2)
  ├─ globalTopK(query, role, {candidateK, finalK, allowedWikiIds, keywordPool, forceIncludeIds})
  │     1. searchVectorGlobal  → 전 코퍼스 벡터 top-candidateK (wikiId 포함)
  │     2. rrfFuse(keywordPool, vec, wikiId 키)  → 키워드+벡터 융합
  │     3. forceIncludeIds(concept guaranteed) union, protected=true
  │     4. [3b] rerank → finalK / 또는 RRF 상위 finalK
  │     → GlobalChunk[] { wikiId, type, id, title, chunk, score, similarity, protected }
  ├─ byWiki = partition(GlobalChunk[], wikiId)
  ├─ dispatch = byWiki.keys ∪ alwaysContext ∪ conceptForced ∪ (recency면 dateWikis)
  └─ for wiki in dispatch:
        getContext(query, role, false, { vectorCandidates: byWiki.get(wiki) ?? [], guaranteedPageIds, ... })
            → vectorCandidates 있으면 자체 검색 생략, validIds 위생화·recency·entity·[N]헤더·sources 그대로
  → AgentContext[]  →  buildNumberedContexts (무수정 호환)

무관·비protected 위키 = dispatch 안 됨 → 0 토큰
실패(Voyage/DB) → catch → 기존 per-wiki 경로 fallback (회귀 안전)
```

---

## 4. 컴포넌트 상세

### 4.1 `searchVectorGlobal` (`lib/embed/search.ts` 신규)
`searchVector`(37-83) 복제, **`WHERE wiki_id` 제거 + allowlist/college 추가**.
```ts
export interface GlobalVectorResult extends VectorSearchResult { wikiId: string; }

export async function searchVectorGlobal(query: string, userRole: Role, k: number, opts: {
  allowedWikiIds: string[];     // ★ 보안: routable allowlist (lensPersona/adminOnly 제외)
  college?: string; tier?: number;  // college-grad-wiki 합성(현 9위키 NULL → 무영향)
}): Promise<GlobalVectorResult[]>
```
```sql
SELECT id, wiki_id, page_id, page_type, chunk_text, metadata,
       embedding <=> ${lit}::vector AS distance
FROM chunk_embeddings
WHERE wiki_id = ANY(${allowedWikiIds})            -- 양성 allowlist = 다층 보안
  AND (${sensitiveAllowed} OR sensitive = FALSE)  -- 기존 권한 필터 유지
  ${opts.college ? sql`AND (college = ${opts.college} OR college IS NULL)` : sql``}
  ${opts.tier ? sql`AND tier = ${opts.tier}` : sql``}
ORDER BY embedding <=> ${lit}::vector
LIMIT ${k}
```
- `wiki_id`는 컬럼이라 `SELECT`로 직접 획득(id 파싱 불필요).
- `allowedWikiIds`가 leesj(lensPersona) 누출을 SQL 레벨에서 원천 차단(R5). **신규 위키도 명시 포함 전엔 누출 0.**

### 4.2 `WikiAgent.keywordCandidates()` (`lib/agents/wiki-agent.ts` 신규 — getContext에서 추출)
getContext의 키워드 스코어링(137-277: sourcesWithScore→scoredChunks→labeledItems)을 **호출 가능 메서드로 팩토링**.
```ts
keywordCandidates(query: string, role: Role, limit = 12): KeywordRankedChunk[]
  // 이 위키 데이터에서 키워드 점수 상위 limit개 (source 청크 + fact/overview),
  // wikiId 태그. DB/API 0 (순수 in-memory). getContext 내부 fallback도 이걸 재사용(중복 제거).
```
- 라우터가 **prefilterScore > 0인 routable 위키**에만 호출(범위 한정, 무관 위키 스킵 → CPU 절약).
- 목적: 벡터가 놓치는 **희귀 고유명사·정확매칭**(회차ID·인명) recall(R2 방어).

### 4.3 `globalTopK` (`lib/embed/global-retrieve.ts` 신규)
```ts
export interface GlobalChunk {
  wikiId: string; type: PageType; id: string; title: string;
  chunk: string; score: number; similarity?: number; kwScore?: number;
  topic?: string; date?: string; meta?: ChunkMetadata;
  protected?: boolean;   // guaranteed/recency = rerank/cutoff 면제
}
export async function globalTopK(query, userRole, opts: {
  candidateK: number; finalK: number; allowedWikiIds: string[];
  keywordPool: KeywordRankedChunk[]; forceIncludeIds?: Map<string, Set<string>>;
  rerank?: boolean; college?: string; tier?: number;
}): Promise<GlobalChunk[]>
```
파이프라인:
1. `vec = searchVectorGlobal(query, role, candidateK, {allowedWikiIds, college, tier})`.
2. `fused = rrfFuse(keywordPool, vec, {k:60, limit:candidateK})` — **RRF 키 `wikiId:type:id`(§4.6)** + module-2의 similarity/kwScore 전파 그대로 활용.
3. `forceIncludeIds`(concept guaranteed) 청크가 fused에 없으면 targeted 조회로 union + `protected=true`.
4. `rerank`면 §4.7, 아니면 fused 상위 `finalK` slice(단 protected는 무조건 포함).
5. wikiId를 id에서/결과에서 부여해 `GlobalChunk[]` 반환.
- 실패 시 throw → router가 catch해 per-wiki fallback.

### 4.4 `getContext` vectorCandidates 분기 (`lib/agents/wiki-agent.ts`)
```ts
// GetContextOptions에 추가:
vectorCandidates?: GlobalChunk[];   // 전역 모드: 사전 융합된 이 위키 청크
```
- **있으면(전역 모드)**: RAG 블록(282-344)의 자체 `searchVector`+`rrfFuse` **생략**. 주입 청크를 `scoredChunks`/`labeledItems`로 매핑(similarity/kwScore 포함) → **`validIds` 위생화(347-363) 그대로** → coverage 균등화(373-410, source 중복 제거 유지)·recency(412-433)·entity(435-442, module-1 cap)·`## (id)` 헤더·`sources`(470-477) **전부 unchanged**.
- **없으면(레거시)**: 현 동작 100% 유지(flag off / globalTopK 실패 fallback).
- ⚠️ 전역 모드에선 자체 키워드 스코어링·RRF·재정렬을 **재실행하지 않는다**(전역 랭킹을 덮으면 안 됨). 주입 청크 → 위생화 → 조립만.

### 4.5 `routeQuery` 전역 분기 (`lib/agents/router.ts`)
§3 의사코드대로. 핵심:
- `dispatch` = 전역 top-K 등장 위키 ∪ **protected 위키**(alwaysContext=status, concept-forced, recency 질문 시 date 보유 위키).
- protected 위키는 top-K에 없어도 dispatch(빈 vectorCandidates면 getContext가 자체 데이터로 recency/entity/guaranteed 생성).
- 출력은 기존 `confidence > 0.3` 필터 + AgentContext[] 재사용.

### 4.6 `rrf.ts` wikiId 키 (`lib/embed/rrf.ts`)
키 `type:id` → `wikiId:type:id`(48-58, 81-90). 전역 융합 시 위키 간 동명 페이지(여러 위키의 "대학운영계획") 충돌 방지. `KeywordRankedChunk`/`VectorSearchResult`에 wikiId 주입 필요. **레거시 per-wiki 호출은 단일 wikiId라 호환.**

### 4.7 rerank (`lib/embed/voyage.ts`) — **3b로 분리(선택)**
`rerankDocuments(query, docs, topN)` (Voyage rerank-2.5). **첫 Phase 3(3a)에선 생략** — 전역 top-K만으로 절감 대부분 확보. 정밀도 부족이 shadow에서 확인되면 3b로 추가(protected는 rerank 면제). 복잡도·지연·비용을 첫 컷에서 배제해 리스크 축소.

---

## 5. Protected-Slot 전략 (품질의 핵심)

닫힌 권위 코퍼스 — 이게 무너지면 사실 누락. 각 슬롯이 전역 경쟁에서 **반드시 살아남는** 경로:

| Slot | 보존 방법 | 안 하면 |
|---|---|---|
| **concept guaranteed**(큐레이션 cross-wiki) | `globalTopK.forceIncludeIds` union + `protected` + 해당 위키 dispatch | 큐레이션 매핑 누락 |
| **recency**(최신 안건) | recency-eligible 위키 dispatch → getContext 내 기존 주입(412-433) 그대로 | "최신 안건 자료없음" 오답 |
| **entity**(인물·기구) | 매칭 위키 dispatch → getContext entity 블록(module-1 cap) | 인물 질문 근거 소실 |
| **fact/stance**(정형·입장) | keywordPool에 포함(keywordCandidates가 labeled 반환) + (3b)rerank 면제 | 수치/입장 질문 핵심 누락 |
| **alwaysContext**(status 대학현황) | 무조건 dispatch(`ALWAYS_CONTEXT_CAP`) | 현황 baseline 소실 |

**원칙: 의심스러우면 dispatch.** dispatch된 위키가 빈 vectorCandidates여도 getContext가 자체 데이터로 recency/entity/guaranteed를 생성하므로 protected 경로는 전역 모드에서도 작동. **절감은 "dispatch 안 된 무관 위키"에서만** 나온다 — protected를 건드리지 않는다.

---

## 6. Shadow 검증 프로토콜 (싸게 증명 후에만 flip)

**flip 전에 품질을 증명한다. 그리고 싸게.**

| 단계 | 방법 | 비용 |
|---|---|---|
| **S0** | §1 무료 절감 추정 (빌드 전 게이트) | **$0** |
| **S1** | 빌드 후 `GLOBAL_TOPK_ENABLED`로 **golden-qa self-baseline**: 전역 모드 컨텍스트 char 측정 → 실제 절감률 + 카타스트로픽 0 + finance 픽스처 PASS 확인 | **$0**(Voyage) |
| **S2** | **eval-gold 비교**(전역 vs 현행, Haiku): `answerable→그외 후퇴 0` + 교차근거 위키 분포 비후퇴 + (코드로) fact/stance 청크·인용 [N] 집합 누락 0 | **~$0.3**(61질문 1회) |
| **S3**(조건부) | S2가 애매한 질문 **5~8개만** 실제 Sonnet 답변 현행 vs 전역 비교(사람 검수) | **~$3~4**(상한 명시·승인 후) |

- **flip 게이트**: S1 절감 ≥ S0 추정의 70% **AND** S2 후퇴 0 **AND** 보안(leesj 누출 0). 하나라도 실패면 flip 보류.
- 비용 합계 **~$0.3**(S3 안 가면). S3은 상한 고지 후 승인 시에만.
- **이전 실패 교훈 적용**: 무료(S0·S1)로 거의 다 거르고, 유료(S2)는 1회, S3은 최후·소량.

---

## 7. 보안

| 위협 | 방어 |
|---|---|
| lensPersona(leesj) 전역 누출(R5) | `searchVectorGlobal` `WHERE wiki_id = ANY(allowedWikiIds)` 양성 allowlist. allowlist=`getRoutableAgents(role)`. S2에 "비admin leesj 청크 0" 회귀 케이스 포함 |
| sensitive | 기존 `(sensitiveAllowed OR sensitive=FALSE)` WHERE 유지 |

---

## 8. finalK / 예산 설계 + 유사도 floor (무관 청크 방어)

- **candidateK**(후보 풀): ~80 (넓게 뽑아 recall 확보).
- **finalK**(LLM 통과 상한): **shadow로 튜닝**. 시작 ~24. protected는 finalK 밖 별도 보장.
- env 오버라이드(`GLOBAL_FINAL_K`)로 코드 재편집 없이 sweep.

### 8.1 ★ 유사도 floor → adaptive-K (순수 벡터 false positive 방어)
**핵심 위험**: 순수 top-K는 관련 청크가 적어도 finalK를 "그나마 덜 먼 청크"로 **강제로 채운다** → 사람 눈엔 무관한 청크가 답변 컨텍스트에 들어감(예: §예시2 leesj 누출, OOD dist 겹침).

**방어 — finalK는 *상한*이지 *목표*가 아니다:**
- top-K 후 **similarity floor 미달 청크는 버린다**(module-2 `SIM_CUT_CHUNK` 배선 재사용). 관련 청크가 8개뿐이면 8개만 통과(24 강제 채움 금지).
- floor는 dist 정렬 보수값(sweep)으로, **키워드 강매칭(kwScore)·guaranteed·protected는 floor 면제**(R2 — 희귀 고유명사 보존).
- 효과: 무관 청크 유입 억제 + 좁은 질문에서 추가 절감(이중 이득). adaptive-K를 "질문 분류"(오분류 위험) 대신 **유사도 floor**로 구현 — 분류기 불필요, 데이터 기반.
- **reranker(3b)** 도입 시 cross-encoder가 floor 위 청크 중 "가깝지만 무관"을 추가 강등(가장 강한 방어).
- **shadow S2가 측정**: 무관 청크가 답을 오염시키면 answerable→후퇴/오판정으로 검출.

---

## 9. 실패 모드 & fallback
| 상황 | 처리 |
|---|---|
| Voyage/DB 실패 | globalTopK throw → router catch → **per-wiki 레거시 경로**(현행 그대로) |
| 전역 top-K가 어떤 위키도 안 뽑음 | protected dispatch는 여전히 작동(status 등) + fallback |
| 주입 후 getContext 빈 결과 | confidence 0.3, buildNumberedContexts 빈 처리(크래시 없음) |
| flag off | 전역 경로 완전 우회 = 현행 |

---

## 10. 리스크 (정직)
| ID | 리스크 | 완화 |
|---|---|---|
| R1 | **절감이 기대 미달**(protected 점유) | §1 무료 추정으로 빌드 전 차단 + §8 finalK 튜닝 |
| R2 | 희귀 고유명사 전역 탈락 | keywordPool RRF 병합 필수 |
| R3 | 정형/큐레이션/최신 누락 | §5 protected-slot 강제 dispatch/union |
| R4 | silent regression | S2 교차근거 분포 + fact/[N] 누락 게이트 |
| R5 | leesj 누출 | allowlist + 보안 회귀 테스트 |
| R6 | getContext 이중모드 복잡도 | vectorCandidates 분기 격리 + 레거시 무수정 + flag |
| R7 | **또 과지출** | S0·S1 무료 우선, 유료 1회, 대형 워크플로우 금지(직접 구현) |

---

## 11. 구현 서브모듈 & 순서

| # | scope | 내용 | 비용 |
|---|---|---|---|
| **P3-0** | `estimate-global-topk.ts` | §1 무료 절감 추정 **(게이트 — 여기서 ≥35% 아니면 중단)** | $0 |
| **P3a-1** | search.ts·rrf.ts | searchVectorGlobal + wikiId 키 (단위테스트: allowlist 보안·키 충돌) | $0 |
| **P3a-2** | wiki-agent.ts | keywordCandidates 팩토링 + vectorCandidates 분기 | $0 |
| **P3a-3** | global-retrieve.ts | globalTopK 파이프라인(rerank 없이) | $0 |
| **P3a-4** | router.ts | 전역 분기 + protected dispatch + flag | $0 |
| **P3a-5** | shadow 검증 | S1(무료) → S2(~$0.3) → flip 판단 | ~$0.3 |
| **P3b**(선택) | voyage.ts | rerank — S1/S2서 정밀도 부족 시에만 | ~$0.1 |

각 단계 tsc + golden-qa(무료). **P3-0 게이트를 통과 못 하면 짓지 않는다.**

---

## 12. Open Decisions
1. **finalK 기본값** — shadow 탐색(24 시작).
2. **rerank(3b) 도입 여부** — S1/S2 정밀도 보고 결정.
3. **Tier0 globalKeyword('전체/종합') 질문** — 전역으로 줄일지 full coverage 유지(의도적 망라). 별도.
4. **college-grad-wiki 합성** — `college`/`tier` 술어 이미 시그니처에 반영, college design 단계서 SC-10 갱신.

---

## 13. Go/No-Go (정직한 기준)
- **Go**: P3-0 무료 추정 평균 절감 **≥35%** + S2 후퇴 0 전망.
- **No-Go/보류**: 추정 < 25% → Phase 3가 이 코퍼스엔 효과 부족 → 솔직히 접고 다른 방향(예: 답변 캐싱, 질문 라우팅 정밀화) 재검토.
- 25~35% → 사용자 판단(절감 vs 구현 리스크).

**이 설계의 약속은 "절감 X%"가 아니라 "돈 쓰기 전에 X를 무료로 확정한다"이다.**
