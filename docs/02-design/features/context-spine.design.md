# Design: Context Spine v1 — rerank 순서를 렌더에 살리기 (관련도순 렌더)

> **Feature**: context-spine (v1)
> **Plan**: [docs/01-plan/features/context-spine.plan.md](../../01-plan/features/context-spine.plan.md)
> **Date**: 2026-06-09
> **Phase**: Design (ready for `/pdca do context-spine`)

## Context Anchor

| 항목 | 내용 |
|---|---|
| **WHY** | 배포본(`enforceContextBudget`)이 rerank로 블록을 *선택*은 하면서 **렌더는 원래 per-wiki 순서** → 무관 2021 회의록이 [1][2] 앞 → 억측. rerank는 돌지만 결과가 렌더에서 샘. |
| **WHO** | 전체 사용자(억측↓) + 운영(품질). |
| **RISK** | R2: 한 회의록 내부 시계열이 재정렬로 섞이면 흐름 훼손. |
| **SUCCESS** | 관련 증거가 컨텍스트 상단으로 + 회의록 내부 순서 보존 + **내용 무손실(다양성·recall 구조적 보존)**. |
| **SCOPE** | `lib/agents/context-budget.ts`(렌더 순서) + `scripts/measure-pollution.ts`(무료 검증). |

---

## 1. Overview — v1의 핵심 안전 성질

v1은 **kept 블록을 *재정렬*만 한다 — 추가도 삭제도 안 함.**
→ **다양성(SC2)·recall(SC3)이 *구조적으로* 보존**된다(같은 집합, 순서만 변경). 이게 v1을 *저위험*으로 만드는 핵심. 무료 게이트 대부분이 *정의상* 통과하고, 남는 검증은 "순서가 실제로 나아졌나(무료)" + "답변이 안 나빠졌나(유료 golden-qa)" 둘뿐.

> 대비: 2.2(지우기)는 내용을 바꿔서 다양성 붕괴 위험이 있었음(인용깊이 측정으로 확인 → v1서 제외). v1(재정렬)엔 그 위험이 *없음*.

---

## 2. 아키텍처 옵션 (렌더 입도) — 선택: B

블록을 rerank 순으로 렌더하되 회의록(source) 내부 흐름(R2)을 어떻게 다루나:

| | 입도 | R2(시계열) | 위키 그룹핑 | 비고 |
|---|---|---|---|---|
| **A** | 블록 전역 rerank순 (source 무시) | ❌ 회의록 청크가 흩어짐 | 깨짐 | 최소지만 흐름·그룹핑 손상 |
| **B ✅** | **source-doc 단위 그룹 → 그룹을 best-rerank순 정렬, 그룹 내부는 원순서** + 위키도 best-rerank순 | ✅ 보존 | 유지(위키 단위 출력) | 진단 버그 정확히 해결, 최저위험 |
| **C** | B + 그룹 *내부*도 rerank 재정렬 | ⚠️ 내부 섞임 | 유지 | 과함, R2 위험 |

**선택 = B.** 이유:
- 진단된 오염(senate 안에서 2021이 19기 앞)을 정확히 제거 — source-doc 그룹을 best-rerank로 정렬하면 19기 AI대학원 그룹이 2021 그룹 앞으로.
- 회의록 *내부* 청크 순서는 원본 보존(R2 해결).
- 위키 단위 그룹핑(`### [위키] 관련 자료`)과 [N] 인용 시스템 그대로 — buildNumberedContexts 무수정.

---

## 3. 상세 설계 — `enforceContextBudget` 렌더 교체

### 3.1 현행 (버그)

```
blocks = contexts.flatMap((c,ci) => split(c.relevantData).map(t => ({ci, text:t})))
order  = rerank(blocks)               // rerank desc — 선택엔 씀
keep   = top blocks by order ≤ maxChars
// 렌더: 컨텍스트 원순서 × 블록 원순서  ← 여기서 rerank 결과 버려짐
out = contexts.map(c,ci => kept blocks where ci, in ORIGINAL order)
```

### 3.2 신규 (B — 선택·삭제 불변, *렌더 순서만* 교체)

선택(keep)·예산 로직은 **그대로**. 렌더 단계만 교체:

