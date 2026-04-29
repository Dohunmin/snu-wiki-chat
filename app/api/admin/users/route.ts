import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/rbac';
import { db } from '@/lib/db/client';
import { users } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Session } from 'next-auth';

// GET: 전체 사용자 목록
export async function GET(req: NextRequest) {
  const result = await requireAdmin(req);
  if (result instanceof NextResponse) return result;

  const allUsers = await db
    .select({ id: users.id, email: users.email, name: users.name, role: users.role, createdAt: users.createdAt, approvedAt: users.approvedAt })
    .from(users)
    .orderBy(users.createdAt);

  return NextResponse.json(allUsers);
}

const approveSchema = z.object({
  userId: z.string(),
  action: z.enum(['approve', 'reject']),
  role: z.enum(['admin', 'tier1', 'tier2']).optional(),
});

// PATCH: 사용자 승인/거부/역할 변경
export async function PATCH(req: NextRequest) {
  const result = await requireAdmin(req);
  if (result instanceof NextResponse) return result;
  const session = result as Session;
  const approverId = session.user?.id;

  if (!approverId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json();
  const parsed = approveSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: '잘못된 요청입니다' }, { status: 400 });
  }
  const { userId, action, role } = parsed.data;

  if (action === 'approve' && role) {
    await db
      .update(users)
      .set({
        role,
        approvedBy: approverId,
        approvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));
    return NextResponse.json({ message: '승인되었습니다' });
  }

  if (action === 'reject') {
    await db.delete(users).where(eq(users.id, userId));
    return NextResponse.json({ message: '거부되었습니다' });
  }

  return NextResponse.json({ error: '잘못된 요청입니다' }, { status: 400 });
}
