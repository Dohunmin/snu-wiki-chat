import { NextRequest } from 'next/server';
import { auth } from '@/lib/auth/config';
import { db } from '@/lib/db/client';
import { conversations, messages } from '@/lib/db/schema';
import { eq, desc, sql } from 'drizzle-orm';
import { z } from 'zod';

// public 라우트와 동일한 페이지네이션 계약 — 과거 hardcoded limit(30)으로 31번째+ 대화가
//   사이드바·"전체 보기"에서 통째로 누락되던 버그 해소. 기본 배치를 public(300)과 동일하게.
const querySchema = z.object({
  offset: z.coerce.number().int().nonnegative().optional().default(0),
  limit: z.coerce.number().int().min(1).max(300).optional().default(300),
});

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return Response.json({ error: '로그인이 필요합니다.' }, { status: 401 });
  }

  const userId = session.user.id;

  const url = new URL(req.url);
  const parsed = querySchema.safeParse({
    offset: url.searchParams.get('offset') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined,
  });
  if (!parsed.success) {
    return Response.json({ error: '잘못된 페이지네이션 파라미터입니다.' }, { status: 400 });
  }
  const { offset, limit } = parsed.data;

  // 각 conversation의 첫 user 메시지 mode를 LATERAL 서브쿼리로 함께 조회
  const firstModeSubquery = sql<string>`(
    SELECT m.mode FROM ${messages} m
    WHERE m.conversation_id = ${conversations.id}
    ORDER BY m.created_at ASC
    LIMIT 1
  )`.as('first_mode');

  const rows = await db
    .select({
      id: conversations.id,
      title: conversations.title,
      createdAt: conversations.createdAt,
      mode: firstModeSubquery,
    })
    .from(conversations)
    .where(eq(conversations.userId, userId))
    .orderBy(desc(conversations.updatedAt))   // 마지막 활동순 — 후속질문이 부모 대화를 상위로 올림(생성순 아님)
    .limit(limit)
    .offset(offset);

  return Response.json(rows);
}
