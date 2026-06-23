import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth/config';
import { db } from '@/lib/db/client';
import { users } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import { z } from 'zod';

const schema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
});

// 로그인한 사용자가 본인 비밀번호를 변경. (관리자 임시발급 비번 → 사용자 자가 변경 경로)
export async function POST(req: Request) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: '로그인이 필요합니다' }, { status: 401 });
  }
  // 마스터 관리자는 환경변수로 로그인하므로 DB 해시 변경이 의미 없음 → 차단.
  if (userId === 'master-admin') {
    return NextResponse.json({ error: '마스터 관리자 계정은 환경변수로 관리됩니다' }, { status: 400 });
  }

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: '새 비밀번호는 8자 이상이어야 합니다' }, { status: 400 });
  }
  const { currentPassword, newPassword } = parsed.data;

  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) {
    return NextResponse.json({ error: '사용자를 찾을 수 없습니다' }, { status: 404 });
  }

  const valid = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!valid) {
    return NextResponse.json({ error: '현재 비밀번호가 올바르지 않습니다' }, { status: 400 });
  }

  await db
    .update(users)
    .set({ passwordHash: await bcrypt.hash(newPassword, 12), updatedAt: new Date() })
    .where(eq(users.id, userId));

  return NextResponse.json({ message: '비밀번호가 변경되었습니다' });
}
