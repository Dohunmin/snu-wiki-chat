# Plan: Limitation Tracking — 사용자 질문 답변의 한계 영역 집계 + 보충 우선순위 도구

> **Feature**: limitation-tracking
> **Date**: 2026-05-27
> **Phase**: Plan

---

## Executive Summary

| 항목 | 내용 |
|---|---|
| **Problem** | 사용자 질문 137건 중 답변에 "포함되어 있지 않습니다", "⚠️ 한계" 등 한계 표현이 들어간 케이스 다수. 같은 주제로 여러 명이 질문하는데 답이 한계로 끝나는 영역이 자료 보충 1순위인데, 이를 식별·집계할 방법이 없음. 동시에 평가 모델이 haiku로 하드코딩되어 메인 chat의 sonnet과 통일 안 됨. embed-questions.ts가 매번 전체를 재처리하여 비용·시간 낭비 |
| **Solution** | embed-questions.ts를 증분 처리로 전환 — 이미 처리된 질문 ID 캐시 비교 후 새 질문만 Sonnet 평가·임베딩. 평가 항목 확장 — quality(기존) + limitation 라벨(신규) + limitation_excerpt 300자(신규). Voyage 임베딩 기반 DBSCAN 클러스터링 + 각 클러스터 Sonnet 1줄 주제 라벨링. Admin "한계 답변" 탭에서 위키 필터·빈도순 정렬·클러스터 그룹핑 + 클릭 시 발췌 펼침. "지금 갱신" 버튼 클릭 시 클라이언트가 자동 batch 단위(N건씩) 반복 호출 — Vercel timeout 없이 누적분 전부 처리 |
| **UX Effect** | 관리자가 "어떤 주제에 자료 부족해서 답을 못하는지" 한눈에 + 한계율 % 함께. 새 질문이 쌓이면 버튼 한 번으로 자동 batch 처리, 진행률 실시간 표시 ("batch 3/5 — 60/100건") |
| **Core Value** | 사용자 질문 패턴을 자료 보충 의사결정으로 직접 연결 — 데이터 갭을 체계적으로 메우는 도구 + 신선도 유지 |

---

## Context Anchor

| 항목 | 내용 |
|---|---|
| **WHY** | 2026-05-27 사용자 지적, embed-questions.ts model이 haiku인데 메인 chat은 sonnet. 동시에 137건 질문 답변에 한계 표현이 패턴화되어 정형 집계 가능. 자료 보충은 "같은 주제 여러 명이 묻는데 못 답하는 영역" 신호 기반이어야 함. 매번 전체 재처리는 137건이라 ~5분, 신선도 유지 어려움 → 증분 처리 필요 |
| **WHO** | 관리자 (admin) — 자료 보충 의사결정 주체. 일반 사용자에겐 노출 X |
| **RISK** | (1) Sonnet 평가 비용 — 증분이라 한 번 처리한 질문은 재호출 X. (2) DBSCAN 파라미터가 의미있는 클러스터를 못 만들 가능성. (3) 동시 갱신 호출 충돌 — JSON 파일 lock 필요. (4) batch 처리 중 네트워크 끊김 — 진행분은 JSON에 저장되어 있으니 다시 누르면 이어서 |
| **SUCCESS** | (1) Sonnet 통일, (2) 한계 라벨 정확도 ≥90% (spot 10/10), (3) 클러스터 평균 크기 ≥2, (4) Admin 탭 위키 필터·정렬·발췌 동작, (5) 갱신 버튼 SSE 진행률 표시 + 새 질문 정확 반영, (6) 비-admin 차단, (7) 증분 처리 — 두 번째 실행 시 새 질문 0건이면 ~5초 이내 완료 |
| **SCOPE** | `scripts/embed-questions.ts` 증분 + 확장 / `lib/limitations/types.ts` 신규 / `lib/limitations/refresh.ts` 신규 (스크립트 로직 재사용 가능하게 분리) / `app/api/admin/limitations/route.ts` 신규 / `app/api/admin/limitations/refresh/route.ts` 신규 (SSE) / `app/admin/limitations/page.tsx` 신규 / `components/admin/LimitationsView.tsx` 신규 / `components/admin/AdminDashboard.tsx` 탭 추가 |

