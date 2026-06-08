# 뉴스 캐시(Tier4) 자동 갱신 설정

게시판 공지·뉴스는 `live_cache`(앱 DB)에 캐시되며 **TTL 6시간**이다. 만료되면 챗이
Tier1(.md)로 degrade하므로, **6시간마다 `--tier 4` 크롤**을 돌려야 최신 뉴스가 유지된다.

> 갱신 명령(수동 1회): `npm run crawl:colleges -- --phase 4 --tier 4`
> 전 단과대(16) + 대학원(12)의 notice/news를 재크롤해 upsert. 비용 $0(HTTP+DB, API 없음).

배포 환경에 맞게 **둘 중 하나**를 활성화한다.

## A. GitHub Actions (배포가 Vercel/클라우드일 때 권장)

1. 이 repo를 GitHub에 푸시.
2. **Settings > Secrets and variables > Actions > New secret**
   - 이름: `ENV_LOCAL`
   - 값: 로컬 `.env.local` 파일 **전체 내용** 붙여넣기 (DB 접속문자열 등)
3. 끝. `.github/workflows/refresh-boards.yml`이 6시간마다 자동 실행된다.
   (Actions 탭에서 **Run workflow**로 수동 실행도 가능)

## B. 로컬 Windows 작업 스케줄러 (자체 PC/서버일 때)

관리자 PowerShell에서 1회 등록:

```powershell
schtasks /Create /SC HOURLY /MO 6 /TN "SNU-Wiki-RefreshBoards" `
  /TR "powershell -NoProfile -ExecutionPolicy Bypass -File `"C:\Users\USER\Desktop\snu-wiki-chat\scripts\crawl\refresh-boards.ps1`"" `
  /RL HIGHEST
```

- 6시간마다 `refresh-boards.ps1` 실행.
- 해제: `schtasks /Delete /TN "SNU-Wiki-RefreshBoards" /F`
- 즉시 테스트: `schtasks /Run /TN "SNU-Wiki-RefreshBoards"`

## 비고
- 동적 게시판(gspa·gsct)은 headless chromium 필요 — 로컬은 `npx playwright install chromium` 1회, GHA는 워크플로가 자동 설치.
- 아키텍처상 갱신은 **오프라인(크롤)**에서만 일어나고 챗 런타임은 `live_cache`를 읽기만 한다(§9.2 격리). 그래서 Vercel 함수 cron이 아니라 별도 스케줄러로 분리.
