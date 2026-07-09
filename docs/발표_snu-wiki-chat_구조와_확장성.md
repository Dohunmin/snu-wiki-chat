# snu-wiki-chat — 구조 & 확장 가능성 (발표 정리)

> 작성: 2026-06-09 · 코드 직접 검증 기반 · 발표 + Q&A 대비용
> 한 줄: **서울대 거버넌스 자료를 LLM으로 질의응답하는 Next.js 웹앱.** 다중 위키 자동 라우팅 + 하이브리드 검색(키워드+벡터) + 권한 관리.

---

## 0. 네 이해 교정·보강 (먼저 이것부터)

| 네가 알던 것 | 정확히는 |
|---|---|
| "프론트 + 백엔드 + 에이전트 종합" | ✅ 맞음. **Next.js = 풀스택**(프론트 React + 백엔드 API가 한 프로젝트). "에이전트"는 백엔드 안의 *라우팅·검색 로직*이지 별도 서버 아님. |
| "Obsidian raw에 넣은 걸 ingest해서 쓴다" | ✅ **맞음.** 거버넌스(사람 수기) + 단과대 Tier1/2(크롤이 자동 생성) **둘 다 Obsidian에 .md로 들어가고**, 빌드가 거기서 읽어 JSON·임베딩 생성. Obsidian = 공통 ingest 레이어. **단 Tier3(연락처·통계)·Tier4(공지·뉴스)만** Obsidian 건너뛰고 앱 DB 직행. |
| "Obsidian data 가져와 로직 씌워 배포" | ✅ 큰 흐름 맞음. 단 정확히는 **빌드타임**(Obsidian→JSON→벡터DB 적재)과 **런타임**(앱이 그 가공물을 검색·생성)이 분리됨. "배포"되는 건 *앱*이고, 데이터는 빌드 산출물. |

**핵심 한 문장(발표용)**: "지식을 *생산*하는 계층(Obsidian 수기 큐레이션 + 웹 크롤)과, 그걸 *가공*하는 빌드 파이프라인(JSON+임베딩), 그리고 *서빙*하는 앱(라우팅→검색→LLM)이 분리된 3계층 구조입니다."

---

## 1. 큰 그림 — 3계층 아키텍처

```
┌─ ① 지식 생산 — Obsidian에 .md로 축적 (넣는 주체가 2개) ──────┐
│   사람(수기 큐레이션)              웹 크롤(자동 수집)           │
│   거버넌스 9위키 .md  ──▶  [ Obsidian 볼트 ]  ◀──  단과대      │
│   (회의록·계획·재무·연설)                        Tier1/2 .md    │
│                                                 (크롤이 생성)   │
└───────────────────────────┬─────────────────────────────────┘
                            │  wiki:build / crawl:colleges → buildCollegeWiki
                            ▼   (＊Tier3/4는 Obsidian 건너뛰고 앱 DB 직행)
┌─ ② 빌드 파이프라인 (오프라인 가공) ───────────────────────────┐
│  data/*.json (39개)  ──embed:build──▶  pgvector (벡터DB)       │
│  + 게시판→live_cache DB · 정형사실→structured_facts DB         │
└───────────────────────────┬─────────────────────────────────┘
                            ▼  (앱이 읽음)
┌─ ③ 앱 — Next.js 풀스택 (Vercel 배포) ─────────────────────────┐
│  프론트(React/Tailwind)  ◀─SSE─  백엔드 API (/api/chat)        │
│                                   └ 라우팅 → 검색(RAG) → LLM    │
│  DB: Neon Postgres (+pgvector) · 인증: NextAuth                │
└──────────────────────────────────────────────────────────────┘
```

