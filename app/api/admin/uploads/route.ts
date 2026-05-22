import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/rbac';
import { db } from '@/lib/db/client';
import { uploads, users } from '@/lib/db/schema';
import { desc, eq } from 'drizzle-orm';

export async function GET(req: NextRequest) {
  const result = await requireAdmin(req);
  if (result instanceof NextResponse) return result;

  const rows = await db
    .select({
      id: uploads.id,
      fileName: uploads.fileName,
      agentId: uploads.agentId,
      status: uploads.status,
      createdAt: uploads.createdAt,
      userName: users.name,
      userEmail: users.email,
    })
    .from(uploads)
    .leftJoin(users, eq(uploads.userId, users.id))
    .orderBy(desc(uploads.createdAt));

  return Response.json(rows);
}
