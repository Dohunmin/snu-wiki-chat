// Design Ref: college-grad-wiki §4.3 — path-based 엔진 (경로기반 숫자ID 라우팅)
// /content/{slug} 정적 + /board/general/view/{id} 게시판. 대상: music·gsep.
// 정적 정보페이지는 공통 extractMain(밀도기반). parseBoardList는 /view/{id} 또는 /{id}/ 링크 최소 파싱.

import * as cheerio from 'cheerio';
import type { BoardItem, SelectorConfig } from '../types';
import { BaseAdapter } from '../adapter';

export class PathBasedAdapter extends BaseAdapter {
  key = 'path-based' as const;

  parseBoardList(html: string, boardListUrl: string): BoardItem[] {
    const $ = cheerio.load(html);
    const items: BoardItem[] = [];
    $('a[href*="/view/"], a[href*="/notice/"], a[href*="/board/"]').each((_, a) => {
      const href = $(a).attr('href') ?? '';
      const m = href.match(/\/(\d{2,})(?:\/|$|\?)/);
      if (!m) return;
      const title = $(a).text().replace(/\s+/g, ' ').trim();
      if (!title) return;
      let url = href;
      try { url = href.startsWith('http') ? href : new URL(href, boardListUrl).href; } catch { /* keep */ }
      items.push({ id: m[1], title, url });
    });
    return items;
  }
}

export function createPathBased(selectors: SelectorConfig): PathBasedAdapter {
  return new PathBasedAdapter(selectors);
}