- **① 생산**: 사람이 큐레이션(Obsidian) + 기계가 수집(크롤). 둘 다 "지식의 원천".
- **② 빌드**: 원천을 앱이 빠르게 검색할 수 있는 형태(JSON + 벡터 + DB)로 *미리* 가공. **이때 LLM 임베딩 비용 발생**(Voyage, 무료 티어 내).
- **③ 서빙**: 사용자 질문이 오면 라우팅→검색→LLM 생성. **런타임엔 크롤·임베딩 안 함**(미리 만든 것만 읽음 = 빠르고 저렴).

---

## 2. 폴더 구조 (핵심만)

```
snu-wiki-chat/
├─ app/                    ← Next.js (프론트 페이지 + 백엔드 API)
│   ├─ page.tsx            · 채팅 메인 (→ components/chat/ChatPage)
│   ├─ wiki/ admin/ login/ · 위키 브라우저 · 관리자 · 인증 페이지
│   └─ api/                · 백엔드 엔드포인트 (서버리스 함수)
│       └─ chat/route.ts   ★ 핵심 — 질문→라우팅→검색→LLM→응답 (백본)
├─ lib/                    ← 두뇌 (비즈니스 로직)
│   ├─ agents/             · 라우팅 + 컨텍스트 조립 (13개 파일) ★
│   ├─ embed/              · 벡터검색 (Voyage 임베딩 + pgvector + RRF + rerank)
│   ├─ llm/                · LLM 호출 + 프롬프트 + 인용 처리
│   ├─ crawl/              · 단과대 웹크롤 (8개 사이트엔진 어댑터)
│   ├─ limitations/        · "한계 답변" 추적·클러스터링 (자기개선)
│   ├─ db/ auth/ config/   · DB스키마 · 권한 · 조직설정
├─ data/                   ← 빌드 산출물: 위키 JSON 39개 + 설정
│   ├─ {senate,board,...}.json   · 거버넌스 9
│   ├─ {eng,humanities,...}.json · 단과대/대학원
│   ├─ agents.config.json        · 위키 등록부(라우팅 키워드 포함)
│   └─ concept-index.json        · cross-wiki 개념 색인(3,951개)
├─ components/             ← React UI (chat/ wiki/ admin/)
├─ config/colleges.yaml    ← 단과대/대학원 28조직 레지스트리(진실원)
├─ scripts/                ← CLI (빌드·크롤·평가·진단 도구)
└─ docs/                   ← 설계·분석 문서
```

> **외우기**: `app`=화면+API, `lib/agents`=두뇌, `lib/embed`=검색엔진, `data`=가공된 지식, `config/colleges.yaml`=조직 명부.

---

## 3. 데이터 생애주기 (원천 → 배포)

### 경로 A — 거버넌스 (수기 큐레이션)
```
Obsidian .md(+frontmatter)  ──npm run wiki:build──▶  data/{senate,...}.json
                            ──npm run embed:build─▶  pgvector(chunk_embeddings)
```
- 사람이 회의록·계획 등을 Obsidian에 정리 → 빌드가 9개 위키 JSON으로 파싱·구조화 → 임베딩 적재.

### 경로 B — 단과대/대학원 (자동 크롤 → Obsidian → 빌드)
```
대학 홈페이지/게시판  ──npm run crawl:colleges──▶  Tier별 분기
   ├ Tier1/2 (소개·연혁·규정)  → 크롤이 Obsidian에 .md 작성(emit.ts)
   │                            → buildCollegeWiki(Obsidian서 읽음) → data/{eng,...}.json → 임베딩
   │                            (＝경로 A와 동일한 Obsidian→build 경로)
   ├ Tier3 (연락처·교원수·통계) → structured_facts DB 직행 (TTL 90일, Obsidian 안 거침)
   └ Tier4 (공지·뉴스 게시판)   → live_cache DB 직행 (TTL 26h, 일 2회 cron, Obsidian 안 거침)
```
- 8개 사이트엔진 어댑터가 제각각인 대학 홈페이지를 파싱 → 콘텐츠 성격별로 Tier 분류.
- **핵심: Tier1/2는 Obsidian을 거쳐 거버넌스와 똑같이 빌드되고, Tier3/4(정형·게시판)만 DB로 직행**(자주 바뀌어 격리).

