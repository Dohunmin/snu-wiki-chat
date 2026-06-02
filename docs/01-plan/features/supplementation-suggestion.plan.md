# Plan: Supplementation Suggestion — 한계 영역 자료 보충 제언 (Sonnet + 웹 검색)

> **Feature**: supplementation-suggestion
> **Date**: 2026-05-27
> **Phase**: Plan

---

## Executive Summary

| 항목 | 내용 |
|---|---|
| **Problem** | limitation-tracking이 "어떤 주제에 자료가 부족한지" 식별까지 함. 그러나 그 다음 — "그래서 무슨 자료를 어디서 채워야 하나" — 는 관리자가 한계 영역마다 직접 조사해야 해서 비효율 |
| **Solution** | 한계 클러스터 **+ 한계 outlier 질문 모두**에 대해 Sonnet이 보충 제언 생성 — (1) 어떤 자료 유형을 채우면 좋은지, (2) Anthropic web_search 서버 도구로 외부 출처 후보 제시. 관리자 "제언 생성" 버튼 클릭 시 batch 처리. suggestions.json에 캐싱 (클러스터=멤버 동일 / outlier=질문 ID 영구) |
| **UX Effect** | 한계 클러스터마다 "💡 보충 제언" + "🌐 외부 출처 후보"가 Admin UI에 표시. 관리자가 자료 보충 작업을 바로 착수할 수 있는 액션 아이템 확보 |
| **Core Value** | "갭 식별"에서 "갭 해소 방향 제시"로 — 자료 보충 의사결정의 마지막 단계를 자동화 |

---

## Context Anchor

| 항목 | 내용 |
|---|---|
| **WHY** | limitation-tracking으로 한계 영역은 보이지만, 보충 방향은 사람이 매번 조사. 한계 클러스터에 Sonnet+웹검색으로 "이런 자료를 이런 출처에서 보충" 제언하면 액션으로 직결 |
| **WHO** | 관리자 — 자료 보충 실행 주체 |
| **RISK** | (1) web_search 비용·속도 (검색당 과금, 건당 수 초). outlier 포함 시 ~34개 제언. (2) Sonnet 제언이 일반론에 그칠 위험. (3) web_search 결과가 부정확/무관 출처일 수 있음. (4) batch 처리 중 timeout |
| **SUCCESS** | (1) 한계 클러스터 + outlier 질문별 제언 생성, (2) 외부 출처 후보 1개 이상 포함, (3) "제언 생성" 버튼 batch 동작, (4) 캐싱(클러스터=멤버/outlier=질문ID) 재호출 안 함, (5) Admin UI에 제언 표시, (6) 비-admin 차단 |
| **SCOPE** | `lib/limitations/suggest.ts` 신규 (Sonnet+web_search+캐싱) / `lib/limitations/types.ts` 확장 (Suggestion 타입) / `app/api/admin/limitations/suggest/route.ts` 신규 (batch POST) / `components/admin/LimitationsView.tsx` 확장 (버튼+제언 표시) / `public/limitation-suggestions.json` 신규 캐시 |

---

## 1. 현재 상태 & 문제

limitation-tracking 완성 ([커밋 4e917ac~623b122](docs/02-design/features/limitation-tracking.design.md)):
- `/admin/limitations` — 한계 클러스터 + outlier 표시, 한계율 정렬
- 한계율 100% 클러스터 실측: "장학금 추이", "이석재 후보 연계", "단과대별 표심", "재무정보 공시 데이터"

그러나 관리자가 보는 건 **"한계 N건"까지**. "그래서 뭘 채우지?"는 직접 고민. 한계 영역마다:
- 어떤 자료 유형이 필요한지 (회의록? 통계? 규정?)
- 어디서 구할 수 있는지 (서울대 공식 페이지? 정부 자료? 언론?)

를 매번 수동 조사 — 자료 보충의 병목.

---

## 2. 해결 — Sonnet + web_search 제언

### 2.1 흐름

