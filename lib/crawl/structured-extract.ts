// Design Ref: college-grad-wiki §2.2 / §3.3 — Tier3 producer (crawl-side).
// 크롤 본문에서 구조화 사실(연락처·인원·학과수)을 best-effort 추출 → structured_facts upsert.
// 격리: producer(crawl→DB row). app(route.ts)은 이 파일을 import하지 않고 lib/agents/structured.ts로 row만 읽는다.
//
// 추출은 휴리스틱(고정 HTML 아님) → 확신 가능한 것만 기록. 불확실하면 생략(할루시네이션 금지, P1).
//   - dean_contact : 본문 이메일/전화 (있을 때만)
//   - faculty_count: "교원/교수 NN명" 패턴 (있을 때만)
//   - student_count: "재학생/학생 NN명" 패턴 (있을 때만)
//   - dept_count   : colleges.yaml org.dept_count (정찰 확정값 — 가장 신뢰)

import { db } from '@/lib/db/client';
import { structuredFacts } from '@/lib/db/schema';
import type { Org } from '../config/orgs';
import type { MainContent } from './types';
import type { FactField } from '@/lib/agents/structured';

export interface FactRecord {
  id: string; // `${org}:${field}`
  org: string;
  field: FactField;
  value: Record<string, unknown>;
  sourceUrl: string;
  ttlDays: number;
}

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.(?:ac\.kr|snu\.kr|com|org|net|kr)/gi;
const PHONE_RE = /0\d{1,2}[-)\s]?\d{3,4}[-\s]?\d{4}/g;

/** 본문 → FactRecord[] (확신 가능한 것만). org.dept_count는 항상 기록. */
export function extractFacts(content: MainContent, org: Org, sourceUrl: string): FactRecord[] {
  const text = content.markdown;
  const out: FactRecord[] = [];

  // dean_contact — 인사말/소개 페이지의 대표 이메일·전화 (있을 때만)
  const emails = Array.from(new Set((text.match(EMAIL_RE) ?? []).map((e) => e.toLowerCase())));
  const phones = Array.from(new Set(text.match(PHONE_RE) ?? []));
  if (emails.length > 0 || phones.length > 0) {
    out.push(rec(org, 'dean_contact', sourceUrl, 90, {
      ...(emails.length ? { email: emails[0] } : {}),
      ...(phones.length ? { phone: phones[0] } : {}),
      ...(emails.length > 1 ? { 추가_이메일: emails.slice(1, 4).join(', ') } : {}),
    }));
  }

  // faculty_count — "교원/교수/전임교원 NN명"
  const fac = matchCount(text, /(?:전임\s*)?(?:교원|교수)\s*(?:수|진)?\s*[:은는]?\s*(\d{2,4})\s*명/);
  if (fac !== null) out.push(rec(org, 'faculty_count', sourceUrl, 90, { count: fac, label: '교원 수' }));

  // student_count — "재학생/학생 NN명"
  const stu = matchCount(text, /(?:재학생|학생)\s*(?:수)?\s*[:은는]?\s*(\d{2,5})\s*명/);
  if (stu !== null) out.push(rec(org, 'student_count', sourceUrl, 90, { count: stu, label: '학생 수' }));

  // dept_count — colleges.yaml 정찰 확정값 (가장 신뢰, 본문 무관하게 기록)
  if (typeof org.dept_count === 'number' && org.dept_count > 0) {
    out.push(rec(org, 'dept_count', sourceUrl, 180, { count: org.dept_count, label: '학과/전공 수' }));
  }

  return out;
}

/**
 * 교수 디렉토리 페이지 → faculty_count (Tier3). .md는 안 만들고 fact만.
 * "전체/총 NNN명" 또는 "교원/교수 NNN명" 중 최대값(=디렉토리 총원)을 채택. 없으면 null(P1 할루시네이션 금지).
 */
export function extractFacultyCount(markdown: string, org: Org, sourceUrl: string): FactRecord | null {
  const cands: number[] = [];
  const re = /(?:전체|총|교원|교수)\s*(?:진|수)?\s*[:\s]*(\d{2,4})\s*(?:명|인|건|위)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) {
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n) && n >= 30 && n <= 2000) cands.push(n); // 단과대 교원 규모 합리범위
  }
  if (cands.length === 0) return null;
  const count = Math.max(...cands);
  return rec(org, 'faculty_count', sourceUrl, 90, { count, label: '교원 수(디렉토리)' });
}

function matchCount(text: string, re: RegExp): number | null {
  const m = text.match(re);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

function rec(org: Org, field: FactField, sourceUrl: string, ttlDays: number, value: Record<string, unknown>): FactRecord {
  return { id: `${org.id}:${field}`, org: org.id, field, value, sourceUrl, ttlDays };
}

/** structured_facts upsert (id 충돌 시 value·source·fetchedAt 갱신). */
export async function upsertFacts(records: FactRecord[]): Promise<number> {
  let n = 0;
  for (const r of records) {
    try {
      await db
        .insert(structuredFacts)
        .values({ id: r.id, org: r.org, field: r.field, value: r.value, sourceUrl: r.sourceUrl, ttlDays: r.ttlDays })
        .onConflictDoUpdate({
          target: structuredFacts.id,
          set: { value: r.value, sourceUrl: r.sourceUrl, ttlDays: r.ttlDays, fetchedAt: new Date() },
        });
      n++;
    } catch (err) {
      console.error(`[tier3-extract] upsert 실패 ${r.id}:`, err);
    }
  }
  return n;
}
