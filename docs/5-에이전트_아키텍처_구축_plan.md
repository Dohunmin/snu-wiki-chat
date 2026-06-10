# 5-에이전트 아키텍처 구축 Plan — snu-wiki-chat

> 작성 2026-06-10. 메인 오케스트레이터 1 + 전문가 서브에이전트 4(fact·insight·framing·lens).
> 핵심 원칙: **"전 질문 멀티에이전트화"가 아니라 "질문유형별 전문가 라우팅 + 각 전문가 심화"**.
> 단일사실(~75% 트래픽)은 fact 단일 Sonnet 콜 그대로 보존. 심화 이득은 다위키·집계·분석·프레이밍 질문에만.

---

## 1. 목표 아키텍처

```
                          ┌──────────────────────────────────────────┐
   질의 ──────────────▶  │      MAIN ORCHESTRATOR (결정적 셸)         │
                          │  planQuery(Haiku 1콜) → 분류·분배·합성     │
                          │  권한·예산·인용무결성·trace·부분답변 영속   │
                          └───────┬───────────┬───────────┬──────────┘
                                  │           │           │
          ┌───────────────────────┼───────────┼───────────┼──────────────┐
          ▼                       ▼           ▼           ▼              │
   ┌─────────────┐        ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
   │  fact       │        │  insight    │  │  framing    │  │  lens       │
   │ 사실 보고    │        │ 분석·진단    │  │ 전략 메시징  │  │ 인물 시각    │
   │ (normal)    │        │ (policy)    │  │ (admin)신규 │  │ (admin)다중 │
   │ 웹 차단      │        │ 웹 루프      │  │ 자체검색 없음│  │ 웹 없음      │
   └─────────────┘        └─────────────┘  └──────▲──────┘  └──────┬──────┘
          │                       │                │ fact+lens 입력  │
          └──── 지식베이스 KB(거버넌스·단과대·대학원, 동적) ─────────┘
                        synthesizer만 전역 [N] 1회 방출
```

**데이터 흐름**: planQuery(intent 분류) → routeQuery(결정적 위키 선택) → AnswerClass 3/4 직답 short-circuit → 예산 → [N] 부여 → 전문가 디스패치 → 합성/후처리(인용 resolve·retry·로깅·trace).
**합성 규칙**: framing은 fact 출력 + lens 출력을 **입력으로만** 받음(오케스트레이터가 depth≤1로 시퀀싱, framing이 직접 fact/lens를 호출하지 않음). 최종 synthesizer만 전역 [N]을 1회 방출.

---

## 2. 에이전트별 역할 (전문가 수준 — "프롬프트만 다른 1콜" 탈피)

| 에이전트 | 모드 | 핵심 심화 (현재 대비) |
|---------|------|---------------------|
| **main-orchestrator** | — | 결정적 셸. planQuery(Haiku 1콜)로 분류·분배 + framing←{fact,lens} 합성 시퀀싱(depth≤1). 권한/예산/인용무결성/trace/실패시 부분답변 영속 강제. **LLM 오케스트레이터로 승격 금지**(거버넌스: 추적성 > 자율성). |
| **fact** | normal | 단일사실은 Sonnet 1콜 그대로. 다위키만 **evaluator 충분성 게이트** + **per-source read-only EXTRACTOR**(주장+원문, [N]금지) + synthesizer 전역[N] 1회·충돌 표면화. **웹 절대 미접근**(정직성). AnswerClass 3 정형팩트 직답 확장. |
| **insight** | policy (admin/tier1) | 웹을 단발(max_uses:1)→**bounded 루프**(select→read→verify→synthesize, max 2~3 하드캡) + **분석 프레임워크**(원인/비교/전망/제안) + **출처 신뢰도 위계**(1차 공신력만 단정). |
| **framing** 🆕 | framing:\<id\> (admin) | **전략 메시지 설계**. fact의 검증된 [N] + lens의 인물 stance만 입력 → 청중분석→핵심메시지→프레이밍전략→반론대비 4단계. 자체 retrieval/web 없음. 새 사실·없는 입장 생성 절대 금지. **"전략 제안≠사실 단정" 디스클레이머 + 3-네임스페이스 라벨**([N]/(인물입장)/(전략제안)). |
| **lens** | lens:\<id\> / 비교 (admin) | leesj 1명 → **N명 총장후보**(config/candidates.yaml). per-candidate wiki_id 격리, 공개발언/공약 stance에만 grounded, insufficient면 입장생성 거부. **후보 비교·순위·우열 출력 금지**(개별 시각만, 명예훼손 차단). |

---

