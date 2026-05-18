/**
 * Design Ref: §11.1 — scripts/build-embeddings.ts
 * Plan SC: SC2 (finance 임베딩 성공, DB row >= 청크 수)
 *
 * 위키 1개의 모든 청크를 Voyage로 임베딩 후 chunk_embeddings 테이블에 UPSERT.
 *
 * Usage:
 *   npm run embed:build -- finance
 *   npx tsx --env-file=.env.local scripts/build-embeddings.ts finance
 *   npx tsx --env-file=.env.local scripts/build-embeddings.ts --all-rag-enabled
 *
 * 증분 갱신: content_hash 비교로 변경되지 않은 청크는 스킵.
 * 안전 재실행: 같은 스크립트 여러 번 돌려도 결과 동일 (idempotent).
 */

import fs from 'fs';
import path from 'path';
import process from 'process';
import { eq } from 'drizzle-orm';

// Node 20.6+의 process.loadEnvFile() — tsx 단독 실행 시 .env.local 자동 로드
// (npm script + --env-file 사용 시엔 이미 로드됨, try/catch로 무해)
try {
  if (typeof process.loadEnvFile === 'function') {
    process.loadEnvFile('.env.local');
  }
} catch {
  // .env.local 없거나 이미 로드됨 → 무시
}

import { db } from '@/lib/db/client';
import { chunkEmbeddings } from '@/lib/db/schema';
import { chunkifyWiki, chunkStats } from '@/lib/embed/chunker';
import { embedBatched } from '@/lib/embed/voyage';
import type { WikiData } from '@/lib/agents/types';
import agentsConfig from '@/data/agents.config.json';

interface AgentEntry {
  id: string;
  name: string;
  type: string;
  dataFile: string;
  enabled: boolean;
  ragEnabled?: boolean;
}

// Voyage 4-large 가격: $0.12 / 1M tokens (200M free tier)
const VOYAGE_PRICE_PER_M_TOKENS = 0.12;

