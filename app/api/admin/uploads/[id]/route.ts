import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/rbac';
import { db } from '@/lib/db/client';
import { uploads } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';

const MIME_MAP: Record<string, string> = {
  pdf:  'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  hwp:  'application/x-hwp',
  txt:  'text/plain',
  md:   'text/markdown',
  csv:  'text/csv',
  json: 'application/json',
};

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const result = await requireAdmin(req);
  if (result instanceof NextResponse) return result;

  const { id } = await params;
  const [row] = await db.select().from(uploads).where(eq(uploads.id, id));
  if (!row) return Response.json({ error: '파일을 찾을 수 없습니다.' }, { status: 404 });

  const content = row.content;
  const ext = row.fileName.split('.').pop()?.toLowerCase() ?? '';

  // base64 DataURL이면 바이너리 파일
  if (content.startsWith('data:')) {
    const [header, b64] = content.split(',');
    const mimeMatch = header.match(/data:([^;]+)/);
    const mimeType = mimeMatch?.[1] ?? MIME_MAP[ext] ?? 'application/octet-stream';
    const buffer = Buffer.from(b64, 'base64');
    return new Response(buffer, {
      headers: {
        'Content-Type': mimeType,
        'Content-Disposition': `attachment; filename="${encodeURIComponent(row.fileName)}"`,
      },
    });
  }

  // 텍스트 파일
  const mimeType = MIME_MAP[ext] ?? 'text/plain';
  return new Response(content, {
    headers: {
      'Content-Type': `${mimeType}; charset=utf-8`,
      'Content-Disposition': `attachment; filename="${encodeURIComponent(row.fileName)}"`,
    },
  });
}