## 3. 단계 로드맵 (실익·저위험·의존성 순)

| 단계 | 내용 | 왜 | effort | 의존 |
|------|------|----|--------|------|
| **P0 오케스트레이터 리팩터** | route.ts를 명시적 `orchestrate()` 컨트롤플레인으로 추출(auth·예산·history·citation·persistence·로깅을 named 스테이지). specialist registry + ExecutionPlan 타입 + trace write. **행동 불변(byte-identical)**. | 모든 심화가 안전하게 얹힐 명시적 owner 확보. 회귀 0. | M | none |
| **P1 fact 충분성 게이트** | 완성·미배선된 **evaluator.ts 배선**(complex && 위키≥2일 때만). verdict 4분기 전략 주입. | **죽은 자산 회수, 최고 ROI**. '권위 있게 틀린 단정'을 답변 전 차단. | **L** | P0 |
| **P2 limitations 환류 + AnswerClass 3 직답** | 죽은 limitations cron 재가동(consolidation 환류) + governance 정형질의 AnswerClass 3 직답(LLM 0토큰). | episodic 메모리 자산 기동. 정형사실 비용·지연 0. | M | P0,P1 |
| **P3 fact per-source 추출** | `fact-extract.ts`: 위키별 Haiku read-only EXTRACTOR + synthesizer 전역[N]·충돌 표면화(집계/비교 신호일 때만). | 다위키 사실 오염 차단(context-spine). 단일위키는 스킵. | H | P0,P1 |
| **P4 insight 웹 리서치 루프** | max_uses 1→2~3 bounded 루프 + 4스텝 프레임워크 + 신뢰도 위계. | insight 본질=외부 reach. 단발은 단편적. 비용 주레버라 실측 게이팅. | H | P0,P1 |
| **P5 감사 H-3 선해결** 🔒 | conversations GET 소유권 미검사 + public title 노출 수정. framing/lens mode를 공개뷰어에서 제외. | **framing/lens 출시 선결조건** — 민감 콘텐츠 공개누수 차단. | M | P0 |
| **P6 lens 다중 후보** | candidates.yaml + ensureCandidateAgent + WikiStance provenance(누가·언제·어디서) + 비교모드 + 후보 격리. | 1명→N명 O(1) 확장. provenance가 '루머 엔진'→'추적가능 전문가'. | M | P0,P5 |
| **P7 framing 신규 모드** 🆕 | framing:\<id\> 스키마·admin 게이트·디스패치·buildFramingSystemPrompt(F1~F5)·claim-diff·워터마크·UI. | 가장 민감 — 가드가 화려함보다 우선. fact/lens 확정출력만 입력(신규 검색 표면 0). H-3·다중후보 뒤에. | H | P0,P5,P6 |

**순서 핵심**: 저위험 자산회수(P0~P2) → fact/insight 심화(P3~P4) → 민감 신규(P5 게이트 → P6 데이터 → P7 framing).

---

## 4. 거버넌스·윤리 가드 (전 단계 관통)

1. **근거 grounding 절대** — 모든 답변은 내부 KB([N]) 또는 공개발언(stance)에만. P0~P9 프롬프트 가드 전 모드 상속. KB에 없는 수치·결정·날짜는 어떤 모드도 생성 불가.
2. **fact 웹 완전차단(정직성 비대칭)** — external-needed여도 검색 안 함, "내부 범위 밖" 정직답. 외부 reach 필요시 라우터가 insight로. insight만 웹+blocked_domains+신뢰도 위계.
3. **admin 격리 3겹** — framing/lens는 admin 전용(loadPersonaContext null + 403 + middleware). insight=admin/tier1, tier2·pending은 fact 강등(웹 미도달). framing+lens 동시소유 capability 분리.
4. **근거없는 입장·사실 생성 금지(정치적 안전)** — lens insufficient면 입장생성 거부. framing은 stanceBlock 입장만 인용, claim-set diff로 새 사실·과장·누락 차단. 후보 비교·순위·우열 출력 금지.
5. **trace 영속 필수** — 전 호출 trace row{traceId, queryPlan, specialists, composition, budget, usage, web count}. framing/lens는 누가·언제·어떤 입장으로 생성했는지 감사가능. 산출물 public 제외.
6. **bounded loop 하드캡** — open-ended ReAct·무제한 루프·재계획 금지. planQuery 1콜·재계획 0·합성깊이≤1·내부 재시도 하드캡. 실패시 1콜 graceful fallback.
7. **단일사실 단일콜 보존** — fact && simple && !aggregate면 Sonnet 1콜 그대로. 심화는 코드 사전조건 뒤에서만. framing 자동발동 금지.
8. **인용 무결성 across 합성** — synthesizer가 전역 [N] 1회(서버 resolve). 충돌 봉합금지(P5/P8 표면화). EXTRACTOR는 read-only. 3-네임스페이스 분리.

