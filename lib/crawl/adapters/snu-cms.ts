// Design Ref: college-grad-wiki §4.3 — snu-cms 엔진 (SNU 표준 CMS)
// 영문 경로슬러그 + 게시판 ?md=v&bbsidx={id} (변종 ?bm=v=). 정적 SSR.
// 대상: eng·humanities·science·business·nursing·agriculture·gses·mba·grad-general.

import * as cheerio from 'cheerio';
import type { BoardItem, SelectorConfig } from '../types';
import { BaseAdapter } from '../adapter';

export class SnuCmsAdapter extends BaseAdapter {
  key = 'snu-cms' as const;

  parseBoardList(html: string, boardListUrl: string): BoardItem[] {
    const $ = cheerio.load(html);
    const items: BoardItem[] = [];
    const rowSel = this.selectors.board?.list_item_selector ?? 'table tbody tr';
    $(rowSel).each((_, tr) => {
      const $tr = $(tr);
      const href = $tr.find('a[href]').first().attr('href') ?? '';
      // bbsidx={id} 추출 (md=v / bm=v 공통)
      const m = href.match(/bbsidx=(\d+)/);
      const idAttr = this.selectors.board?.id_attr
        ? $tr.find(`[${this.selectors.board.id_attr}]`).first().attr(this.selectors.board.id_attr)
        : undefined;
      const id = m?.[1] ?? idAttr;
      if (!id) return;
      const title = $tr.find('a[href]').first().text().replace(/\s+/g, ' ').trim();
      const date = $tr.find('td').last().text().trim();
      items.push({ id, title, date, url: itemUrl(boardListUrl, id) });
    });
    return items;
  }
}

/** 게시글 URL: 목록 URL + ?md=v&bbsidx={id} (이미 ?가 있으면 & 사용). */
function itemUrl(boardListUrl: string, id: string): string {
  const base = boardListUrl.replace(/[?&]sc=y\b/, '').replace(/\?$/, '');
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}md=v&bbsidx=${id}`;
}

export function createSnuCms(selectors: SelectorConfig): SnuCmsAdapter {
  return new SnuCmsAdapter(selectors);
}
