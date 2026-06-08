# wiki-sync

Obsidian → JSON → 임베딩 → 배포까지 한 번에 실행합니다.

## 사용법
- `/wiki-sync` — Obsidian 폴더에서 최근 변경된 wiki를 자동 감지하여 동기화
- `/wiki-sync senate` — 특정 wiki만 임베딩 (build는 항상 전체 실행)
- `/wiki-sync --all` — 전체 wiki 임베딩

## 실행 절차

### 1. 변경된 wiki 감지

`$ARGUMENTS`가 비어있으면 Obsidian 폴더(`../Obsidian`)에서 최근 수정된 파일을 확인합니다.

```bash
# 최근 24시간 내 수정된 wiki 폴더 감지
find ../Obsidian -name "*.md" -newer ../Obsidian -maxdepth 4 | head -20
```

Obsidian wiki 폴더는 `SNU_*_LLM_Wiki` 패턴을 따릅니다. 새 wiki가 추가되어도 이 패턴에 맞으면 자동 감지됩니다.

폴더명 → wiki ID는 `data/agents.config.json`의 `obsidianFolder` 필드를 참조합니다.

### 2. wiki:build 실행

```bash
npm run wiki:build
```

완료 후 각 wiki의 source/topic/entity 개수 변화를 보고합니다.

### 3. 임베딩 갱신

- 특정 wiki 지정 시: `npm run embed:build -- <wikiId>`
- `--all` 또는 인수 없음 (변경 wiki 여러 개): `npm run embed:build -- --all-rag-enabled`

이미 있는 청크는 content_hash 비교로 스킵됩니다.

### 4. 커밋 & 푸시

```bash
git add data/
git commit -m "feat: sync wiki — <변경 내용 요약>"
git push
```

### 5. 완료 보고

동기화된 wiki, 추가/변경된 소스 수, 새로 임베딩된 청크 수를 보고합니다.

---

## 자동화 팁

Obsidian에서 작업 중이라면 `npm run watch`를 백그라운드로 실행해두면 파일 저장 시 build + embed가 자동으로 돌아갑니다. git push만 수동으로 하면 됩니다.
