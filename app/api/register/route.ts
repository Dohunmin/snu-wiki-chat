import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { db } from '@/lib/db/client';
import { users } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1).max(50),
});

export async function POST(req: NextRequest) {
  const body = await req.json();
  const parsed = registerSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: '입력값을 확인해주세요' }, { status: 400 });
  }
  const { email, password, name } = parsed.data;

  // 중복 이메일 확인
  const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (existing) {
    return NextResponse.json({ error: '이미 사용 중인 이메일입니다' }, { status: 409 });
  }

  const passwordHash = await bcrypt.hash(password, 12);

  await db.insert(users).values({
    id: crypto.randomUUID(),
    email,
    passwordHash,
    name,
    role: 'pending',
  });

  return NextResponse.json({ message: '가입 신청이 완료되었습니다. 관리자 승인을 기다려주세요.' }, { status: 201 });
}
