import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth/config';
import { canAccessSensitive } from '@/lib/auth/roles';
import type { Role } from '@/lib/auth/roles';
import path from 'path';
import fs from 'fs';
import type { WikiData } from '@/lib/agents/types';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ agentId: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { agentId } = await params;
  const filePath = path.join(process.cwd(), 'data', `${agentId}.json`);
  if (!fs.existsSync(filePath)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as WikiData;
  const role = (session.user as { role: Role }).role;
  const isSensitiveAllowed = canAccessSensitive(role);

  // 민감 소스 필터링
  const sources = isSensitiveAllowed
    ? data.sources
    : data.sources.filter(s => !s.sensitive);

  return NextResponse.json({
    id: data.id,
    name: data.name,
    sources: sources.map(s => ({ id: s.id, title: s.title, date: s.date, tags: s.tags, topics: s.topics, entities: s.entities, content: s.content })),
    topics: data.topics,
    entities: data.entities,
    syntheses: data.syntheses,
  });
}
