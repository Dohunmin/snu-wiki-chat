import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth/config';
import type { Role } from '@/lib/auth/roles';
import { db } from '@/lib/db/client';
import { syntheses } from '@/lib/db/schema';
import { desc, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const userId = (session.user as { id: string; role: Role }).id;

  const rows = await db
    .select()
    .from(syntheses)
    .where(eq(syntheses.userId, userId))
    .orderBy(desc(syntheses.createdAt))
    .limit(50);

  return NextResponse.json({ syntheses: rows });
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { query, answeredAt, routedTo, tags, content, conversationId } = await req.json();
  if (!query || !content) {
    return NextResponse.json({ error: 'query and content required' }, { status: 400 });
  }

  const userId = (session.user as { id: string; role: Role }).id;
  const id = nanoid();

  await db.insert(syntheses).values({
    id,
    userId,
    conversationId: conversationId ?? null,
    query,
    answeredAt: answeredAt ?? new Date().toISOString().slice(0, 10),
    routedTo: routedTo ?? [],
    tags: tags ?? [],
    content,
  });

  return NextResponse.json({ id });
}
