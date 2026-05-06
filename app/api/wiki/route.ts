import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth/config';
import path from 'path';
import fs from 'fs';
import type { WikiData } from '@/lib/agents/types';
import agentsConfig from '@/data/agents.config.json';

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const wikis = agentsConfig.agents
    .filter(a => a.enabled)
    .map(a => {
      const filePath = path.join(process.cwd(), 'data', a.dataFile);
      if (!fs.existsSync(filePath)) return null;
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as WikiData;
      return {
        id: data.id,
        name: data.name,
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
