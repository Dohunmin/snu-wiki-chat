import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth/config';
import { canAccessSensitive } from '@/lib/auth/roles';
import type { Role } from '@/lib/auth/roles';
import path from 'path';
import fs from 'fs';
import type { WikiData } from '@/lib/agents/types';
import agentsConfig from '@/data/agents.config.json';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ agentId: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { agentId } = await params;
  const role = (session.user as { role: Role }).role;

  // adminOnly 위키는 비admin에게 존재 자체를 부정 (404)
  const agentMeta = agentsConfig.agents.find(a => a.id === agentId);
  if (agentMeta?.adminOnly && role !== 'admin') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const filePath = path.join(process.cwd(), 'data', `${agentId}.json`);
  if (!fs.existsSync(filePath)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as WikiData;
  const isSensitiveAllowed = canAccessSensitive(role);

  // 민감 소스 필터링
  const sources = isSensitiveAllowed
    ? data.sources
    : data.sources.filter(s => !s.sensitive);

  const facts = isSensitiveAllowed
    ? (data.facts ?? [])
    : (data.facts ?? []).filter(f => !f.sensitive);

  const stances = isSensitiveAllowed
    ? (data.stances ?? [])
    : (data.stances ?? []).filter(s => !s.sensitive);

  return NextResponse.json({
    id: data.id,
    name: data.name,
    sources: sources.map(s => ({ id: s.id, title: s.title, date: s.date, tags: s.tags, topics: s.topics, entities: s.entities, content: s.content })),
    topics: data.topics,
    entities: data.entities,
    syntheses: data.syntheses,
    facts: facts.map(f => ({ id: f.id, title: f.title, category: f.category, yearsCovered: f.yearsCovered, unit: f.unit, tags: f.tags, content: f.content })),
    stances: stances.map(s => ({ id: s.id, title: s.title, holder: s.holder, topic: s.topic, tags: s.tags, content: s.content })),
    overviews: (data.overviews ?? []).map(o => ({ id: o.id, title: o.title, 편: o.편, 시기: o.시기, tags: o.tags, content: o.content })),
  });
}
