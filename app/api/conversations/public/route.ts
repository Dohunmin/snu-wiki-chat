import { NextRequest } from 'next/server';
import { auth } from '@/lib/auth/config';
import { db } from '@/lib/db/client';
import { conversations } from '@/lib/db/schema';
import { desc, ne } from 'drizzle-orm';
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
    .orderBy(desc(conversations.createdAt))
    .limit(limit)
    .offset(offset);

  return Response.json(rows);
}