### 공통
- `data/*.json`은 **git에 커밋**되어 배포에 포함. 벡터·게시판·정형사실은 **DB(Neon)**에 상주.
- 배포 = **Vercel**(앱) + Neon(DB) + GitHub Actions(게시판 cron).

---

## 4. 질문 1건의 작동 프로세스 (런타임)

`POST /api/chat` 하나가 아래를 순서대로 수행 (백본 = `app/api/chat/route.ts`):

```
사용자 질문
  │
  1. 인증·권한 확인 (NextAuth)
  2. 의도 분류  ── Haiku LLM 1콜 → fact(사실보고) / insight(분석·제안)
  3. 위키 선택  ── routeQuery: 키워드점수 + 개념색인 + 의미(벡터) 종합 → 관련 위키 N개
  4. (단과대면) Tier 판정 → T3/T4면 DB 직답 (LLM 0토큰, 즉시 반환)
  5. 검색(RAG)  ── 위키별로: 키워드검색 + 벡터검색 → RRF 융합 → rerank → 예산 내 컷
  6. 인용 번호화 ── 출처를 [1][2]… 번호로 매핑
  7. LLM 생성   ── Claude Sonnet, SSE 스트리밍 (시스템프롬프트 P0~P9 원칙)
  8. 후처리     ── [N]→출처 변환 · 표 산수 검산 · 응답 저장 · 로깅
  │
응답 (스트리밍 + 출처)
```

- **2번(스타일)과 3번(데이터소스)은 직교** — 무엇을 답하나(어느 위키)와 어떻게 답하나(보고/분석)를 따로 결정.
- **fact는 내부 자료만, insight는 web_search 허용**(admin/tier1) — 거버넌스 신뢰성 위해 사실 답변은 외부 단정 안 함.

---

## 5. 핵심 기술 4가지 (발표 포인트)

### ① 하이브리드 RAG (검색의 핵심)
- **키워드 검색**(정확한 용어) + **벡터 검색**(의미 유사) 을 병행 → **RRF**(Reciprocal Rank Fusion)로 순위 융합 → **rerank**(cross-encoder)로 정밀 재정렬.
- 벡터: **Voyage `voyage-4-large`(1024차원)** + **pgvector** 코사인 검색. rerank: **Voyage `rerank-2.5`**.
- *왜 하이브리드?* 키워드만으론 동의어("장학금"↔"학생경비")를 놓치고, 벡터만으론 고유명사·정확 수치를 놓침 → 둘을 합쳐 recall+precision 동시 확보.
- **top-K?** 각 검색은 top-K(≈30) 후보를 뽑지만, **최종 컷은 고정 top-K가 아니라 rerank + 컨텍스트 예산(글자수)**. 단일 top-K로 자르면 특정 위키가 통째 누락돼 다양성 붕괴 → 그 방식은 실측 후 폐기.

### ② 다중 에이전트 자동 라우팅
- 위키 9개(+단과대 28)를 한 번에 다 검색하지 않고, 질문에 **관련된 위키만 자동 선택**.
- 점수 게이트(키워드) + 개념색인(수기 큐레이션) + 의미 힌트(벡터) + 갭 탐지로 cutoff.
- **wiki_id 격리**: "공대 X"는 공대 위키로만 → 단과대끼리 교차오염 0.

### ③ Tier 시스템 (단과대 — 비용·신선도 최적화)
| Tier | 콘텐츠 | 저장소 | 서빙 |
|---|---|---|---|
| T1/T2 | 소개·연혁·규정 | JSON+벡터 | 일반 RAG |
| **T3** | 연락처·교원수·통계 | structured_facts DB | **LLM 0토큰 직답** |
| **T4** | 공지·뉴스 게시판 | live_cache DB(일 2회 갱신) | **LLM 0토큰 직답** |
- 자주 바뀌고 정형적인 건 LLM 안 거치고 DB에서 바로 → **빠르고 비용 0**.

