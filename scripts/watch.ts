/**
 * Obsidian Watch — 위키 파일 변경 감지 자동 재빌드.
 *
 * 워크플로우:
 *   본인이 Obsidian에서 회의록 추가/수정/삭제
 *      ↓ (자동, 5초 디바운스)
 *   1. npm run wiki:build (Obsidian → data/*.json)
 *   2. npm run embed:build -- --all-rag-enabled (변경분만 재임베딩, content_hash 비교)
 *      ↓ (수동 — 안전장치)
 *   git add data/ && git commit -m "wiki sync" && git push
 *      ↓ (자동)
 *   Vercel 배포
 *
 * Usage:
 *   npm run watch
 *
 * 환경변수:
 *   OBSIDIAN_PATH — Obsidian 폴더 경로 (기본 ../Obsidian)
 */

import chokidar from 'chokidar';
import { execSync } from 'child_process';
import path from 'path';
import process from 'process';

try { if (typeof process.loadEnvFile === 'function') process.loadEnvFile('.env.local'); } catch {}

const OBSIDIAN_PATH = process.env.OBSIDIAN_PATH ?? '../Obsidian';
const DEBOUNCE_MS = 5000;

// 감시 패턴: 9개 위키 폴더의 모든 .md 파일
const WATCH_GLOB = `${OBSIDIAN_PATH}/SNU_*_LLM_Wiki/**/*.md`;

let debounceTimer: NodeJS.Timeout | null = null;
const pendingChanges = new Set<string>();
let buildInProgress = false;

const watcher = chokidar.watch(WATCH_GLOB, {
  ignoreInitial: true,                                     // 시작 시 기존 파일 무시
  ignored: [/\.DS_Store/, /\.obsidian\//, /\.trash\//],   // Obsidian 메타 파일 제외
  awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 200 },  // 저장 완료 보장
  persistent: true,
});

watcher.on('all', (event, filepath) => {
  if (buildInProgress) {
    console.log(`⏸️  (build in progress) ${event}: ${path.basename(filepath)}`);
    return;
  }

  pendingChanges.add(filepath);
  const rel = path.relative(OBSIDIAN_PATH, filepath);
  console.log(`📝 [${event.padEnd(6)}] ${rel}`);

  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(rebuild, DEBOUNCE_MS);
});

watcher.on('error', err => {
  console.error('❌ Watcher error:', err);
});

async function rebuild() {
  if (buildInProgress) return;
  buildInProgress = true;

  const count = pendingChanges.size;
  const sample = Array.from(pendingChanges)
    .slice(0, 3)
    .map(f => path.basename(f))
    .join(', ');
  pendingChanges.clear();

  console.log(`\n${'━'.repeat(60)}`);
  console.log(`🔄 Rebuilding (${count} files changed: ${sample}${count > 3 ? '...' : ''})`);
  console.log('━'.repeat(60));

  const startTime = Date.now();
  try {
    console.log('\n[1/2] Building wiki JSON...');
    execSync('npm run wiki:build', { stdio: 'inherit' });

    console.log('\n[2/2] Updating embeddings (incremental)...');
    execSync('npm run embed:build -- --all-rag-enabled', { stdio: 'inherit' });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n${'━'.repeat(60)}`);
    console.log(`✅ Sync complete (${elapsed}s)`);
    console.log('━'.repeat(60));
    console.log(`\n💡 To deploy to production:\n   git add data/ && git commit -m "wiki sync" && git push\n`);
  } catch (err) {
    console.error('\n❌ Build failed. Will retry on next change.');
    console.error(err);
  } finally {
    buildInProgress = false;
  }
}

// 시작 로그
console.log('━'.repeat(60));
console.log('👁️  Obsidian Watch');
console.log('━'.repeat(60));
console.log(`Path:     ${path.resolve(OBSIDIAN_PATH)}`);
console.log(`Glob:     ${WATCH_GLOB}`);
console.log(`Debounce: ${DEBOUNCE_MS}ms`);
console.log(`\nWaiting for file changes... (Ctrl+C to stop)\n`);

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\n👋 Stopping watcher...');
  watcher.close().then(() => process.exit(0));
});
