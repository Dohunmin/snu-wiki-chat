// Design Ref: college-grad-wiki §4.2 (Crawl CLI) / §5.6 (오케스트레이션)
// 사용법:
//   npx tsx scripts/crawl/index.ts --phase 1                 # Phase1 active 조직 Tier1/2 ingest
//   npx tsx scripts/crawl/index.ts --phase 1 --org eng       # 단일 조직
//   npx tsx scripts/crawl/index.ts --phase 1 --tier 1,2,3    # Tier3(structured_facts)까지 채움
//   npx tsx scripts/crawl/index.ts --phase 1 --tier 4        # Tier4(live_cache) 게시판 갱신만
//   npx tsx scripts/crawl/index.ts --phase 1 --dry-run       # fetch+cleanse만, 미저장
//   npx tsx scripts/crawl/index.ts --phase 1 --build         # 후속 wiki:build (embed는 비용 → 수동/승인)
// ⚠ 실제 크롤은 공개페이지 fetch(무료)이나 외부 네트워크 호출. embed:build(Voyage)는 과금 — 별도 승인.

import { execSync } from 'node:child_process';
import { getActiveOrgs, getOrgById, getOrgsByWiki } from '../../lib/config/orgs';
import type { Org, ParentWiki } from '../../lib/config/orgs';
import type { Tier } from '../../lib/crawl/types';
import { ingestOrg, type IngestResult } from '../../lib/crawl/pipeline';
import { refreshOrgBoards, type RefreshResult } from '../../lib/crawl/board-refresh';
import { regenerateCollegeIndex } from '../../lib/crawl/emit';

interface Args {
  phase: number;
  org?: string;
  wiki?: string;   // parent_wiki 필터(단과대|대학원) — 해당 위키 조직만 크롤
  dryRun: boolean;
  build: boolean;
  tiers: Tier[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = { phase: 1, dryRun: false, build: false, tiers: [1, 2] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--phase') args.phase = Number(argv[++i]);
    else if (a === '--org') args.org = argv[++i];
    else if (a === '--wiki') args.wiki = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--build') args.build = true;
    else if (a === '--tier') {
      args.tiers = argv[++i]
        .split(',')
        .map((t) => Number(t.trim()))
        .filter((t): t is Tier => t === 1 || t === 2 || t === 3 || t === 4);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  let orgs: Org[];
  if (args.org) {
    const o = getOrgById(args.org);
    if (!o) throw new Error(`미등록 조직: ${args.org}`);
    orgs = [o];
  } else if (args.wiki) {
    // ASCII 별칭(PowerShell 한글인자 회피): grad→대학원, college→단과대
    const target = args.wiki === 'grad' ? '대학원' : args.wiki === 'college' ? '단과대' : args.wiki;
    orgs = getActiveOrgs(args.phase).filter((o) => o.parent_wiki === target);
  } else {
    orgs = getActiveOrgs(args.phase);
  }

  const onlyT4 = args.tiers.length === 1 && args.tiers[0] === 4;
  console.log(
    `\n[crawl] phase<=${args.phase} active 조직 ${orgs.length}건` +
      ` · tier ${args.tiers.join(',')}${args.dryRun ? ' (dry-run)' : ''}\n`,
  );

  // ─── Tier4 전용 경로 (게시판 live_cache 갱신) ───────────────────────────────
  if (onlyT4) {
    const settled = await Promise.allSettled(orgs.map((o) => refreshOrgBoards(o, { dryRun: args.dryRun })));
    let totalBoards = 0;
    for (let i = 0; i < settled.length; i++) {
      const s = settled[i];
      if (s.status === 'fulfilled') {
        const r: RefreshResult = s.value;
        const n = r.refreshed.reduce((a, b) => a + b.count, 0);
        totalBoards += r.refreshed.length;
        console.log(
          `  ✓ ${r.org.padEnd(16)} 게시판 ${r.refreshed.map((b) => `${b.board}(${b.count})`).join(' ') || '-'}` +
            (r.skipped.length ? `  스킵 ${r.skipped.length}` : ''),
        );
        for (const sk of r.skipped) console.log(`      ⚠ ${sk.board}: ${sk.reason}`);
      } else {
        console.log(`  ✗ ${orgs[i].id}: ${s.reason}`);
      }
    }
    console.log(`\n[crawl] Tier4 완료 — 게시판 ${totalBoards}건 캐시\n`);
    return;
  }

  const results: IngestResult[] = [];
  // host 간 병렬 (조직별 도메인 상이) — Promise.all. host 내 직렬은 fetcher rate-limit가 보장.
  const settled = await Promise.allSettled(orgs.map((o) => ingestOrg(o.id, { dryRun: args.dryRun, tiers: args.tiers })));
  for (let i = 0; i < settled.length; i++) {
    const s = settled[i];
    if (s.status === 'fulfilled') {
      results.push(s.value);
      const r = s.value;
      console.log(
        `  ✓ ${r.org.padEnd(16)} ${r.adapter.padEnd(18)} 작성 ${r.written.length} / 스킵 ${r.skipped.length}` +
          (r.facts !== undefined ? ` / fact ${r.facts}` : '') +
          (r.note ? `  — ${r.note}` : ''),
      );
      for (const sk of r.skipped) console.log(`      ⚠ ${sk.category}: ${sk.reason}`);
    } else {
      console.log(`  ✗ ${orgs[i].id}: ${s.reason}`);
    }
  }

  const totalWritten = results.reduce((n, r) => n + r.written.length, 0);
  const totalFacts = results.reduce((n, r) => n + (r.facts ?? 0), 0);
  console.log(`\n[crawl] 완료 — 페이지 ${totalWritten}건 작성${args.tiers.includes(3) ? ` · fact ${totalFacts}건` : ''}`);

  // index.md 자동 재생성 — 크롤된 조직의 parent_wiki별 카탈로그 갱신("wiki화" 자동 유지).
  if (!args.dryRun && totalWritten > 0) {
    const parents = [...new Set(orgs.map((o) => o.parent_wiki))] as ParentWiki[];
    for (const pw of parents) {
      const path = regenerateCollegeIndex(pw, getOrgsByWiki(pw));
      console.log(`[crawl] index 갱신: ${path}`);
    }
  }
  console.log('');

  if (args.build && !args.dryRun) {
    console.log('[crawl] wiki:build 실행 (data/*.json 갱신, 무료)...');
    execSync('npm run wiki:build', { stdio: 'inherit' });
    console.log('\n⚠ embed:build(Voyage 임베딩)는 과금 — 예상 비용 보고·승인 후 수동 실행하세요.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
