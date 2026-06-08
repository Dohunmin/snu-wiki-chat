// Design Ref: college-grad-wiki §4.3 — gnuboard 엔진 (그누보드 PHP)
// /bbs/board.php?bo_table={board}&wr_id={id}. 정적 SSR. 첨부는 download.php(제외).
// 대상: law.
import * as cheerio from 'cheerio';
import type { BoardItem, SelectorConfig } from '../types';
import { BaseAdapter } from '../adapter';

export class GnuboardAdapter extends BaseAdapter {
  key = 'gnuboard' as const;

  parseBoardList(html: string, boardListUrl: string): BoardItem[] {
    const $ = cheerio.load(html);
    const items: BoardItem[] = [];
    const seen = new Set<string>();
    const findDate = (txt: string) => txt.match(/20\d{2}[.\-/]\s?\d{1,2}[.\-/]\s?\d{1,2}/)?.[0]?.replace(/\s/g, '');
    $('a[href*="wr_id="]').each((_, a) => {
      const href = $(a).attr('href') ?? '';
      if (/download\.php/.test(href)) return; // 첨부 다운로드 링크 제외
      const id = href.match(/wr_id=(\d+)/)?.[1];
      if (!id || seen.has(id)) return;
      const title = $(a).text().replace(/\s+/g, ' ').trim();
      if (title.length < 2) return;
      seen.add(id);
      let url = href;
      try { url = new URL(href, boardListUrl).href; } catch { /* keep */ }
      items.push({ id, title, date: findDate($(a).closest('tr, li, .bo_li, .list_item').text()), url });
    });
    return items;
  }
}

export function createGnuboard(selectors: SelectorConfig): GnuboardAdapter {
  return new GnuboardAdapter(selectors);
}