### ④ 권한 4단계 + 페르소나 Lens
- `admin / tier1 / tier2 / pending` — 민감자료·업로드·관리자·인사이트(web) 접근 차등.
- **Lens 모드**: 특정 인물(후보)의 입장(stance) 자료로 *그 사람 시각의 분석* 생성 (admin 전용).

### ⑤ 웹검색 — fact는 내부 전용, insight만 외부 (신뢰 설계)
- **fact(사실 보고)**: 내부 KB만, **웹 안 씀**. 외부 필요해도 "내부 자료 범위 밖"으로 정직하게 — *거버넌스 도구가 웹發 사실을 단정하면 신뢰 붕괴*.
- **insight(분석·제안, admin/tier1 전용)**: 내부로 안 풀리면 **web_search 직접** + 가드(나무위키·블로그 하드 차단, 1차 출처만, 실명 미검증 주장 금지). 내부 `[N]` + 🌐 외부 출처 **이중 인용**.
- **권한 격리**: insight가 admin/tier1 전용 → tier2·pending은 fact만 → 웹 절대 미도달.
- **비용**: fact·lens=$0, insight 웹발동=~$0.18~0.36/질의(웹 본문이 입력토큰).

---

## 6. 데이터 모델

**위키 페이지 타입 7종** (한 위키 = 이들의 묶음):
`source`(회의록·문서) · `topic`(주제색인) · `entity`(인물·기구) · `fact`(정형통계) · `stance`(입장·발언) · `overview`(편 개요) · `synthesis`(저장된 Q&A)

**DB 테이블 (Postgres + Drizzle ORM)**:
`users` · `conversations` · `messages` · `uploads` · `syntheses` · `sensitive_topics` · `chunk_embeddings`(벡터) · `limitation_questions/clusters`(한계추적) · `structured_facts`(T3) · `live_cache`(T4)

---

## 7. 확장 가능성 ★ (교수님이 가장 물을 부분)

| 확장 축 | 어떻게 | 비용/난이도 |
|---|---|---|
| **새 거버넌스 위키** | Obsidian 폴더 추가 + agents.config 항목 → `wiki:build` | 데이터 추가만, 코드 변경 0 |
| **새 단과대/대학원** | `colleges.yaml`에서 `active: true` 플래그 1개 → 자동 위키화 | **O(1)** (조직 28→N 무관) |
| **새 대학 사이트 유형** | 어댑터 1개 추가 (현재 8개 엔진) | 어댑터 모듈 1개 |
| **의도 분류 고도화** | 흩어진 정규식 → **Haiku LLM 통합 라우터**(방금 도입) | 새 질문유형을 *일반화*로 처리(규칙 추가 불필요) |
| **새 인물 시각(Lens)** | stance 자료 + 페르소나 설정 | 데이터 + 설정 |
| **자기개선 루프** | "한계 답변"을 임베딩·클러스터링 → **무엇을 보충해야 하는지 자동 도출** | 이미 구현(limitations/) |
| **외부 지식** | insight 모드 web_search (출처 가드 포함) | 구현됨, 권한 게이트 |

**확장성의 핵심 메시지**: "조직·위키·사이트 추가가 **데이터/설정 변경 수준**(코드 재작성 X)이고, 라우팅이 **자동**이라 위키가 늘어도 사용자 경험·정확도가 유지됩니다. 의도 분류도 규칙 누적 대신 **LLM 일반화**로 전환해 유지보수 부채를 줄였습니다."

---

## 8. 현재 상태 & 한계 (정직 — Q&A 대비)

