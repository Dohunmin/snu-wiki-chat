// Design Ref: college-grad-wiki §6.2 (tier 분류) — recency.ts 패턴 미러, DB 비용 0.
// 쿼리 → Tier. college 라우팅은 wiki_id(라우터의 위키 선택)가 담당하므로 여기선 tier만 분류한다.
// T3/T4는 chat 핸들러(module-4/5)가 routing.tier + routing.college(=선택된 college wiki_id)로 분기.
//
// 분류(우선순위, first-match):
//   Tier4: 시간어 + 게시판어 (최신 공지/뉴스 → live_cache)
//   Tier3: 연락처/이메일/인원/명단 (구조화 → structured_facts, 1레코드)
//   Tier2: 역대/수상/동문/규정 (아카이브 RAG)
//   Tier1: 그 외 (정적 위키 RAG = 기본)

export type Tier = 1 | 2 | 3 | 4;

const TIME_WORDS = ['최근', '오늘', '이번주', '이번 주', '이번학기', '이번 학기', '방금', '며칠', '마감임박', '최신', '지금', '현재'];
const BOARD_WORDS = ['공지', '게시판', '뉴스', '소식', '알림', '일정', '모집', '연구성과', '행사'];
const T3_WORDS = ['연락처', '이메일', '전화', '메일', '몇 명', '몇명', '인원', '명단', '교수 수', '교수수', '정원'];
const T2_WORDS = ['역대', '전임', '수상', '동문', '졸업생', '규정', '학칙', '과거', '옛'];

export function classifyTier(query: string): Tier {
  const q = query.toLowerCase();
  const has = (arr: readonly string[]) => arr.some((w) => q.includes(w));
  if (has(TIME_WORDS) && has(BOARD_WORDS)) return 4;
  if (has(T3_WORDS)) return 3;
  if (has(T2_WORDS)) return 2;
  return 1;
}
