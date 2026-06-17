import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth/config';
import path from 'path';
import fs from 'fs';
import type { WikiData } from '@/lib/agents/types';
import type { Role } from '@/lib/auth/roles';
import { canUseLens } from '@/lib/auth/roles';
import agentsConfig from '@/data/agents.config.json';

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const role = (session.user as { role: Role }).role;
  const isAdmin = role === 'admin';

  const wikis = agentsConfig.agents
    .filter(a => a.enabled)
    // lensPersona 위키(leesj 등) → lens 접근권(admin+tier1)으로 노출. 그 외 adminOnly → admin만. tier2·pending 차단 유지.
    .filter(a =>
      (a as { lensPersona?: boolean }).lensPersona
        ? canUseLens(role)
        : (!a.adminOnly || isAdmin),
    )
    .map(a => {
      const filePath = path.join(process.cwd(), 'data', a.dataFile);
      if (!fs.existsSync(filePath)) return null;
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as WikiData;
      return {
        id: data.id,
        name: data.name,
        group: (a as { group?: string }).group ?? null,
        counts: {
          sources: data.sources.length,
          topics: data.topics.length,
          entities: data.entities.length,
          syntheses: data.syntheses.length,
          facts: (data.facts ?? []).length,
          stances: (data.stances ?? []).length,
          overviews: (data.overviews ?? []).length,
        },
      };
    })
    .filter(Boolean);

  return NextResponse.json({ wikis });
}
