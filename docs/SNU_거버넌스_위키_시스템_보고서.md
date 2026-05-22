# SNU 거버넌스 위키 시스템 보고서

> **작성일**: 2026-04-30  
> **작성자**: 도훈민  
> **버전**: 1.0

---

## 1. 개요

### 1.1 배경 및 목적

서울대학교는 평의원회(53건), 이사회(26건), 대학운영계획, 중장기발전계획 등 방대한 거버넌스 자료를 보유하고 있으나, 이를 빠르게 탐색하고 활용하기 어렵다는 한계가 있었다.

총장 후보자, 관리자 등 의사결정권자가 특정 안건·인물·정책에 대해 즉시 질문하고 근거 있는 답변을 받을 수 있는 시스템이 필요했다.

**핵심 요구사항:**
- 위키 전체 데이터를 활용하되, 빠르고 정확한 답변
- 할루시네이션 없이 출처 근거 명시
- 민감 자료에 대한 권한 관리
- 팩트체크를 위한 원문 접근 가능

---

## 2. Obsidian LLM Wiki 구조

### 2.1 전체 구성

4개의 Sub Wiki로 구성된 계층적 지식 베이스.

```
SNU 거버넌스 통합 위키 (Main)
├── SNU_Senate_LLM_Wiki         (평의원회)
├── SNU_이사회_LLM_Wiki          (이사회)
├── SNU_대학운영계획_LLM_Wiki     (대학운영계획)
└── SNU_중장기발전계획_LLM_Wiki   (중장기발전계획)
```

### 2.2 각 Wiki 데이터 현황

| Wiki | 데이터 출처 | Sources | Topics | Entities | Syntheses |
|---|---|---|---|---|---|
| 평의원회 | 17·18·19기 본회의 회의록 53건 | 51 | 34 | 32 | 4 |
| 이사회 | 2023~2026 이사회 의사록 26건 | 26 | 27 | 45 | 0 |
| 대학운영계획 | 2026년도 운영계획 12개 실행과제 | 16 | 8 | 15 | 0 |
| 중장기발전계획 | SNU 2040 비전 보고서 | 9 | 9 | 11 | 0 |

### 2.3 각 Wiki 내부 구조

각 Wiki는 동일한 디렉토리 구조를 가진다.

```
wiki/
├── sources/       ← 회의록·의사록·계획서 요약 (개별 문서)
├── topics/        ← 주제별 정리 (AI가이드라인, 시흥캠퍼스 등)
├── entities/
│   ├── 인물/      ← 등장 인물 정보 및 관련 소스 목록
│   └── 기구/      ← 위원회·기관 정보
├── syntheses/     ← 교차 분석 및 주요 질의 응답 저장
├── index.md       ← 전체 Wiki 목차
└── log.md         ← 작업 이력
```

### 2.4 각 페이지 타입

**Source** (회의록 요약): 실제 문서 1건 = 1 source
```yaml
type: source
tags: [17기, 본회의, 학칙-개정, 재정]
sources: ["17기-12차"]
```

**Topic** (주제 정리): 여러 소스에 걸친 주제
```yaml
type: topic
category: 연구
sources: ["18기-21차", "19기-3차"]
```

**Entity** (인물·기구): 등장 인물 및 기관 페이지
```yaml
type: entity
entity_type: 인물
sources: ["2023-2차", ..., "2026-2차"]  ← 연관 소스 전체 목록
```

**Synthesis** (종합 분석): 질의응답·교차 분석 저장
```yaml
type: synthesis
query: "평의원회와 이사회의 시흥캠퍼스 입장 차이"
routed_to: [평의원회, 이사회]
```

---

## 3. 웹 애플리케이션 구조

### 3.1 기술 스택

| 분류 | 기술 | 역할 |
|---|---|---|
| Frontend | Next.js 15 (App Router) | 채팅 UI, 위키 탐색 페이지 |
| Styling | Tailwind CSS v4 | UI 디자인 |
| LLM | Anthropic Claude (claude-sonnet-4-6) | 질의응답 생성 |
| DB | Vercel Postgres + Drizzle ORM | 대화 기록, Synthesis 저장 |
| Auth | NextAuth v5 | 사용자 인증·권한 관리 |
| 배포 | Vercel + GitHub | CI/CD 자동 배포 |

### 3.2 데이터 파이프라인

Obsidian 원본 → 전처리 → 웹앱 사용

```
[Obsidian 폴더]
 wiki/sources/*.md
 wiki/topics/*.md        →  build-wiki-data.ts  →  data/*.json
 wiki/entities/**/*.md                              (senate.json 등)
 wiki/syntheses/*.md

[자동 처리 내용]
- 마크다운 파싱 및 프론트매터 추출
- Topic/Entity → Source 역매핑 (sourceId → 관련 topics/entities 목록)
- 라우팅 키워드 자동 보강 (에이전트당 125~150개)
- Synthesis 포함
```

빌드 명령어: `npx tsx scripts/build-wiki-data.ts`

### 3.3 시스템 아키텍처

