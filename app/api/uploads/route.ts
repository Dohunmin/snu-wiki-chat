import { NextRequest } from 'next/server';
import { auth } from '@/lib/auth/config';
import { canUpload } from '@/lib/auth/roles';
import type { Role } from '@/lib/auth/roles';
import { db } from '@/lib/db/client';
import { uploads } from '@/lib/db/schema';
import { z } from 'zod';

const uploadSchema = z.object({
  agentId: z.enum(['senate', 'board', 'plan', 'vision']),
  fileName: z.string().min(1).max(255),
  content: z.string().min(1).max(500_000),
});

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return Response.json({ error: '로그인이 필요합니다.' }, { status: 401 });
  }

  const role = session.user.role as Role;
  if (!canUpload(role)) {
    return Response.json({ error: '자료 업로드 권한이 없습니다.' }, { status: 403 });
  }

  const body = await req.json();
  const parsed = uploadSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: '업로드할 자료 형식이 올바르지 않습니다.' }, { status: 400 });
  }

  const { agentId, fileName, content } = parsed.data;

  await db.insert(uploads).values({
    id: crypto.randomUUID(),
    userId: session.user.id,
    agentId,
    fileName,
    content,
    status: role === 'admin' ? 'approved' : 'pending',
    reviewedBy: role === 'admin' ? session.user.id : null,
    reviewedAt: role === 'admin' ? new Date() : null,
  });

  return Response.json({
    message: role === 'admin'
      ? '자료가 업로드되었습니다.'
      : '자료가 검토 대기 상태로 업로드되었습니다.',
  });
}