```ts
// rank 조회: 블록 인덱스 → rerank 순위(작을수록 관련)
const rankOf = new Map<number, number>();
order.forEach((blkIdx, rank) => rankOf.set(blkIdx, rank));

const pageIdOf = (t: string) =>
  t.match(/##\s+(?:\[[^\]]+\]\s+)?[^\n(]*?\(([^()\n]+)\)/)?.[1]?.trim() ?? null;

// 컨텍스트별: kept 블록을 source-doc 그룹화 → 그룹 best-rank순 → 그룹 내부 원순서
const rendered = contexts.map((c, ci) => {
  const mine = blocks
    .map((b, i) => ({ ...b, i }))
    .filter(b => b.ci === ci && keep.has(b.i));
  if (mine.length === 0) return null;

  const groups = new Map<string, typeof mine>();           // sid → 블록(원순서 유지)
  for (const b of mine) {
    const sid = pageIdOf(b.text) ?? `__row${b.i}`;          // 헤더 없는 블록은 단독 그룹
    (groups.get(sid) ?? groups.set(sid, []).get(sid)!).push(b);
  }
  const bestRank = (g: typeof mine) => Math.min(...g.map(b => rankOf.get(b.i) ?? 1e9));
  const orderedGroups = [...groups.values()].sort((a, b) => bestRank(a) - bestRank(b));

  const relevantData = orderedGroups.flatMap(g => g.map(b => b.text)).join(SEP);
  return { ctx: { ...c, relevantData, sources: filterSources(c, relevantData) }, rank: bestRank(mine) };
}).filter(Boolean) as { ctx: AgentContext; rank: number }[];

// 위키(컨텍스트)도 best-rerank순 — 관련 위키가 컨텍스트 상단(cross-wiki lost-in-middle 완화)
rendered.sort((a, b) => a.rank - b.rank);
return rendered.map(r => r.ctx);
```

**불변 보장**: kept 집합·예산·filterSources·citation 매핑 무변경 → 내용·[N] 정합 그대로, *순서만* 바뀜.

### 3.3 비-rerank fallback (`RERANK_ENABLED='false'`)

현행 동기 로직 유지(rank 신호 없음 → 재정렬 안 함). prod 기본은 rerank ON이라 주 경로는 3.2.

---

## 4. `scripts/measure-pollution.ts` (무료 검증)

실제 과거 질문으로, **현행 렌더 vs B 렌더**를 비교:

| 지표 | 측정 | 기대 |
|---|---|---|
| **오염: best 증거 위치** | 현행 렌더에서 rerank 1위 블록이 *몇 번째*에 오나 | 현행 깊음 → B에선 상단 |
| **다양성(SC2)** | kept source 집합 현행 vs B | **동일**(재정렬=무손실 — 구조적 통과 확인) |
| **recall(SC3)** | 인용 source 생존 | 동일(무손실) |
| **신호 깊이** | `measure-citation-depth.ts` 재사용 | 인용 분포(참고) |

→ B는 **무손실이라 SC2/3이 정의상 통과**; 이 스크립트는 "best 증거가 진짜 상단으로 왔나"를 확증.

---

## 5. 검증 게이트

```
1. (무료) measure-pollution: best 증거 상단 이동 확인 + 무손실(집합 동일) 확인
2. (무료) test:governance 19/19 + tsc 0
3. (무료) RERANK_ENABLED=false면 현행과 byte-identical (fallback 불변)
4. (유료·별도 보고) golden-qa: 답변 무회귀(재정렬이 답을 나쁘게 안 함) — AI대학원 단정 사라짐 확인
5. → main 푸시
```

## 6. Module Map / 구현 순서

| # | 파일 | 작업 | 의존 |
|---|---|---|---|
| M1 | `lib/agents/context-budget.ts` | 3.2 렌더 교체 (+pageIdOf 헬퍼) | — |
| M2 | `scripts/measure-pollution.ts` | 4 지표 (measure-citation-depth 재사용) | M1 |
| M3 | 검증 | §5 게이트 1~3(무료) | M1·M2 |

→ `/pdca do context-spine --scope M1` 부터.

## 7. Risks / Edge

| | 완화 |
|---|---|
| R2 회의록 내부 섞임 | B가 그룹 *내부* 원순서 보존 → 발생 안 함 |
| pageId 추출 실패 블록 | `__row{i}` 단독 그룹 → 자기 rank로 배치(누락 0) |
| alwaysContext(status) 뒤로 밀림 | 의도된 동작(관련도순). status는 보통 저관련 — 문제 시 floor 부여 검토 |
| 답변 회귀(드물게 LLM이 옛 순서 선호) | golden-qa(§5-4) 게이트 후 푸시 |

---

**요약**: rerank는 이미 돌고 있다 → v1은 그 결과를 *렌더에 살리는* 것뿐. 내용 무손실이라 다양성·recall은 공짜로 안전, 회의록 흐름은 source-doc 그룹핑으로 보존. 무료 게이트 통과 → 유료 golden-qa 한 번 → 푸시.