async function buildWiki(agent: AgentEntry): Promise<void> {
  const wikiId = agent.id;
  console.log(`\n${'='.repeat(60)}`);
  console.log(`📚 ${agent.name} (${wikiId})`);
  console.log('='.repeat(60));

  // ─── 1. 위키 데이터 로드 ──────────────────────────────────
  const dataPath = path.join(process.cwd(), 'data', agent.dataFile);
  if (!fs.existsSync(dataPath)) {
    console.error(`❌ Data file not found: ${dataPath}`);
    return;
  }
  const wikiData = JSON.parse(fs.readFileSync(dataPath, 'utf-8')) as WikiData;

  // ─── 2. 청크화 ────────────────────────────────────────────
  console.log('\n[1/4] Chunking...');
  const chunks = chunkifyWiki(wikiData);
  const stats = chunkStats(chunks);
  console.log(`  Total chunks: ${stats.total}`);
  console.log(`  By type:`, stats.byType);
  console.log(`  Avg length: ${stats.avgLength} chars`);
  console.log(`  Sensitive: ${stats.sensitive}`);

  if (chunks.length === 0) {
    console.log('  No chunks to embed. Skipping.');
    return;
  }

  // ─── 3. 기존 임베딩 조회 (증분 갱신) ──────────────────────
  console.log('\n[2/4] Checking existing embeddings...');
  const existing = await db
    .select({ id: chunkEmbeddings.id, hash: chunkEmbeddings.contentHash })
    .from(chunkEmbeddings)
    .where(eq(chunkEmbeddings.wikiId, wikiId));
  const existingMap = new Map(existing.map(e => [e.id, e.hash]));

  // hash 같으면 스킵
  const toEmbed = chunks.filter(c => existingMap.get(c.id) !== c.contentHash);
  const unchanged = chunks.length - toEmbed.length;
  console.log(`  Already up-to-date: ${unchanged}`);
  console.log(`  To embed: ${toEmbed.length}`);

  // 사라진 청크(원본에서 삭제됨) 정리 — content_hash 기반 정합성 유지
  const currentIds = new Set(chunks.map(c => c.id));
  const orphans = existing.filter(e => !currentIds.has(e.id));
  if (orphans.length > 0) {
    console.log(`  Orphans to delete: ${orphans.length}`);
  }

  if (toEmbed.length === 0 && orphans.length === 0) {
    console.log('\n✅ All chunks up-to-date. Nothing to do.');
    return;
  }

  // ─── 4. Voyage 임베딩 ─────────────────────────────────────
  let embeddings: number[][] = [];
  if (toEmbed.length > 0) {
    console.log(`\n[3/4] Embedding ${toEmbed.length} chunks via Voyage 4-large...`);
    const startTime = Date.now();
    embeddings = await embedBatched(
      toEmbed.map(c => c.chunkText),
      'document',
    );
    const elapsed = (Date.now() - startTime) / 1000;

    // 비용 추정 (Voyage 한국어 토큰 ≈ 글자 수 × 0.7, 영어 혼합 ≈ 글자 수 / 4)
    const totalChars = toEmbed.reduce((s, c) => s + c.chunkText.length, 0);
    const estTokens = Math.round(totalChars * 0.7);   // 한국어 보수적 추정
    const estCost = (estTokens / 1_000_000) * VOYAGE_PRICE_PER_M_TOKENS;
    console.log(`  Elapsed: ${elapsed.toFixed(1)}s`);
    console.log(`  Total chars: ${totalChars}`);
    console.log(`  Est. tokens: ~${estTokens.toLocaleString()} (한국어 보수 추정)`);
    console.log(`  Est. cost: $${estCost.toFixed(4)} (free tier: 200M tokens, $0 청구)`);
  }

  // ─── 5. DB UPSERT ────────────────────────────────────────
  console.log(`\n[4/4] Upserting to DB...`);
  const insertStart = Date.now();
  let upserted = 0;
  for (let i = 0; i < toEmbed.length; i++) {
    const chunk = toEmbed[i];
    const embedding = embeddings[i];
    await db
      .insert(chunkEmbeddings)
      .values({
        id: chunk.id,
        wikiId: chunk.wikiId,
        pageType: chunk.pageType,
        pageId: chunk.pageId,
        chunkIdx: chunk.chunkIdx,
        chunkText: chunk.chunkText,
        embedding: embedding,
        sensitive: chunk.sensitive,
        metadata: chunk.metadata,
        contentHash: chunk.contentHash,
      })
      .onConflictDoUpdate({
        target: chunkEmbeddings.id,
        set: {
          chunkText: chunk.chunkText,
          embedding: embedding,
          sensitive: chunk.sensitive,
          metadata: chunk.metadata,
          contentHash: chunk.contentHash,
        },
      });
    upserted++;
    if (upserted % 25 === 0 || upserted === toEmbed.length) {
      console.log(`  ${upserted}/${toEmbed.length}...`);
    }
  }

  // ─── 6. Orphan 삭제 ──────────────────────────────────────
  let deleted = 0;
  for (const o of orphans) {
    await db.delete(chunkEmbeddings).where(eq(chunkEmbeddings.id, o.id));
    deleted++;
  }
  if (deleted > 0) {
    console.log(`  Deleted orphans: ${deleted}`);
  }

  const dbElapsed = (Date.now() - insertStart) / 1000;
  console.log(`  DB time: ${dbElapsed.toFixed(1)}s`);

  // ─── 7. 검증 ────────────────────────────────────────────
  const finalCount = await db
    .select({ id: chunkEmbeddings.id })
    .from(chunkEmbeddings)
    .where(eq(chunkEmbeddings.wikiId, wikiId));
  console.log(`\n✅ Done. DB rows for '${wikiId}': ${finalCount.length} (expected: ${chunks.length})`);
  if (finalCount.length !== chunks.length) {
    console.warn(`⚠️  Row count mismatch! Check for errors above.`);
  }
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Usage: npx tsx scripts/build-embeddings.ts <wikiId | --all-rag-enabled>');
    console.error('');
    console.error('Available rag-enabled wikis:');
    const ragEnabled = (agentsConfig.agents as AgentEntry[])
      .filter(a => a.enabled && a.ragEnabled)
      .map(a => `  - ${a.id} (${a.name})`);
    console.error(ragEnabled.length > 0 ? ragEnabled.join('\n') : '  (none)');
    process.exit(1);
  }

  const agents: AgentEntry[] = arg === '--all-rag-enabled'
    ? (agentsConfig.agents as AgentEntry[]).filter(a => a.enabled && a.ragEnabled)
    : (() => {
        const found = (agentsConfig.agents as AgentEntry[]).find(a => a.id === arg);
        if (!found) {
          console.error(`❌ Unknown wikiId: ${arg}`);
          process.exit(1);
        }
        if (!found.ragEnabled) {
          console.warn(`⚠️  Wiki '${arg}' has ragEnabled=false. Proceeding anyway (PoC override)...`);
        }
        return [found];
      })();

  if (agents.length === 0) {
    console.error('No wikis matched.');
    process.exit(1);
  }

  // 환경변수 검증
  if (!process.env.VOYAGE_API_KEY) {
    console.error('❌ VOYAGE_API_KEY not set. Add to .env.local or use --env-file flag.');
    process.exit(1);
  }
  if (!process.env.POSTGRES_URL && !process.env.DATABASE_URL) {
    console.error('❌ POSTGRES_URL not set. Add to .env.local from Neon/Vercel Postgres dashboard.');
    process.exit(1);
  }

  console.log(`\n🚀 Building embeddings for ${agents.length} wiki(s): ${agents.map(a => a.id).join(', ')}`);

  const overallStart = Date.now();
  for (const agent of agents) {
    await buildWiki(agent);
  }
  const overallElapsed = (Date.now() - overallStart) / 1000;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`🏁 All done. Total time: ${overallElapsed.toFixed(1)}s`);
  console.log('='.repeat(60));
}

main().catch(err => {
  console.error('\n❌ Fatal error:');
  console.error(err);
  process.exit(1);
});
