import { NextRequest } from 'next/server';
import { auth } from '@/lib/auth/config';
import { db } from '@/lib/db/client';
import { conversations } from '@/lib/db/schema';
import { desc, ne } from 'drizzle-orm';
import { canAccessSensitive } from '@/lib/auth/roles';
import { z } from 'zod';

// Design Ref: §2.3 — limit 100→300, ?offset 지원.
const querySchema = z.object({
  offset: z.coerce.number().int().nonnegative().optional().default(0),
  limit: z.coerce.number().int().min(1).max(300).optional().default(300),
});

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return Response.json({ error: '로그인이 필요합니다.' }, { status: 401 });
  }
  // 공개 뷰어는 canAccessSensitive(admin/tier1)만 — tier2는 타 유저 대화 목록/열람 차단(감사 H-3)
  if (!canAccessSensitive(session.user.role)) {
    return Response.json({ error: '접근 권한이 없습니다.' }, { status: 403 });
  }

  const url = new URL(req.url);
  const parsed = querySchema.safeParse({
    offset: url.searchParams.get('offset') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined,
  });
  if (!parsed.success) {
    return Response.json({ error: '잘못된 페이지네이션 파라미터입니다.' }, { status: 400 });
  }
  const { offset, limit } = parsed.data;
  const userId = session.user.id;

  const rows = await db
    .select({
      id: conversations.id,
      title: conversations.title,
      createdAt: conversations.createdAt,
    })
    .from(conversations)
    .where(ne(conversations.userId, userId))
    .orderBy(desc(conversations.updatedAt))   // 마지막 활동순 — 후속질문 반영(생성순 아님)
    .limit(limit)
    .offset(offset);

  return Response.json(rows);
}
