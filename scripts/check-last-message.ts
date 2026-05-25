/**
 * 최근 assistant 메시지의 raw content + sources 확인.
 * - [N] 패턴 vs [위키] sid 패턴 카운트
 * - sources 필드 = LLM 인용된 것만인지
 */

import { db } from '@/lib/db/client';
import { messages } from '@/lib/db/schema';
import { desc, eq } from 'drizzle-orm';

async function main() {
  const recent = await db
    .select()
    .from(messages)
    .where(eq(messages.role, 'assistant'))
    .orderBy(desc(messages.createdAt))
    .limit(3);

  for (const m of recent) {
    console.log('═'.repeat(80));
    console.log(`createdAt: ${m.createdAt}`);
    console.log(`mode: ${m.mode}`);
    console.log(`routedAgents: ${m.routedAgents?.join(', ')}`);
    console.log(`sources 수: ${(m.sources as object[] | null)?.length ?? 0}`);
    console.log(`sources: ${JSON.stringify(m.sources, null, 2).slice(0, 500)}...`);
    console.log('');

    const content = m.content;
    const numbered = [...content.matchAll(/\[(\d+)\]/g)];
    const oldFormat = [...content.matchAll(/\[([^\]\d][^\]]*)\]\s+([^\s,.;:!?）)]+)/g)];

    console.log(`[N] 패턴 발견: ${numbered.length}개`);
    if (numbered.length > 0) {
      console.log(`  샘플: ${numbered.slice(0, 5).map(m => m[0]).join(', ')}`);
    }

    console.log(`[위키] sid 패턴 발견: ${oldFormat.length}개`);
    if (oldFormat.length > 0) {
      console.log(`  샘플: ${oldFormat.slice(0, 10).map(m => `${m[1]}|${m[2]}`).join(' / ')}`);
    }

    console.log('');
    console.log('--- content 앞 1500자 ---');
    console.log(content.slice(0, 1500));
    console.log('');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
