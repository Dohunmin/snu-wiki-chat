# EROFS 에러 — Admin 갱신 버튼 해결 옵션

> 2026-05-28 작성. `/admin/limitations`에서 "지금 갱신" 클릭 시 발생한 에러 진단 + 해결 옵션.

---

## 1. 무슨 일이 일어났나

배포된 Vercel 환경에서 "지금 갱신" 버튼 클릭 → 에러:

```
갱신 실패: EROFS: read-only file system,
open '/var/task/public/knowledge-map-questions.json.tmp'
```

---

## 2. 원인 (확정)

**Vercel serverless 함수는 파일시스템이 읽기 전용(read-only)이다.**

- 배포된 코드 폴더(`/var/task/`)에는 런타임에 **파일을 쓸 수 없음**
- 쓰기 가능한 곳은 `/tmp`뿐인데, 그것도 함수 인스턴스가 살아있는 잠깐 동안만 유지(ephemeral) — 다음 요청 때 사라질 수 있어 캐시로 못 씀

우리 코드(`lib/limitations/refresh.ts`)는 결과를 `public/knowledge-map-questions.json` **파일에 덮어쓰기** 하는데:

| 환경 | 결과 |
|------|------|
| 로컬 `npm run knowledge:questions` | 파일 쓰기 OK ✅ (그래서 로컬 재평가는 잘 됨) |
| Vercel 배포 — Admin "갱신" 버튼 | read-only → **EROFS 에러** ❌ |

### 근본 모순
"정적 파일(public/)"을 런타임에 쓰려고 한 설계. Plan/Design에서 Vercel **timeout**은 고려했지만 **read-only 파일시스템**은 놓쳤음 (내 설계 실수).

### 추가로 같은 문제 예정
다음 기능 `supplementation-suggestion`도 `public/limitation-suggestions.json`에 쓰려 했으므로 **똑같이 EROFS 발생**할 것. → 저장 방식 자체를 바꿔야 함.

---

## 3. 해결 옵션

### 옵션 A — Postgres(DB)로 저장  ⭐ 추천

questions / suggestions 데이터를 파일 대신 **DB 테이블**에 저장.

| 항목 | 내용 |
|------|------|
| 방식 | `limitation_questions` 테이블 신규. 갱신 = DB write |
| 장점 | 런타임 읽기·쓰기 OK → **웹 갱신 버튼 정상 작동** (원했던 것). 이미 Postgres 쓰는 중이라 추가 인프라 0. 영구 보관. suggestions도 같은 방식 통일 |
| 단점 | embedding(1024개 float)을 jsonb로 저장 필요. DB 마이그레이션 1회. 코드 변경 ~중간 |
| 비용 | 0 (기존 Postgres) |

### 옵션 B — Vercel Blob 스토리지

JSON 파일을 Vercel의 파일 저장소(Blob)에 올림.

| 항목 | 내용 |
|------|------|
| 방식 | `@vercel/blob` 패키지로 JSON 파일 업로드/다운로드 |
| 장점 | 파일 구조 그대로 유지. 코드 변경 적음 |
| 단점 | 새 패키지 + 토큰 설정. 외부 의존 추가. 읽을 때마다 fetch |
| 비용 | Vercel Blob 무료 한도 내 (소량이라 충분) |

### 옵션 C — 로컬 갱신 전용 (웹 버튼 포기)

웹 "갱신" 버튼을 없애고, 갱신은 로컬에서만.

| 항목 | 내용 |
|------|------|
| 방식 | `npm run knowledge:questions`(로컬) → git commit → 배포. Admin은 **읽기 전용** |
| 장점 | 코드 최소 변경. 파일 방식 그대로 |
| 단점 | **웹에서 갱신 불가** — 네가 원했던 "관리자가 버튼 눌러 갱신"을 포기. 갱신하려면 매번 로컬 작업+배포 |
| 비용 | 0 |

---

## 4. 비교 요약

| | A. Postgres | B. Blob | C. 로컬 전용 |
|---|:---:|:---:|:---:|
| 웹 갱신 버튼 작동 | ✅ | ✅ | ❌ |
| 추가 인프라/패키지 | 없음 | @vercel/blob | 없음 |
| 코드 변경량 | 중 | 소~중 | 소 |
| supplementation도 해결 | ✅ | ✅ | ✅(로컬) |
| 영구 보관 | ✅ | ✅ | ✅(git) |

---

## 5. 추천: **옵션 A (Postgres)**

이유:
1. 이미 Postgres 쓰는 중 → 추가 인프라 0
2. 네가 원한 **웹 갱신 버튼이 정상 작동**
3. supplementation suggestions도 같은 DB 전략으로 통일 가능
4. embedding은 jsonb로 저장하면 됨 (pgvector까지 안 가도 됨 — 클러스터링은 메모리에서 계산)

다음 단계: 결정되면 `/pdca plan limitation-storage` 또는 기존 limitation-tracking 보강으로 진행.

---

## 6. 지금 당장은?

- **로컬 재평가/갱신은 정상 작동** (`npm run knowledge:questions`, `reevaluate-limitations.ts`)
- 배포 웹의 "갱신" 버튼만 안 됨
- 급하면: 로컬에서 갱신 → git push → 자동 배포로 데이터 최신화 가능 (옵션 C 방식 임시 운용)