---

## 1. 현재 문제

### 1.1 한계 표현 답변이 흩어져 있음

사용자 지적 예시들:

```
📝 한계
트랙별 연구평가 제도의 규정 제정, 시행 시기, 구체적 트랙 구분 기준 등에 대한 자료는...

⚠️ 자료의 한계
제공된 자료는 주로 프로그램의 운영 내용·목표·예산을 다루고 있으며...

⚠️ 한계 안내
전문 관리자(테크니션, 장비운영인력 등)의 채용 절차...

제공된 위키 자료에서는 고가 장비/기기 전문 관리자 고용 방법에 대한 구체적인 절차나 규정은...
```

LLM이 [prompts.ts P5 "한계 인정"](lib/llm/prompts.ts) 원칙에 따라 정형화된 표현으로 한계를 명시함. 그러나 137건이 시간순으로만 흩어져 있어 "같은 주제로 여러 명이 묻는데 못 답하는 영역"이 보이지 않음.

### 1.2 embed-questions.ts 모델 불일치

- 메인 chat (`lib/llm/client.ts`): `claude-sonnet-4-6`
- 평가 스크립트 ([embed-questions.ts:85](scripts/embed-questions.ts#L85)): `claude-haiku-4-5-20251001` 하드코딩
- 사용자 명시적 sonnet 통일 요청

### 1.3 매번 전체 재처리 — 캐시 없음

[embed-questions.ts:157-171](scripts/embed-questions.ts#L157-L171) — 매번 DB에서 최근 200건 fetch + 전체 Voyage 임베딩 + 전체 Sonnet 평가. 한 번 분류된 질문은 fix될 수 있는데 매번 같은 결과를 다시 계산. 5월 21일 → 5월 27일 갱신 시 137건 전체 재처리 = 5분.

### 1.4 클러스터링 부재

각 질문은 1건씩 처리되어 "주제별 빈도·한계율"을 알 수 없음. 임베딩은 이미 Voyage로 계산되지만 클러스터링 단계가 없음.

---

## 2. 해결 — 증분 + 평가 확장 + Admin 도구

### 2.1 전체 흐름

```
┌───────────────────────────────────────────────────────────────────────┐
│ 갱신 실행 (수동 npm run = 모두 처리 / Admin 버튼 = batch 자동 반복)      │
│                                                                       │
│ refresh({ maxNew: N }) — 한 번 호출당 최대 N건만 처리                  │
│                                                                       │
│ 1. JSON 로드 → processed_ids set                                       │
│ 2. DB에서 미처리 질문 fetch (LIMIT N)                                  │
│ 3. N건 또는 그 이하 처리:                                               │
│    a. Voyage 임베딩 (batch)                                            │
│    b. Sonnet 평가 (concurrency 5):                                    │
│       - quality / wiki / limitation / limitation_excerpt              │
│    c. 전체 임베딩 합쳐서 DBSCAN (cosine, eps=0.25)                     │
│    d. 변경 클러스터만 Sonnet 라벨링                                     │
│ 4. JSON 원자적 write                                                    │
│ 5. 결과 반환: { processed, hasMore, totalCount, durationMs }           │
│    hasMore = DB에 아직 미처리 질문이 더 있는가                          │
└───────────────────────────────────────────────────────────────────────┘

┌───────────────────────────────────────────────────────────────────────┐
│ Admin 탭 "/admin/limitations"                                          │
│                                                                       │
│ GET /api/admin/limitations?wiki=...&sort=...                          │
│   → JSON 읽음 → limitation=true 그룹핑 + 한계율 계산                   │
│   → { wiki, label, total, limited, rate, questions[] }[]              │
│                                                                       │
│ "지금 갱신" 버튼:                                                      │
│   batchNum = 0                                                        │
│   while (true) {                                                      │
│     batchNum++                                                        │
│     res = POST /api/admin/limitations/refresh   ← 1 batch = 최대 N건  │
│     setProgress({ batchNum, processed, ... })                         │
│     if (!res.hasMore) break                                           │
│   }                                                                   │
│   → 자동 반복으로 누적분 전부 처리. timeout 절대 안 남                  │
│                                                                       │
│ LimitationsView:                                                       │
│   - 위키 필터 드롭다운                                                  │
│   - 정렬 (질문수 / 한계율 / 최신순)                                     │
│   - 클러스터 카드 [위키] 주제라벨 — N건 (한계 M건, X%)                  │
│     └─ 질문 클릭 시 답변·한계발췌 펼침 (대화 페이지 링크)               │
│   - 우측 상단 "지금 갱신" 버튼 + batch 진행 표시 ("batch 3/? — 60건")  │
└───────────────────────────────────────────────────────────────────────┘
```

### 2.2 핵심 결정 사항 (Checkpoint 2 합의)

| 결정 | 선택 | 이유 |
|---|---|---|
| 한계 감지 | **Sonnet 전수** (quality + limitation + excerpt 한 호출에) | 정규식 100% 신뢰 어려움. 한 호출에 묶으면 호출 수 절약 |
| 처리 방식 | **증분** (캐시 비교 후 새 질문만) | 137건 한 번 fix 후 매번 재처리 불필요. 신선도 + 비용 효율 |
| 임베딩 캐시 | **JSON 캐싱 (`knowledge-map-questions.json`)** | 별도 DB 테이블 X. 정적 파일이라 단순. 1000건 넘기 전엔 부담 X |
| 클러스터링 대상 | **전체 137건** (한계 있는 것만 아님) | 한계율(%) 계산이 자료 보충 우선순위 핵심 신호. 분모 필요 |
| 주제 라벨 | **Sonnet 1줄 (캐싱)** | 명확. 멤버 동일하면 기존 라벨 유지 → 호출 절약 |
| Admin UI | **읽기 전용 뷰 + 갱신 버튼** | 보충은 외부 Obsidian. UI는 식별·갱신만 |
| 갱신 자동화 | **Admin 버튼 (Cron 옵션은 Phase 2)** | 즉시성 |
| **갱신 처리 단위** | **Batch (N건씩 분절 + 자동 반복)** | Vercel timeout 회피. 한 호출은 짧게 끝나고, 클라이언트가 hasMore=true이면 자동 재호출. timeout이 설계상 불가능 |
| **Batch size N** | **Do phase 실측 후 결정** (초기 20건) | 1건당 평균 시간 측정 후 60s × 0.5 안전 margin 안에 들도록. 보통 20~30건 |

### 2.3 Sonnet 평가 프롬프트 (확장)

기존 ([embed-questions.ts:88-102](scripts/embed-questions.ts#L88-L102))의 quality + wiki 분류에 **limitation 2개 필드 추가**:

```
서울대 거버넌스 위키 챗봇 Q&A를 평가하세요.

질문: {question}
답변(앞부분): {answer.slice(0, 800)}   # 한계 발췌 위해 500 → 800자

[품질]
- answered: 위키 자료로 핵심에 구체적으로 답변
- partial:  일부만 답변하거나 불완전
- no_data:  자료없음/범위밖/실질 답변 없음

[위키 분류] 가장 가까운 위키 ID: senate/board/plan/.../leesj/none

[한계 여부]
- yes: 답변에 "자료 없음", "범위 밖", "한계 안내", "📝 한계", "⚠️ 자료의 한계",
       "포함되어 있지 않습니다", "확인되지 않습니다", "별도 자료 필요" 등
       자료 부족·한계를 명시한 부분이 **있음**
- no:  자료로 충분히 답변, 한계 명시 부분 없음

[한계 발췌]
한계가 yes면 답변에서 한계 부분만 발췌 (최대 300자, 그대로 따옴).
no면 빈 문자열.

JSON으로만 출력:
{"q":"answered|partial|no_data","w":"위키ID","l":"yes|no","le":"발췌..."}
```

`max_tokens`: 60 → **400** (발췌 300자 + JSON 오버헤드 여유). 모델 `claude-haiku-4-5` → **`claude-sonnet-4-6`**.

### 2.4 DBSCAN 파라미터

- **eps**: 0.25 (cosine distance, 1.0 = 완전 반대) — 의미 유사한 쌍 묶이는 수준
- **minPts**: 2 (cluster 형성 최소) — 137건 규모에서 큰 cluster 기대 X
- **거리 함수**: cosine = 1 - dot(a,b) / (||a||·||b||)
- 외부 라이브러리 없이 직접 구현 (~50줄)

처음 실행 후 클러스터 수·평균 크기 로그 확인 → 결과 보고 eps/minPts 조정 가능.

### 2.5 클러스터 라벨링 (캐싱)

```
이 N개 사용자 질문은 같은 주제로 클러스터링되었습니다:

1. {question1}
2. {question2}
...

공통 주제를 한국어 1줄(최대 25자)로 요약하세요.
예시: "트랙별 연구평가 제도", "고가 장비 관리자 채용", "비교과 프로그램 홍보"

답변 형식: 주제명만 한 줄
```

**캐싱 로직**:
- 기존 JSON의 클러스터별 질문 ID set 보관
- 새 결과의 클러스터별 질문 ID set과 비교
- **set이 동일하면 기존 `cluster_label` 유지** → Sonnet 호출 skip
- 변경(신규/멤버 변동)된 클러스터만 Sonnet 호출

→ 정상 상황에서 새 질문 추가되어도 기존 클러스터 라벨 유지, 신규 클러스터만 라벨링.

### 2.6 증분 + Batch 처리 상세

```ts
// pseudo — refresh({ maxNew: N })
const existingJson = JSON.parse(fs.readFileSync('knowledge-map-questions.json'));
const processedIds = new Set(existingJson.questions.map(q => q.id));

// DB에서 미처리 질문 — N건 한도 (LIMIT으로 효율)
const newRows = await db.query(`
  SELECT ... FROM messages WHERE id NOT IN (...) ORDER BY created_at ASC LIMIT ${maxNew + 1}
`);
const hasMore = newRows.length > maxNew;
const batch = newRows.slice(0, maxNew);

if (batch.length === 0) {
  return { processed: 0, hasMore: false, totalCount: existingJson.questions.length, durationMs: ... };
}

const newEmbeddings = await embedTexts(batch.map(r => r.question));
const judgements = await judgeAll(batch);    // quality + wiki + limitation + excerpt

const merged = [
  ...existingJson.questions,
  ...batch.map((r, i) => ({ ...r, ...judgements[i], embedding: newEmbeddings[i] })),
];

const clusterIds = dbscan(merged.map(q => q.embedding), 0.25, 2);
merged.forEach((q, i) => q.clusterId = clusterIds[i]);

const newLabels = await assignClusterLabels(merged, existingJson.clusterLabels);

atomicWrite('knowledge-map-questions.json', JSON.stringify({
  questions: merged,
  clusterLabels: newLabels,
  updatedAt: new Date().toISOString(),
  totalCount: merged.length,
}));

return { processed: batch.length, hasMore, totalCount: merged.length, durationMs };
```

**핵심**:
- DB쿼리에 `LIMIT maxNew + 1` — 추가 1건이 있으면 `hasMore=true`로 판정
- 한 batch마다 JSON write 완료 → 중간에 끊겨도 진행분 보존
- 클라이언트가 `hasMore=true`이면 자동으로 다시 호출
- DBSCAN은 매 batch 끝에 전체 재계산 (137건 규모 비용 0)

**Edge case**: question id (DB `messages.id`)를 키로 사용. embed-questions가 현재 question 텍스트로만 비교했다면 id 기반으로 바꿔야 함.

### 2.7 Admin 갱신 흐름 (Batch + 자동 반복)

서버는 1 호출 = 1 batch (최대 N건 처리). 클라이언트는 hasMore=true이면 자동 재호출.

```ts
// POST /api/admin/limitations/refresh
export async function POST() {
  // admin 권한 체크 + lock
  try {
    const result = await refresh({ maxNew: BATCH_SIZE });  // BATCH_SIZE=20 (실측 후 조정)
    // result: { processed, totalRemaining, hasMore, durationMs, totalCount }
    return Response.json(result);
  } finally {
    // lock 해제
  }
}
```

```ts
// 클라이언트 (LimitationsView)
async function handleRefresh() {
  let batchNum = 0;
  while (true) {
    batchNum++;
    setProgress({ batch: batchNum, ... });

    const res = await fetch('/api/admin/limitations/refresh', { method: 'POST' });
    if (res.status === 409) { alert('이미 갱신 중'); return; }
    const data = await res.json();

    setProgress({
      batch: batchNum,
      processed: data.processed,
      totalRemaining: data.totalRemaining + data.processed,  // 첫 batch 기준
    });

    if (!data.hasMore) break;
  }
  alert(`갱신 완료: 총 ${batchNum}개 batch 처리`);
  loadData();
}
```

**왜 SSE 안 쓰나**:
- 1 batch가 짧으니 (~10~20초) 진행률 SSE 불필요
- batch 단위 표시면 충분 ("batch 3/5 처리 중")
- 단순 HTTP POST + 자동 반복이 코드 더 단순

**동시 호출 lock**: in-memory flag — 처리 중이면 두 번째 호출은 즉시 409 응답. JSON 파일 동시 write 방지. 1 batch가 짧으니 lock 잡힘 시간도 짧음.

---

## 3. 구현 범위

| 파일 | 변경 | 라인 |
|---|---|---:|
| `scripts/embed-questions.ts` | model haiku→sonnet, 평가 프롬프트 확장 (limitation 2개 필드), 증분 처리 로직, DBSCAN 호출, 라벨 캐싱 — **하지만 핵심 로직은 lib/limitations/refresh.ts에 분리** → 이 스크립트는 모두 처리할 때까지 반복 호출하는 thin wrapper | ~40 |
| `lib/limitations/refresh.ts` | refresh({ maxNew }) — 한 batch 처리. fetchNewQuestions(LIMIT N+1으로 hasMore 판정), judgeBatch, DBSCAN, labelClusters | ~200 |
| `lib/limitations/types.ts` | LimitationQuestion / LimitationCluster / RefreshResult 타입 | ~40 |
| `lib/limitations/dbscan.ts` | DBSCAN 직접 구현 (cosine distance) | ~60 |
| `app/api/admin/limitations/route.ts` | JSON 읽기 + 그룹/필터/정렬 + 응답 | ~80 |
| `app/api/admin/limitations/refresh/route.ts` | POST — 1 batch 처리 + lock + 결과 응답 | ~50 |
| `app/admin/limitations/page.tsx` | Next.js 페이지 + admin 권한 가드 | ~30 |
| `components/admin/LimitationsView.tsx` | 위키 필터 + 정렬 + 클러스터 카드 + 발췌 펼침 + 갱신 버튼 + batch 자동 반복 + 진행 표시 | ~230 |
| `components/admin/AdminDashboard.tsx` | "한계 답변" 탭/링크 추가 | ~10 |

**합계**: ~740줄, 신규 7개 파일, 수정 2개.

### 무수정
- DB 스키마
- 라우팅 / LLM 본문 흐름 / `prompts.ts`
- Voyage 임베딩 인프라
- 지식 지형도 HTML (새 필드는 무시되거나 옵션 활용 가능)

---

## 4. Success Criteria

| ID | 기준 | 측정 |
|---|---|---|
| **SC1** | embed-questions.ts 및 refresh.ts model이 `claude-sonnet-4-6`로 통일 | grep |
| **SC2** | JSON에 `limitation`, `limitation_excerpt`, `cluster_id`, `cluster_label` 필드 모두 추가 | jq |
| **SC3** | 한계 라벨 정확도 — spot check 10건에서 ≥9/10 | 수동 |
| **SC4** | DBSCAN 결과 클러스터 평균 크기 ≥2, 클러스터 수 5~30개 | 로그 |
| **SC5** | Admin /admin/limitations 진입 시 한계 클러스터 표시 (위키 필터·정렬·발췌 펼침 동작) | 수동 |
| **SC6** | 비-admin tier1 계정 /admin/limitations 진입 차단 | 수동 |
| **SC7** | **증분 처리** — 새 질문 0건 시 두 번째 실행이 ~5초 내 종료 (이미 처리된 것 재호출 안 함) | 시간 측정 |
| **SC8** | Admin "지금 갱신" 버튼 — batch 자동 반복, 진행 표시("batch 3/? — 60건"), 완료 alert | 수동 |
| **SC9** | 동시 갱신 호출 — 처리 중 두 번째 호출은 409 반환 | 수동 (2 탭) |
| **SC10** | Batch 처리 — 1 batch 호출이 안정적으로 Vercel timeout(60s) 안에 들어옴 | 갱신 1회 실측 |
| **SC11** | 50건 누적된 상태에서 갱신 버튼 1회 클릭 → 자동 batch 반복으로 전부 처리 | 수동 |

---

## 5. Risks

| 위험 | 완화 |
|---|---|
| 첫 갱신은 137건 전수 처리 — npm run으로 batch 자동 반복 (~5분) | README/Plan에 명시. 스크립트도 hasMore=true이면 자동 다음 batch 호출 |
| Batch size N이 너무 크면 timeout, 너무 작으면 호출 수 증가 | Do phase에서 1건당 시간 실측 후 60s × 0.5 안전 margin 안에 들도록 설정 (초기 20건). refresh.ts 상수 1줄로 조정 가능 |
| Batch 자동 반복 중 네트워크 끊김 | 각 batch마다 JSON write 완료 → 진행분 보존. 사용자가 다시 누르면 이어서 (증분이라 안전) |
| 동시 갱신 호출 — JSON 동시 쓰기 충돌 | in-memory lock flag로 두 번째 호출 즉시 409. Vercel 다중 region 호출 가능성 있지만 admin 단일 사용자 가정 |
| Sonnet 한계 판정 false positive (자료 충분한데 limitation=yes) / false negative (실제 한계인데 no) | spot check로 정확도 확인. 90% 미만이면 프롬프트 튜닝 (예시 추가) |
| DBSCAN eps=0.25가 의미있는 클러스터 못 만들 가능성 | 첫 실행 후 클러스터 수·크기 로그 확인 후 튜닝. 0.20~0.30 범위에서 조정 |
| 클러스터 라벨링 Sonnet이 일반론적 라벨 ("학사 관련") | 프롬프트에 구체 예시 명시. spot check 후 필요시 프롬프트 보강 |
| 한계 발췌 300자가 잘려서 의미 손상 | UI에서 "원본 대화 보기" 링크로 conversation 페이지 이동 가능 |
| JSON 파일이 1000건 넘으면 클라이언트 로딩 느려짐 | 137건×~600자 = ~80KB. 1000건도 ~600KB로 감당 가능. 그 이상 가면 분할 고려 (별도 PR) |
| outlier 클러스터(-1)가 많아 그룹핑 의미 약화 | UI에서 outlier는 "단일 질문" 별도 섹션으로 분리 |

---

## 6. Out of Scope

- Obsidian 자료 자동 생성 (관리자가 수동 보충)
- "보충 완료" 상태 추적 (체크박스 / DB 테이블) — Phase 2
- Vercel Cron 매일 자동 갱신 — Phase 2 (필요시 추가, 이번엔 버튼만)
- 외부 워커(Railway 등) 기반 백그라운드 처리 — 137건 규모에선 불필요
- Slack/이메일 알림
- 클러스터링 결과 시각화 (지식 지형도 위 표시) — 별도 feature
- 사용자에게 한계 답변 통계 노출 — admin only
- 신규 DB 테이블·마이그레이션 — 정적 JSON 캐시로 충분

---

## 7. Dependencies

- 외부 라이브러리: 없음 (DBSCAN 직접 구현)
- 환경 변수: 기존 그대로 (`ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`, `POSTGRES_URL`)
- DB 마이그레이션: 없음
- **첫 1회 수동 갱신 필요** — JSON 형식 바뀌므로 `npm run knowledge:questions` 한 번 로컬에서 실행 (batch 자동 반복으로 ~5분). 그 이후엔 Admin 버튼으로 증분 갱신
- 기존 admin middleware (`canAccessAdmin`) 재사용
