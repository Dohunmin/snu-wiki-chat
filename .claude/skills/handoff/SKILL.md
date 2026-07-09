---
name: handoff
description: Save a compact handoff note before /clear so the next fresh session can resume instantly. Use when the user is about to clear a large session, says "/handoff", "인계", "다음 세션 이어가게", or finishes a work block and wants to start fresh without re-loading the giant context.
---

# handoff — 세션 인계 노트

## 목적
큰 세션을 `/clear`로 닫기 직전, **지금 어디까지 했고 다음에 뭘 할지**를 작은 파일에 적어둔다.
새 세션은 SessionStart 훅이 이 파일을 자동 주입하므로, 752K 재로딩 없이 61K 바닥에서 바로 이어간다.

## 절대 규칙
- **작게 써라.** 목표 ≤ 60줄 / ~400토큰. 전체 대화를 요약하지 말 것 — *다음에 필요한 것만*.
- 파일 경로/커밋/브랜치는 **참조만** 남긴다(내용 복붙 금지). 다음 세션의 내가 그 경로를 직접 읽으면 됨.
- 끝나지 않은 결정·함정·"이거 건드리지 마"를 우선 기록. 이미 끝난 일은 한 줄로.

## 동작
1. 현재 대화에서 다음을 추려 `.claude/HANDOFF.md`에 **덮어쓴다**(Write):

```markdown
# HANDOFF — <YYYY-MM-DD HH:MM> · branch: <git branch>

## 지금 작업
<한 줄: 무엇을 하는 중인가>

## 마지막 상태
<방금 무엇까지 끝냈나 — 동작/미동작 사실만>

## 다음 할 일
1. <구체적 첫 액션 — 파일:라인 또는 명령>
2. ...

## 참조 (읽을 것)
- <파일경로> — <왜>
- 커밋 <hash> / PR #<n>

## 주의 / 함정
- <건드리면 안 되는 것, 미해결 결정, 알려진 버그>
```

2. 쓴 뒤 사용자에게 **"이제 `/clear` 하셔도 됩니다"** 라고 한 줄로 알린다. (clear는 사용자가 직접)

## 새 세션에서 (훅이 HANDOFF.md를 주입했을 때)
- 주입된 내용을 읽고 **"다음 할 일"부터 바로 착수**. 인계 노트를 장황히 복창하지 말 것.
- 노트는 *마지막 세션 종료 시점 기준*이다 — 파일/커밋이 그새 바뀌었을 수 있으니, 행동 전 참조 경로를 실제로 확인.
- 이어받아 첫 액션을 끝냈으면 HANDOFF.md를 갱신하거나(다음 인계), 작업이 완료됐으면 비운다.
