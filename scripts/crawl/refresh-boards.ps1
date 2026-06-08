# Tier4 게시판(공지·뉴스) live_cache 갱신 — 로컬 Windows 작업 스케줄러용.
# 전 단과대(16) + 대학원(12)의 notice/news를 재크롤해 live_cache(앱 DB)에 upsert.
# .env.local(프로젝트 루트)의 DB 접속정보 사용.
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Join-Path $PSScriptRoot '..\..')
npm run crawl:colleges -- --phase 4 --tier 4
