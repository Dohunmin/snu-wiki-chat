import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth/config';
import { canAccessSensitive, canUseLens } from '@/lib/auth/roles';
import type { Role } from '@/lib/auth/roles';
import path from 'path';
import fs from 'fs';
import type { WikiData } from '@/lib/agents/types';
import agentsConfig from '@/data/agents.config.json';
import { db } from '@/lib/db/client';
import { liveCache } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ agentId: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { agentId } = await params;
  const role = (session.user as { role: Role }).role;

  // 접근 게이트: lensPersona 위키(leesj 등)는 lens 접근권(admin+tier1)으로, 그 외 adminOnly는 admin만.
  //   비허용자에겐 존재 자체를 부정(404). tier2·pending은 lens 위키 미도달 유지.
  const agentMeta = agentsConfig.agents.find(a => a.id === agentId);
  const blocked = (agentMeta as { lensPersona?: boolean } | undefined)?.lensPersona
    ? !canUseLens(role)
    : (agentMeta?.adminOnly && role !== 'admin');
  if (blocked) {
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

  // Tier4 live_cache(최신 공지·뉴스) — 단과대/대학원 org만. DB read(LLM 0토큰). 만료여도 신선도 badge로 표시.
  const group = (agentMeta as { group?: string } | undefined)?.group;
  let liveBoards:
    | { board: string; items: { title: string; date?: string; url: string }[]; sourceUrl: string | null; fetchedAt: string; fresh: boolean }[]
    | undefined;
  if (group) {
    try {
      const rows = await db.select().from(liveCache).where(eq(liveCache.org, agentId));
      const now = Date.now();
      liveBoards = rows
        .map(r => {
          const items = Array.isArray(r.payload) ? (r.payload as { title: string; date?: string; url: string }[]) : [];
          const ageH = (now - new Date(r.fetchedAt).getTime()) / 3.6e6;
          return {
            board: r.board,
            items: items.map(it => ({ title: it.title, date: it.date, url: it.url })),
            sourceUrl: r.sourceUrl,
            fetchedAt: (r.fetchedAt instanceof Date ? r.fetchedAt : new Date(r.fetchedAt)).toISOString(),
            fresh: ageH <= (r.ttlHours ?? 26),
          };
        })
        .sort((a, b) => (a.board === 'notice' ? -1 : b.board === 'notice' ? 1 : 0)); // 공지 먼저
    } catch (e) {
      console.error('[wiki] live_cache 조회 실패:', e);
      liveBoards = [];
    }
  }

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
    liveBoards,
  });
}
