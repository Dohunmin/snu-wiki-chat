// Design Ref: college-grad-wiki §2.2 / §3.3 / §6 — Tier4 producer (crawl-side, 오프라인 갱신).
// org.urls의 notice/news 게시판 → fetch → adapter.parseBoardList → live_cache upsert.
// 격리(§9.2): 런타임 chat은 live_cache를 읽기만(lib/agents/structured.ts). 라이브 fetch는 여기(오프라인)서만.
//   → 채팅 핫패스에 느린 웹 fetch 없음 + app이 lib/crawl을 import하지 않음. 미스/만료 시 런타임은 Tier1 degrade.

import { db } from '@/lib/db/client';
import { liveCache } from '@/lib/db/schema';
import type { Org } from '../config/orgs';
import type { BoardItem } from './types';
import { getAdapter, isAdapterImplemented } from './adapters';
import { toAbsUrl } from './adapter';
import { fetchHtml } from './fetcher';

export type BoardKind = 'notice' | 'news' | 'research';

/** org.urls(notice/news) → 게시판 목록 URL. board_pattern=null(게시판 빔, dent 사례)이면 제외. */
export function boardTargets(org: Org): { board: BoardKind; url: string }[] {
  if (org.board_pattern === null) return [];
  const out: { board: BoardKind; url: string }[] = [];
  const u = org.urls as Record<string, string | undefined>;
  if (u.notice) out.push({ board: 'notice', url: toAbsUrl(org, u.notice) });
  if (u.news) out.push({ board: 'news', url: toAbsUrl(org, u.news) });
  return out;
}

export interface RefreshResult {
  org: string;
  refreshed: { board: BoardKind; count: number }[];
  skipped: { board: BoardKind; reason: string }[];
}

export interface RefreshOptions {
  ttlHours?: number; // 기본 6
  dryRun?: boolean; // fetch+parse만, 미저장
}

/** 한 조직의 모든 게시판 → live_cache upsert. */
export async function refreshOrgBoards(org: Org, opts: RefreshOptions = {}): Promise<RefreshResult> {
  const result: RefreshResult = { org: org.id, refreshed: [], skipped: [] };
  if (!org.domain) {
    result.skipped.push({ board: 'notice', reason: '도메인 없음' });
    return result;
  }
  if (!isAdapterImplemented(org.adapter_key)) {
    result.skipped.push({ board: 'notice', reason: `어댑터 ${org.adapter_key} 미구현` });
    return result;
  }

  const adapter = getAdapter(org.adapter_key);
  const targets = boardTargets(org);
  if (targets.length === 0) {
    result.skipped.push({ board: 'notice', reason: '게시판 URL 없음(board_pattern=null 또는 urls 미설정)' });
    return result;
  }
  const ttlHours = opts.ttlHours ?? 26;   // 일 2회 크롤(07:00·19:00 KST, 12h 간격) → 26h TTL이라 한 번 누락돼도 신선 유지(마진 14h)
  const relaxTLS = org.tool_blocked === 'tls';

  for (const { board, url } of targets) {
    try {
      const mode = adapter.fetchMode(org, 'board');
      const html = await fetchHtml(url, mode, { relaxTLS });
      const items: BoardItem[] = adapter.parseBoardList(html, url);
      if (items.length === 0) {
        result.skipped.push({ board, reason: '파싱 결과 0건 — selector 점검' });
        continue;
      }
      if (opts.dryRun) {
        result.refreshed.push({ board, count: items.length });
        continue;
      }
      await upsertBoard(org.id, board, items, url, ttlHours);
      result.refreshed.push({ board, count: items.length });
    } catch (e) {
      result.skipped.push({ board, reason: (e as Error).message });
    }
  }
  return result;
}

async function upsertBoard(org: string, board: BoardKind, items: BoardItem[], sourceUrl: string, ttlHours: number): Promise<void> {
  const id = `${org}:${board}`;
  await db
    .insert(liveCache)
    .values({ id, org, board, payload: items, sourceUrl, ttlHours })
    .onConflictDoUpdate({
      target: liveCache.id,
      set: { payload: items, sourceUrl, ttlHours, fetchedAt: new Date() },
    });
}
