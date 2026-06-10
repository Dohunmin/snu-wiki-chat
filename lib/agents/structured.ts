// Design Ref: college-grad-wiki §2.2 / §3.3 / §4.1 I-9 — AnswerClass 3/4 런타임 직답.
// Plan SC: "공대 학장 이메일?" → AC3 1레코드 LLM 0토큰 / "공대 최근 공지?" → AC4 리스트.
// ⚠️ 여기서의 AnswerClass(3/4)는 답변 방식 분류이며 권한 tier1/tier2와 무관.
//
// 격리(§9.2): 이 모듈은 app-side. lib/db만 의존하고 lib/crawl을 import하지 않는다.
//   - AnswerClass 3(structured_facts)·AnswerClass 4(live_cache) row는 crawl(producer)이 채우고 여기선 읽기만.
//   - 미스/TTL 만료 → null 반환 → 호출측(route.ts)이 AnswerClass 1 RAG로 degrade.
// college = router가 선택한 단과대/대학원 wiki_id(= org.id). 별도 detectCollege 불필요.

import { db } from '@/lib/db/client';
import { structuredFacts, liveCache } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';

export type FactField =
  | 'dean_contact'
  | 'faculty_count'
  | 'student_count'
  | 'faculty_roster'
  | 'dept_count';

export type BoardKind = 'notice' | 'news' | 'research';

export interface DirectAnswer {
  answer: string;
  sources: { wiki: string; page: string; topic?: string }[];
  answerClass: 3 | 4;
  field?: FactField;
  board?: BoardKind;
}

// 쿼리 → 구조화 field. answer-class가 이미 answerClass=3으로 분류한 쿼리만 들어온다(여기선 세분).
const FIELD_PATTERNS: { field: FactField; words: string[] }[] = [
  { field: 'dean_contact', words: ['이메일', '메일', '연락처', '전화', '이메일 주소', '학장 이메일', '연락'] },
  { field: 'faculty_roster', words: ['명단', '교수진', '교수 명단', '교원 명단', '보직자', 'roster', '구성원'] },
  { field: 'faculty_count', words: ['교수 수', '교수수', '교원 수', '교원수', '전임교원', '교수 몇', '교원 몇'] },
  { field: 'student_count', words: ['학생 수', '학생수', '재학생', '정원', '학생 몇', '입학정원'] },
  { field: 'dept_count', words: ['학과 수', '학과수', '몇 개 학과', '학과 몇', '전공 수', '학과가 몇'] },
];

const BOARD_PATTERNS: { board: BoardKind; words: string[] }[] = [
  { board: 'research', words: ['연구성과', '연구 성과', '논문', '수상', '성과'] },
  { board: 'news', words: ['뉴스', '소식', '보도', '언론'] },
  { board: 'notice', words: ['공지', '게시판', '알림', '일정', '모집', '행사', '안내'] },
];

/** AnswerClass 3 쿼리 → 구체 field (없으면 dean_contact를 기본으로 — 가장 흔한 AC3 질의). */
export function detectFactField(query: string): FactField {
  const q = query.toLowerCase();
  for (const { field, words } of FIELD_PATTERNS) {
    if (words.some((w) => q.includes(w))) return field;
  }
  return 'dean_contact';
}

/** AnswerClass 4 쿼리 → 게시판 종류 (없으면 notice 기본). */
export function detectBoard(query: string): BoardKind {
  const q = query.toLowerCase();
  for (const { board, words } of BOARD_PATTERNS) {
    if (words.some((w) => q.includes(w))) return board;
  }
  return 'notice';
}

function isFresh(fetchedAt: Date, ttl: number, unit: 'days' | 'hours'): boolean {
  const ms = unit === 'days' ? ttl * 86_400_000 : ttl * 3_600_000;
  return Date.now() - new Date(fetchedAt).getTime() < ms;
}

/**
 * AnswerClass 3 직답: structured_facts에서 `${org}:${field}` 1레코드.
 * 적중 + TTL 유효 시 DirectAnswer 반환(LLM 0토큰), 아니면 null(→ AnswerClass 1 degrade).
 */