```
관리자 "제언 생성" 버튼 클릭
  ↓
suggest({ maxNew: N }) — 1 batch 처리 (제언 없는 한계 항목 N개)
  제언 대상 = 한계 클러스터 + 한계 outlier 질문
  ↓
각 항목마다 (클러스터 또는 outlier 질문):
  1. 컨텍스트 수집:
     - 클러스터: 질문들 묶음 + 한계 발췌 + 위키
     - outlier: 질문 1개 + 한계 발췌 + 위키
  2. Sonnet 호출 (web_search 도구 장착):
     - "이 한계 주제에 어떤 자료를 보충하면 좋을지 + 외부 출처 후보 검색"
  3. 응답 파싱: 보충 제언(자료 유형) + 외부 출처(URL + 제목)
  ↓
suggestions.json에 항목별 캐싱
  - 클러스터 key "cluster:7" (memberIds 검증)
  - outlier  key "outlier:{questionId}" (질문 불변 → 영구)
  ↓
hasMore=true이면 클라가 자동 재호출 (limitation refresh와 동일 batch 패턴)
```

### 2.2 핵심 결정 (Checkpoint 2 합의)

| 결정 | 선택 | 이유 |
|---|---|---|
| 제언 대상 | **모든 한계 답변 커버 (52건)** | outlier든 한계1 클러스터든 자료 부족 신호는 동일. 일부 제외하면 모순 |
| 제언 단위 | 한계≥2 클러스터=묶음 / 그 외(한계1 클러스터 + outlier)=개별 질문 | 같은 주제 복수 질문은 묶고, 독립 질문은 개별 |
| 컨텍스트 | 질문 + 한계 발췌 **+ 답변 본문(1500자 cap)** ⚠️미결정 | 발췌만으론 맥락 부족. 본문 포함 시 비용 ~$0.5↑ (§2.7) — 사용자 결정 대기 |
| 외부 출처 | **web_search 사용** | 실시간 외부 출처 후보 제시 — 제언 실용성 ↑ |
| 트리거 | **별도 "제언 생성" 버튼** | web_search 느리고(건당 수초) 과금 — 명시적 실행 |
| 저장 | **별도 `public/limitation-suggestions.json`** | 관심사 분리, key prefix(cluster:/question:)로 구분 |
| 캐싱 | **클러스터=멤버 동일 / 개별=질문ID 영구** | web_search 재호출 최소화. 질문은 불변이라 영구 캐싱 |
| Batch | **batch 자동 반복** (limitation refresh와 동일) | web_search 대량(38) 시 timeout 회피 |

### 2.3 제언 대상 기준 (실측 확정)

```
제언 단위 =
  (A) 묶음 제언: clusterId >= 0 AND 클러스터 내 한계 답변 수 >= 2
  (B) 개별 제언: 그 외 모든 한계 답변
        = (clusterId >= 0 AND 클러스터 한계 1건)  ← 사실상 outlier
        + (clusterId === -1 AND limitation)        ← outlier
```

실측(2026-05-27, eps=0.40, 한계 52건):

| 분류 | 제언 수 | 커버 한계 질문 |
|---|---:|---:|
| (A) 묶음 — 한계≥2 클러스터 | 7개 | 21건 |
| (B) 개별 — 한계1 클러스터 | 4개 | 4건 |
| (B) 개별 — outlier 한계 | 27개 | 27건 |
| **합** | **38개 제언** | **52건 (누락 0)** |

(A) 묶음 7개 = [0]재정·거버넌스(7), [7]장학금추이(3), [12]이석재연계(3), [2]역대총장(2), [3]유홍림업적(2), [10]단과대표심(2), [11]재무공시데이터(2).

> Do phase에서 batch size·web_search 횟수 조정 가능.

### 2.4 Sonnet + web_search 프롬프트

```ts
// tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }]
const prompt = `서울대학교 거버넌스 위키 챗봇에서 다음 주제에 대한 사용자 질문들이
자료 부족으로 제대로 답변되지 못했습니다.

주제: {clusterLabel}
관련 위키: {wiki}

답변 못한 질문들:
{questions}

한계 사유 (답변에서 발췌):
{limitationExcerpts}