- 데이터 갱신 일부 **수동** (`wiki:build` → `embed:build` 순서 실행 필요). 게시판은 cron 자동(일 2회).
- 동적 렌더 게시판 **2곳(gsct·gspa) 파싱 실패** → 해당 게시판만 일반자료로 degrade(안전).
- **모바일 UI 미최적화**, LLM 응답 캐싱 없음.
- 의도 통합 라우터는 **방금 라이브 전환** → 모니터링 단계(문제 시 즉시 롤백 가능).
- **거버넌스 동결 원칙**: 기능 추가해도 거버넌스 9위키 동작은 byte-identical 유지(회귀 테스트 19/19 게이트).

---

## 9. 기술 스택 요약

| 분류 | 기술 |
|---|---|
| Framework | **Next.js 15** (App Router, 풀스택) |
| Language | TypeScript |
| LLM | **Claude** (Sonnet 4.6 생성 / Haiku 4.5 라우팅) via `@anthropic-ai/sdk` |
| 임베딩/벡터 | **Voyage** `voyage-4-large`(1024d) + `rerank-2.5` + **pgvector** |
| DB | **Neon Postgres** + **Drizzle ORM** |
| 인증 | **NextAuth v5** (Credentials, JWT) |
| 크롤 | cheerio(정적) + playwright(동적) + robots-parser |
| UI | React 18 + **Tailwind v4** + react-markdown |
| 배포 | **Vercel**(앱) + Neon(DB) + GitHub Actions(게시판 cron) |

---

## 10. 예상 질문 + 답변 (Q&A 대비)

**Q. 그냥 ChatGPT에 자료 넣으면 되지 않나?**
→ ① 자료가 방대해 매번 다 못 넣음 → *관련 부분만* 검색해 넣는 RAG가 필요. ② 거버넌스는 **출처·정확성**이 생명 → 모든 사실에 [N] 인용 + 할루시네이션 가드(P0~P9) + "자료에 없으면 없다고" 원칙. ③ **권한별** 자료 분리.

**Q. 할루시네이션(없는 말 지어내기)은 어떻게 막나?**
→ 검색된 자료에만 근거 + 인라인 [N] 인용 강제 + 결론 단정 금지(P8) + 출처 메커니즘 단정 금지(P9). 못 찾으면 "자료 범위 밖"으로 정직하게.

**Q. 위키가 더 늘어나면 느려지거나 부정확해지지 않나?**
→ 전부 검색 안 하고 **라우팅으로 관련 위키만** 선택 + 컨텍스트 예산 캡 → 위키 수와 무관하게 비용·속도 일정. wiki_id 격리로 교차오염 방지.

**Q. 데이터는 얼마나 최신인가?**
→ 거버넌스는 수기 갱신, 단과대 게시판은 **하루 2회 자동 크롤**(live_cache). 정형사실 TTL 90일. 시점은 답변에 "수집: 날짜 기준"으로 표시.

**Q. 비용은?**
→ 생성 = Sonnet(질의당 ~$0.05~0.15), 라우팅 = Haiku(~$0.001). 임베딩·rerank는 Voyage 무료 티어 내. 게시판 크롤·DB는 $0(공개 repo Actions 무료).

**Q. 검색이 왜 키워드+벡터 둘 다인가?**
→ 키워드는 정확한 용어·고유명사·수치에 강하고, 벡터는 동의어·의미 유사에 강함. RRF로 융합해 둘의 약점을 상호 보완(+rerank로 정밀도).

---

> **발표 30초 요약**: "Obsidian 수기 큐레이션과 웹 크롤로 *지식을 생산*하고, 빌드 파이프라인이 *검색 가능한 형태*(JSON+벡터+DB)로 가공하며, Next.js 앱이 질문마다 *관련 위키만 자동 라우팅*해 하이브리드 검색(키워드+벡터+rerank) 후 Claude로 *출처 인용과 함께* 답합니다. 조직·위키 추가가 설정 수준이라 확장이 쉽고, 의도 분류를 LLM으로 통합해 유지보수 부채를 줄였습니다."
