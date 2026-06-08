// Design Ref: college-grad-wiki §4.3 — wordpress-custom 엔진 (WP 네이티브 퍼머링크, 비-kboard)
// 글 = 같은 호스트의 단일 세그먼트 퍼머링크(/{slug}/). 숫자 id 없음 → slug를 id로.
// 대상: gsds. (gsis는 go_board_view라 wordpress-kboard로 처리)
import * as cheerio from 'cheerio';
import type { BoardItem, SelectorConfig } from '../types';
import { BaseAdapter } from '../adapter';

// 글이 아닌 흔한 nav 슬러그(단일 세그먼트로 등장 가능) 제외
const NAV_SLUG = /^(about|news|category|integrated|admission|page|wp-[a-z]+|feed|en|kr|home|contact|sitemap|login|search|people|research|academics|notice|board)$/i;

export class WordpressCustomAdapter extends BaseAdapter {
  key = 'wordpress-custom' as const;

  parseBoardList(html: string, boardListUrl: string): BoardItem[] {
    const $ = cheerio.load(html);
    const items: BoardItem[] = [];
    const seen = new Set<string>();
    const findDate = (txt: string) => txt.match(/20\d{2}[.\-/]\s?\d{1,2}[.\-/]\s?\d{1,2}/)?.[0]?.replace(/\s/g, '');
    let host = '';
    let boardSegs = new Set<string>();
    try { const b = new URL(boardListUrl); host = b.host; boardSegs = new Set(b.pathname.split('/').filter(Boolean)); } catch { /* */ }

    $('a[href]').each((_, a) => {
      const href = $(a).attr('href') ?? '';
      let u: URL;
      try { u = new URL(href, boardListUrl); } catch { return; }
      if (u.host !== host) return;
      const segs = u.pathname.split('/').filter(Boolean);
      if (segs.length !== 1) return;            // 단일 세그먼트 퍼머링크(글)만
      const slug = segs[0];
      if (boardSegs.has(slug) || NAV_SLUG.test(slug)) return;
      const title = $(a).text().replace(/\s+/g, ' ').trim();
      if (title.length < 8) return;             // 제목스러운 것만
      const id = decodeURIComponent(slug);
      if (seen.has(id)) return;
      seen.add(id);
      items.push({ id, title, date: findDate($(a).closest('li, article, .item, .post').text()), url: u.href });
    });
    return items;
  }
}

export function createWordpressCustom(selectors: SelectorConfig): WordpressCustomAdapter {
  return new WordpressCustomAdapter(selectors);
}