---

## 5. 비용 모델

| 경로 | 비용·지연 |
|------|----------|
| **fact 단순 (~75%)** | **변화 없음** — Sonnet 1콜, 웹 $0, 게이트·추출 스킵. **반드시 보존**. |
| **fact 심화 (~25%)** | +evaluator(Haiku 1콜) +extractor(Haiku×위키수, 병렬) +synthesizer(Sonnet 1콜). 추가분 대부분 Haiku라 비용 미미, 지연 1.5~3배(병렬 완화). |
| **insight** | 웹 max_uses가 주레버 — ~$0.18~0.36에서 홉당 증가. 하드캡 + evaluator로 internal 충분시 웹 억제. `[chat-usage] web=N` 실측 후 조정. |
| **framing** | fact/lens 출력만 입력(짧음) → 저비용 Sonnet 1콜. 자체 검색 없음. |
| **lens N명** | 호출당 동일(stance 컨텍스트만). 후보 수는 비용 무관(관련 후보만 로드). |

> **결론**: 모든 심화/루프는 "코드 사전조건 + 하드캡" 뒤에서만. 게이트 자체가 LLM콜이므로 단순질문 스킵 조건이 없으면 net 손해.

---

## 6. 미결 결정 (튜닝/측정 필요)

- **evaluator 게이트 임계** — `complex && 위키≥2`로 시작, 단일위키 고신뢰 추가스킵은 골든 QA 실측 후.
- **insight 웹 max_uses 최종값(2 vs 3)** — `web=N` 비용/품질 곡선 A/B 후.
- **limitations cron 주기 + 감사 M-8~M-10**(트랜잭션·클러스터ID 경쟁) 기동 전/동시 수정 여부.
- **governance AnswerClass 3 직답 범위** — 연락처·정원만 vs 재무공시 총액까지(재무는 스키마 확장 선행).
- **framing claim-diff 구현 깊이** — 1차 프롬프트+디스클레이머, 코드 diff는 후속.
- **compositionDAG 명시 타입 vs 모드 분기** — 케이스 1개(framing←{fact,lens}) 동안은 분기로.
- **candidates.yaml 데이터 임계** — thin persona 양산(환각) 방지 수치 기준.

---

## 7. Top 리스크

| 리스크 | 등급 | 완화 |
|--------|:----:|------|
| **framing 스핀 엔진화** — 사실 재포장이 호도/설득무기로 변질, 선거·임명 개입 | HIGH | fact/lens 확정출력만 입력(원자료 직접접근 금지) + claim-diff + 디스클레이머 + 내부검토용 워터마크 + 명시요청 시만 + admin 3겹 + trace |
| **lens persona hallucination** — 근거 희소 후보에 입장 환각 = 명예훼손 | HIGH | insufficient 게이트 강화 + 전 문장 source 인용 + 비교·순위 출력금지 + thin persona 미등록 + wiki_id 격리 |
| **'권위 있게 틀린 단정' 재발** | HIGH(1순위) | fact 웹 완전차단 유지(불변) + insight verify 스텝 필수 + blocked_domains + 홉 하드캡 + 모든 웹주장 출처인용 |
| **과설계로 단일사실 회귀** | MED | 코드 사전조건 게이팅 + 단순질문 스킵 + framing/lens 자동배정 금지 + P0 byte-identical 골든 QA 검증 |
| **민감 콘텐츠 공개누수** | MED | H-3 선해결(P5) + framing/lens public 제외 + synthesis admin 옵트인 |
| **죽은 자산 재발명** | MED(프로세스) | P1·P2에서 "재발명 금지, 배선/기동만" 명시(evaluator gold-tested, limitations는 cron 재가동만) |

---

## 부록: 발표 프레이밍

- **현재** = workflow-orchestrated 인지 아키텍처(라우터-중심, 결정적). 거버넌스에 옳은 보수적 설계.
- **향후(이 plan)** = 메인 오케스트레이터 + 전문가 4 — 지능을 생성층(전문가)으로 재분배. "왜 전부 에이전트화 안 하나"를 **측정된 비용/이득 + 거버넌스 리스크**로 방어.
- 핵심 메시지: *"우리는 화려한 자율성이 아니라 **추적가능·근거기반 전문성**을 택했고, 에이전트화는 그것이 검증 가능하게 이득을 주는 질문유형에만 적용한다."*