다음을 한국어로 제시하세요:
1. 💡 보충 자료 제언: 이 질문들에 답하려면 어떤 자료를 위키에 추가해야 하는가?
   (자료 유형 3~5개 — 회의록/통계/규정/계획서 등 구체적으로)
2. 🌐 외부 출처: web_search로 관련 공식 자료·출처를 찾아 후보 제시
   (서울대 공식 페이지, 정부 자료, 언론 등 — URL과 제목)

간결하게. 추측성 일반론 금지 — 실제 존재할 법한 자료·출처만.`;
```

web_search 결과는 SDK가 자동으로 tool_use/tool_result 처리 + 최종 text에 citation 포함.

### 2.5 데이터 구조 (`limitation-suggestions.json`)

```json
{
  "suggestions": {
    "cluster:7": {
      "kind": "cluster",
      "clusterId": 7,
      "memberIds": ["uuid1", "uuid2", "uuid3"],
      "label": "최근 학부·대학원생 장학금 추이",
      "wiki": "plan",
      "materialSuggestions": ["장학금 수혜 현황 통계 (연도별)", "장학복지위원회 회의록"],
      "externalSources": [{ "title": "서울대 학생복지 장학", "url": "https://..." }],
      "generatedAt": "2026-05-27T..."
    },
    "outlier:uuid9": {
      "kind": "outlier",
      "questionId": "uuid9",
      "question": "고가 장비 전문 관리자 고용 방법은?",
      "wiki": "status",
      "materialSuggestions": ["공동기기원 운영 규정", "연구지원 인력 채용 지침"],
      "externalSources": [{ "title": "서울대 공동기기원", "url": "https://..." }],
      "generatedAt": "2026-05-27T..."
    }
  },
  "updatedAt": "..."
}
```

### 2.6 Batch + 캐싱

- `suggest({ maxNew })` — 제언 없는(또는 stale) 한계 항목 중 N개 처리
- 캐싱 검증:
  - 클러스터: 기존 `memberIds` set과 현재 멤버 비교 → 동일하면 skip
  - outlier: `outlier:{questionId}` 존재하면 skip (질문 불변 → 영구 유효)
- hasMore = 처리 안 된 한계 항목 더 있나 (클러스터 + outlier 통합 카운트)
- 클라이언트가 hasMore=true이면 자동 재호출

web_search가 항목당 수 초 걸리므로 batch size 작게 (예: 3~5개). 38개면 ~8~13 batch.

### 2.7 비용 분석 (claude-sonnet-4-6: input $3/MTok, output $15/MTok, web_search $10/1,000 검색 추정)

⚠️ **컨텍스트 미결정 — 케이스 A/B 중 사용자 결정 대기**

| 항목 | 케이스 A (발췌만) | 케이스 B (발췌 + 답변 본문 1500자) |
|---|---|---|
| 제언당 input 토큰 | ~6,100 (프롬프트+질문+발췌+web_search 결과 3회) | ~11,000 (+답변 본문) |
| 제언당 output 토큰 | ~700 | ~700 |
| 제언당 토큰 비용 | ~$0.029 | ~$0.040 |
| 제언당 web_search (3회) | $0.03 | $0.03 |
| **제언 1건** | **~$0.06** | **~$0.07** |
| **38건 1회 생성** | **~$2.2** | **~$2.7** |

- web_search 결과가 컨텍스트에 들어가 input 토큰이 지배적 — 답변 본문 추가분은 상대적으로 작음
- **1회 생성 후 캐싱** — 반복 비용 없음. outlier 질문은 영구 캐싱
- 새 질문 누적분만 추가 제언 (건당 ~$0.06~0.07)

**미결정 포인트**: 케이스 A vs B.
- A: 발췌만 — 비용 ~$2.2, 단 "포함되어 있지 않습니다" 수준이라 맥락 부족 가능
- B: 답변 본문 포함 — 비용 ~$2.7 (+$0.5), 제언 품질 ↑ (어떤 자료까지 있었고 뭐가 없었는지 파악)
- 권고: **B** (비용 차 미미, 품질 이득 큼). 단 사용자 최종 결정 필요.

---

## 3. 구현 범위

