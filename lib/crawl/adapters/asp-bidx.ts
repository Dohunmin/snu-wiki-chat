// Design Ref: college-grad-wiki §4.3 — asp-bidx 엔진 (ASP CMS, bidx 파라미터)
// /notice/Default.asp?bidx={id} (≠ bbsidx). pidx/htop/ctop은 메뉴 라우팅(글 아님). 정적 SSR.
// 대상: gsiat.
import * as cheerio from 'cheerio';
import type { BoardItem, SelectorConfig } from '../types';
import { BaseAdapter } from '../adapter';

export class AspBidxAdapter extends BaseAdapter {
  key = 'asp-bidx' as const;

  parseBoardList(html: string, boardListUrl: string): BoardItem[] {
    const $ = cheerio.load(html);
    const items: BoardItem[] = [];
    const seen = new Set<string>();
    const findDate = (txt: string) => txt.match(/20\d{2}[.\-/]\s?\d{1,2}[.\-/]\s?\d{1,2}/)?.[0]?.replace(/\s/g, '');
    $('a[href*="bidx="]').each((_, a) => {
      const href = $(a).attr('href') ?? '';
      const id = href.match(/[?&]bidx=(\d+)/)?.[1];
      if (!id || seen.has(id)) return;
      const title = $(a).text().replace(/\s+/g, ' ').trim();
      if (title.length < 2) return;
      seen.add(id);
      let url = href;
      try { url = new URL(href, boardListUrl).href; } catch { /* keep */ }
      items.push({ id, title, date: findDate($(a).closest('tr, li, .list_item').text()), url });
    });
    return items;
  }
}

export function createAspBidx(selectors: SelectorConfig): AspBidxAdapter {
  return new AspBidxAdapter(selectors);
}
