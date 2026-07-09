# HANDOFF — 2026-06-29 · branch: feat/cross-college-routing (main 동기화, 최신 494f0be)

## 지금 작업
lens(인물 시각) 프롬프트 재구성 **완료·배포**. 큰 미해결 없음 — 다음은 사용자 선택.

## 마지막 상태 (전부 main 배포, working tree 깨끗)
- **lens 재구성**(494f0be): "받아쓰기·모델 인사이트 부재" 해결. 근본원인=강한 [N] 그라운딩이 *인용 못 붙이는 독자 추론*을 굶김. 해법=`buildLensSystemPrompt`를 insight 스캐폴드 위 재구성(insight 출력 불변) + ① 그의 입장 솔직히+[stance][N] ② **모델 인사이트 의무화(무게중심)**. **열쇠=[N]은 *사실·입장*에만, *판단·해석*은 [N] 없이 모델 목소리**(새 사실 날조만 금지). 메타표기(`[도출 불가]`) 가드. → [[project_lens_layer_reframe]] 6/29 기록.
- **abort 픽스 e8e72a8**: 이 푸시에 함께 main 반영됨(직전까지 미배포였음).
- **edu-trends 게이트 진단**: 2회 probe로 **건강**(false-negative 없음) 확인 → 변경 안 함.

## 다음 할 일 (사용자 선택)
1. (선택) 메타가드 적용본 1회 재실측 — `npx tsx scripts/test/lens-test.ts "<질문>"` (~$0.15), `[도출 불가]` 사라짐 확인.
2. (선택) edu-trends **실제 질의로그** FN 검증 — Google Sheets 로그에 게이트(sim≥0.65) 돌려 진짜 누락 있나. 합성질문 말고 실로그로([[feedback_eval_real_questions_only]]).
3. (선택) 인계 원항목: 시계열 함정 질의 실측(생성단계 오답 리스크, [[feedback_diagnose_retrieval_vs_generation]]).

## 참조 (읽을 것)
- `lib/llm/prompts.ts` `buildLensSystemPrompt` — 재구성본(7원칙, ③ 인사이트 의무). `buildPolicySystemPrompt`(insight)는 불변.
- `scripts/test/lens-test.ts` — lens 실측 하니스(단일 Sonnet, 웹無, ~$0.05~0.1/질의).
- `/c/tmp/ab_*.txt` — 이번 A/B 출력 보존(new=원본 / A=option-A / M=신버전).

## 주의 / 함정
- **lens 인용 플로어 유지**: 신버전은 *인사이트(판단)*만 [N] 면제 — **사실·입장은 여전히 [N] 필수**. 사실에서 [N] 빼지 말 것.
- 신버전은 6/15 woven(전용섹션 금지) **일부 되돌림**(woven이 문제 아니라 인사이트 부재가 문제) — 재도입 금지.
- 비싼 LLM/임베딩 전 **비용 명시·동의**([[feedback_state_cost_before_running]]). 망작업=dangerouslyDisableSandbox 백그라운드.
- 무관 WIP 대량 미커밋(data/*.json·.bkit 등) — **내 파일만** 커밋. 배포=`git push origin HEAD:main` + `git branch -f main HEAD`. 프론트 변경은 하드리프레시.
