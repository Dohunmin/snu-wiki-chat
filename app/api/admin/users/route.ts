import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/rbac';
import { db } from '@/lib/db/client';
import { users } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
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
  action: z.enum(['approve', 'reject', 'delete', 'reset-password']),
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

  // 승인된(활성) 회원 삭제 — 자기 자신·마스터 관리자는 보호(로그인 잠김 방지).
  if (action === 'delete') {
    if (userId === approverId) {
      return NextResponse.json({ error: '본인 계정은 삭제할 수 없습니다' }, { status: 400 });
    }
    if (userId === 'master-admin') {
      return NextResponse.json({ error: '마스터 관리자 계정은 삭제할 수 없습니다' }, { status: 400 });
    }
    await db.delete(users).where(eq(users.id, userId));
    return NextResponse.json({ message: '삭제되었습니다' });
  }

  // 비밀번호 초기화 — 임시 비밀번호 발급(이메일 인프라 없이 admin 중개). 사용자는 로그인 후 /account에서 변경.
  if (action === 'reset-password') {
    if (userId === 'master-admin') {
      return NextResponse.json({ error: '마스터 관리자 계정은 환경변수로 관리됩니다' }, { status: 400 });
    }
    const [target] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
    if (!target) {
      return NextResponse.json({ error: '사용자를 찾을 수 없습니다' }, { status: 404 });
    }
    // URL-safe 임시 비밀번호 (12자). 평문은 응답으로 1회만 반환 — 저장은 해시만.
    const tempPassword = crypto.randomBytes(9).toString('base64url');
    await db
      .update(users)
      .set({ passwordHash: await bcrypt.hash(tempPassword, 12), updatedAt: new Date() })
      .where(eq(users.id, userId));
    return NextResponse.json({ message: '임시 비밀번호가 발급되었습니다', tempPassword });
  }

  return NextResponse.json({ error: '잘못된 요청입니다' }, { status: 400 });
}
