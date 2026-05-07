import { NextRequest } from 'next/server';
import { auth } from '@/lib/auth/config';
import { db } from '@/lib/db/client';
import { conversations, messages } from '@/lib/db/schema';
import { eq, desc, sql } from 'drizzle-orm';

export async function GET(_req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return Response.json({ error: '로그인이 필요합니다.' }, { status: 401 });
  }

  const userId = session.user.id;

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
    .orderBy(desc(conversations.createdAt))
    .limit(30);

  return Response.json(rows);
}