export async function getStructuredFact(org: string, query: string): Promise<DirectAnswer | null> {
  const field = detectFactField(query);
  const id = `${org}:${field}`;
  let row;
  try {
    [row] = await db.select().from(structuredFacts).where(eq(structuredFacts.id, id)).limit(1);
  } catch (err) {
    console.error('[answer-class:3] structured_facts 조회 실패:', err);
    return null;
  }
  if (!row) return null;
  if (!isFresh(row.fetchedAt, row.ttlDays, 'days')) return null; // 만료 → degrade

  return {
    answer: `${formatFact(field, row.value)}\n\n출처: ${row.sourceUrl}`,
    sources: [{ wiki: org, page: row.sourceUrl }],
    answerClass: 3,
    field,
  };
}

/**
 * AnswerClass 4 직답: live_cache에서 `${org}:${board}` 게시판 리스트.
 * 적중 + TTL 유효 시 DirectAnswer 반환, 아니면 null(→ AnswerClass 1 degrade).
 * (런타임 라이브 fetch 안 함 — 갱신은 오프라인 crawl --tier 4. §9.2 격리)
 */
export async function getLiveBoard(org: string, query: string): Promise<DirectAnswer | null> {
  const board = detectBoard(query);
  const id = `${org}:${board}`;
  let row;
  try {
    [row] = await db.select().from(liveCache).where(eq(liveCache.id, id)).limit(1);
  } catch (err) {
    console.error('[answer-class:4] live_cache 조회 실패:', err);
    return null;
  }
  if (!row) return null;
  if (!isFresh(row.fetchedAt, row.ttlHours, 'hours')) return null; // 만료 → degrade

  const items = Array.isArray(row.payload) ? (row.payload as BoardListItem[]) : [];
  if (items.length === 0) return null;

  const body = formatBoard(board, items, row.fetchedAt);
  return {
    answer: row.sourceUrl ? `${body}\n\n게시판: ${row.sourceUrl}` : body,
    sources: [{ wiki: org, page: row.sourceUrl ?? '' }],
    answerClass: 4,
    board,
  };
}

interface BoardListItem {
  id: string;
  title: string;
  date?: string;
  url: string;
  summary?: string;
}

const FIELD_LABEL: Record<FactField, string> = {
  dean_contact: '연락처',
  faculty_count: '교원 수',
  student_count: '학생 수',
  faculty_roster: '구성원 명단',
  dept_count: '학과 수',
};

const BOARD_LABEL: Record<BoardKind, string> = {
  notice: '공지사항',
  news: '뉴스·소식',
  research: '연구성과',
};

/** 구조화 값 → 간결 markdown. value 구조는 field별로 유연(jsonb). */
function formatFact(field: FactField, value: Record<string, unknown>): string {
  const label = FIELD_LABEL[field];
  // 명단(배열)
  if (field === 'faculty_roster' && Array.isArray(value.items)) {
    const rows = (value.items as Record<string, unknown>[])
      .map((m) => `- ${m.name ?? ''}${m.role ? ` (${m.role})` : ''}${m.email ? ` · ${m.email}` : ''}`)
      .join('\n');
    return `**${label}**\n${rows}`;
  }
  // 단일 값(수치·연락처)
  const parts: string[] = [];
  for (const [k, v] of Object.entries(value)) {
    if (v === null || v === undefined || v === '') continue;
    parts.push(`- ${k}: ${String(v)}`);
  }
  return parts.length ? `**${label}**\n${parts.join('\n')}` : `**${label}** 정보가 있으나 형식을 확인할 수 없습니다.`;
}

/** 게시판 리스트 → markdown (최신순 상위 N). */
function formatBoard(board: BoardKind, items: BoardListItem[], fetchedAt: Date): string {
  const label = BOARD_LABEL[board];
  const top = items.slice(0, 10);
  const lines = top.map((it) => {
    const date = it.date ? ` (${it.date})` : '';
    return `- [${it.title}](${it.url})${date}`;
  });
  const stamp = new Date(fetchedAt).toISOString().slice(0, 16).replace('T', ' ');
  return `**최신 ${label}** (수집: ${stamp} 기준)\n${lines.join('\n')}`;
}
