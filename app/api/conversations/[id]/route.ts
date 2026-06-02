import { NextRequest } from 'next/server';
import { auth } from '@/lib/auth/config';
import { db } from '@/lib/db/client';
import { conversations, messages } from '@/lib/db/schema';
import { canAccessSensitive } from '@/lib/auth/roles';
import { eq, and, asc } from 'drizzle-orm';


export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return Response.json({ error: '로그인이 필요합니다.' }, { status: 401 });
  }

  const { id } = await params;

  // 본인 대화는 항상, 타인 대화는 canAccessSensitive(admin/tier1)만 열람 — tier2 교차 열람 차단(감사 H-3)
  const [conv] = await db
    .select({ userId: conversations.userId })
    .from(conversations)
    .where(eq(conversations.id, id))
    .limit(1);

  if (!conv) {
    return Response.json({ error: '대화를 찾을 수 없습니다.' }, { status: 404 });
  }
  if (conv.userId !== session.user.id && !canAccessSensitive(session.user.role)) {
    return Response.json({ error: '본인 대화만 열람할 수 있습니다.' }, { status: 403 });
  }

  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, id))
    .orderBy(asc(messages.createdAt));

  return Response.json(rows);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return Response.json({ error: '로그인이 필요합니다.' }, { status: 401 });
  }

  const { id } = await params;
  const userId = session.user.id;

  const [conv] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.id, id), eq(conversations.userId, userId)))
    .limit(1);

  if (!conv) {
    return Response.json({ error: '대화를 찾을 수 없습니다.' }, { status: 404 });
  }

  await db.delete(conversations).where(eq(conversations.id, id));
  return Response.json({ ok: true });
}
