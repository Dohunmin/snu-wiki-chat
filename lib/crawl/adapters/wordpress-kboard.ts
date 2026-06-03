// Design Ref: college-grad-wiki §4.3 — wordpress-kboard 엔진
// WordPress + KBoard. 게시글 view 형태가 사이트마다 변종:
//   ?kboard_content_redirect={id}(social) / ?mod=document&uid={id}(vet·pharm·gsph) / 숫자퍼머링크 /{id}/(edu·cls).
// 정적 SSR(콘텐츠). 단 목록의 글링크가 href="#none"(JS) 경우 多 → id는 data-attr/uid에서 best-effort.
// 대상: social·education·human-ecology·fine-arts·vet·pharmacy·gsph·liberal-college·cls·gsct.

import * as cheerio from 'cheerio';
import type { BoardItem, SelectorConfig } from '../types';
import { BaseAdapter } from '../adapter';

export class WordpressKboardAdapter extends BaseAdapter {
  key = 'wordpress-kboard' as const;

  parseBoardList(html: string, boardListUrl: string): BoardItem[] {
    const $ = cheerio.load(html);
    const items: BoardItem[] = [];
    const rowSel = this.selectors.board?.list_item_selector ?? '.kboard-list tbody tr, ul.kboard-list li';
    $(rowSel).each((_, row) => {
      const $row = $(row);
      const a = $row.find('a[href]').first();
      const href = a.attr('href') ?? '';
      // best-effort id: uid= / kboard_content_redirect= / 숫자 퍼머링크 /{id}/
      const id =
        href.match(/[?&]uid=(\d+)/)?.[1] ??
        href.match(/kboard_content_redirect=(\d+)/)?.[1] ??
        href.match(/\/(\d+)\/?$/)?.[1] ??
        $row.attr('data-uid') ??
        $row.find('[data-uid]').first().attr('data-uid');
      if (!id) return;
      const title = a.text().replace(/\s+/g, ' ').trim() || $row.find('.kboard-list-title, .title').text().trim();
      const date = $row.find('.kboard-list-date, .date, td').last().text().trim();
      items.push({ id, title, date, url: href.startsWith('#') ? boardListUrl : href });
    });
    return items;
  }
}

export function createWordpressKboard(selectors: SelectorConfig): WordpressKboardAdapter {
  return new WordpressKboardAdapter(selectors);
}
