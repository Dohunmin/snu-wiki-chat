import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth/config';
import path from 'path';
import fs from 'fs';
import type { WikiData } from '@/lib/agents/types';

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const agentIds = ['senate', 'board', 'plan', 'vision'];
  const wikis = agentIds.map(id => {
    const filePath = path.join(process.cwd(), 'data', `${id}.json`);
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
      },
    };
  }).filter(Boolean);

  return NextResponse.json({ wikis });
}