| 파일 | 변경 | 라인 |
|---|---|---:|
| `lib/limitations/types.ts` | `ClusterSuggestion`, `SuggestionsJsonFile`, `SuggestResult` 타입 | ~30 |
| `lib/limitations/suggest.ts` | 신규 — suggest({maxNew}) + suggestAll() + 한계 클러스터·outlier 항목 수집 + Sonnet+web_search 호출 + 파싱 + 캐싱 + atomicWrite | ~240 |
| `app/api/admin/limitations/suggest/route.ts` | 신규 — batch POST + lock | ~50 |
| `app/api/admin/limitations/route.ts` | GET 응답에 suggestions 병합 (cluster:/outlier: key 매핑) | ~25 |
| `components/admin/LimitationsView.tsx` | "제언 생성" 버튼 + batch 자동 반복 + cluster·outlier 카드에 제언 표시 | ~90 |

**합계**: ~430줄, 신규 2개 파일, 수정 3개.

### 무수정
- DBSCAN / refresh.ts (limitation 코어)
- DB 스키마
- 지식 지형도

---

## 4. Success Criteria

| ID | 기준 | 측정 |
|---|---|---|
| **SC1** | 한계 클러스터 + 한계 outlier 질문 모두에 제언 생성 (자료 유형 3~5개) | suggestions.json 확인 |
| **SC2** | 각 제언에 외부 출처 후보 1개 이상 (web_search 결과) | suggestions.json externalSources |
| **SC3** | "제언 생성" 버튼 batch 자동 반복 동작 | 수동 |
| **SC4** | 캐싱 — 클러스터 멤버 동일 / outlier 질문ID 존재 시 재호출 안 함 | 두 번째 실행 시간/로그 |
| **SC5** | Admin UI cluster + outlier 카드에 제언 + 출처 표시 | 수동 |
| **SC6** | 비-admin이 suggest API 직접 호출 → 403 | 수동 |
| **SC7** | 1 batch가 Vercel timeout(60s) 안에 완료 | 실측 (web_search 포함) |

---

## 5. Risks

| 위험 | 완화 |
|---|---|
| web_search 비용 (검색당 과금) | 한계율 높은 클러스터만(~6-8개) + 멤버 캐싱으로 재호출 최소화. 명시적 버튼 트리거 |
| web_search + Sonnet이 클러스터당 수 초 → batch timeout | batch size 작게(3~5). 실측 후 조정. batch 자동 반복으로 누적 처리 |
| Sonnet 제언이 일반론 ("관련 자료 보충 필요") | 프롬프트에 "추측성 일반론 금지, 자료 유형 구체화" 명시 + 한계 발췌·질문 컨텍스트 충분히 제공 |
| web_search 결과가 무관/부정확 출처 | 제언은 "후보"로 표시, 관리자가 검증. 100% 정확성 목표 X |
| web_search 도구가 환경에서 비활성 (조직 설정) | 비활성 시 graceful — Sonnet 단독 제언만 생성, externalSources 빈 배열. 에러로 중단 X |
| suggestions.json과 questions.json 동기화 (클러스터 ID 재배치) | suggestions는 memberIds로 검증 — ID만 같고 멤버 다르면 stale로 간주, 재생성 |

---

## 6. Out of Scope

- Obsidian 자료 자동 생성·작성 (제언만, 작성은 수동)
- 제언 품질 자동 평가
- 외부 출처 실제 크롤링·본문 수집 (URL 후보까지만)
- 제언 "채택/기각" 워크플로 추적 — Phase 2
- web_search 외 별도 검색 API (Brave/Tavily 등) — Anthropic 내장 도구만

---

## 7. Dependencies

- **Anthropic web_search 서버 도구** (`web_search_20250305`) — sonnet-4-6 지원. 추가 라이브러리 없음, SDK 내장
- 환경 변수: 기존 `ANTHROPIC_API_KEY` (web_search는 Anthropic 과금에 포함)
- limitation-tracking 완성 전제 (`lib/limitations/`, `/admin/limitations`)
- DB 마이그레이션 없음
- 기존 admin middleware / batch 패턴 재사용