```
사용자 질문
    ↓
[라우터] 어느 Wiki에서 찾을지 결정
    ├── Tier 0: 글로벌 키워드 → 4개 전부
    ├── Tier 1: keywords 배열 매칭 → 해당 에이전트만
    ├── Tier 2: 메타데이터 경량 스캔 → score>0 에이전트
    └── Last-resort: 전부 호출
    ↓
[WikiAgent × N] 각 에이전트에서 관련 내용 추출
    ├── Entity/Topic 역참조: 쿼리 단어가 entity명 매칭 시
    │   → entity 페이지 내용 직접 포함 (이미 정리된 합성 정보)
    ├── 청크 분할: ## 헤더 기준으로 문단 단위 분할
    └── 청크 스코어링: 쿼리 단어 빈도 기반 점수, 상위 20개 선택
    ↓
[LLM] Anthropic Claude API
    ├── 시스템 프롬프트: 테마별 구조화, 인라인 출처 표기 강제
    └── 스트리밍 응답 (SSE)
    ↓
사용자 화면
```

### 3.4 권한 체계

| 역할 | 권한 |
|---|---|
| admin | 전체 접근 + 관리자 페이지 + 자료 업로드 |
| tier1 | 민감 자료 포함 전체 접근 |
| tier2 | 비민감 자료만 접근, 채팅 가능 |
| pending | 승인 대기, 채팅 불가 |

---

## 4. 주요 기능

### 4.1 AI 채팅

- 자연어 질문 → 위키 기반 근거 답변 (할루시네이션 없음)
- 테마별 구조화 답변 (교육/연구/재정/거버넌스)
- 인라인 출처 표기: `[이사회] 2023-1차`
- 스트리밍 응답
- 대화 기록 저장 및 이전 대화 불러오기

### 4.2 위키 탐색 (`/wiki`)

- 4개 Wiki 전체 브라우저
- Sources / Topics / Entities / Syntheses 탭별 탐색
- 마크다운 렌더링으로 원문 확인 (팩트체크 가능)
- 채팅 답변의 출처 태그 클릭 → 해당 원문 바로 이동

### 4.3 Synthesis 저장

- 채팅 답변 "위키에 저장" 버튼으로 DB 저장
- Obsidian Synthesis 양식 자동 포맷
- `/wiki` 페이지 "채팅 Synthesis" 탭에서 모아 볼 수 있음

### 4.4 자료 업로드

- admin/tier1 권한으로 새 자료 업로드 가능
- 관리자 승인 후 반영

---

## 5. 핵심 설계 결정

### 5.1 토큰 효율화

전체 소스를 그대로 전달하면 쿼리당 최대 24K 토큰 → 비용 문제.  
청크 기반 검색으로 관련 문단만 추출하여 5~8K 토큰으로 절감.

### 5.2 Entity 역참조

`유홍림` 같은 인물명은 소스 본문에 "총장"으로만 등장하는 경우가 많음.  
Entity 파일의 `sources` 목록을 역매핑하여, entity명 매칭 시 연관 소스 전체를 자동 포함.

### 5.3 스마트 라우팅

Obsidian topic/entity/tag에서 키워드를 자동 추출하여 에이전트당 150개 보유.  
키워드 미매칭 시에도 메타데이터 스캔(Tier 2)으로 관련 에이전트만 선택, 불필요한 전체 호출 방지.

### 5.4 세션 기반 인증

브라우저 종료 시 세션 만료 (session cookie, 최대 8시간).  
중요 거버넌스 자료의 보안을 위해 자동 로그인 방지.

---

## 6. 배포 및 운영

### 6.1 배포 플로우

```
로컬 수정
    → git commit & push → GitHub main 브랜치
    → Vercel 자동 감지 → next build 실행
    → 빌드 성공 → Vercel CDN 배포
    → 도메인으로 서비스
```

### 6.2 데이터 업데이트 플로우

```
Obsidian에서 새 회의록 ingest
    → npx tsx scripts/build-wiki-data.ts 실행
    → data/*.json 갱신 (sources/topics/entities/keywords 모두 자동 반영)
    → git commit & push
    → Vercel 자동 재배포
```

### 6.3 주요 파일 구조

```
snu-wiki-chat/
├── app/
│   ├── api/chat/          ← LLM 스트리밍 API
│   ├── api/wiki/          ← 위키 데이터 API
│   ├── api/conversations/ ← 대화 기록 API
│   └── wiki/              ← 위키 탐색 페이지
├── components/
│   ├── chat/ChatPage.tsx  ← 메인 채팅 UI
│   └── wiki/              ← 위키 브라우저 컴포넌트
├── lib/
│   ├── agents/            ← 라우터 + WikiAgent 검색 로직
│   └── llm/prompts.ts     ← LLM 시스템 프롬프트
├── data/
│   ├── agents.config.json ← 에이전트 설정 + 키워드 (자동 갱신)
│   ├── senate.json        ← 평의원회 전처리 데이터
│   ├── board.json         ← 이사회 전처리 데이터
│   ├── plan.json          ← 운영계획 전처리 데이터
│   └── vision.json        ← 중장기발전계획 전처리 데이터
└── scripts/
    └── build-wiki-data.ts ← Obsidian → JSON 전처리 스크립트
```

---

## 7. 한계 및 향후 과제

| 항목 | 현황 | 향후 방향 |
|---|---|---|
| 데이터 갱신 | 수동 빌드 스크립트 실행 필요 | Obsidian 변경 감지 자동화 |
| Synthesis 저장 위치 | Vercel Postgres DB (Obsidian에 직접 쓰기 불가) | Export 기능으로 Obsidian 동기화 |
| 평의원회 외 위키 Entity | 이사회에만 집중된 인물 entity | 운영계획·중장기발전계획에도 인물 entity 추가 |
| 모바일 UI | 미최적화 | 반응형 레이아웃 개선 |
| 검색 품질 | 키워드 기반 스코어링 | 벡터 유사도 검색 도입 고려 |
