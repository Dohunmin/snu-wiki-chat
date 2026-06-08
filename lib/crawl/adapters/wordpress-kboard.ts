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

  // kboard 스킨 2종을 모두 처리(실측 2026-06-03):
  //   A) 실제 href: `.board-list li` 안 `?mod=document&uid=N` (social·pharmacy·liberal-college)
  //   B) onclick: `div.subject > a[href="#none" onclick="go_board_view('N')"]` (education·vet·cls·human-ecology)
  // 둘 다 id 기준 dedup. 날짜는 행 텍스트에서 best-effort.
  parseBoardList(html: string, boardListUrl: string): BoardItem[] {
    const $ = cheerio.load(html);
    const items: BoardItem[] = [];
    const seen = new Set<string>();
    const sep = boardListUrl.includes('?') ? '&' : '?';
    const toAbs = (href: string) => { try { return new URL(href, boardListUrl).href; } catch { return href; } };
    const findDate = (txt: string) => txt.match(/20\d{2}[.\-/]\s?\d{1,2}[.\-/]\s?\d{1,2}/)?.[0]?.replace(/\s/g, '');
    const push = (id: string | undefined, rawTitle: string, url: string, date?: string) => {
      if (!id) return;
      const title = rawTitle.replace(/\s+/g, ' ').trim();
      if (!title || seen.has(id)) return;
      seen.add(id);
      items.push({ id, title, date, url });
    };

    // Skin A — 실제 href (uid= / kboard_content_redirect=)
    const rowSel = this.selectors.board?.list_item_selector ?? '.kboard-list tbody tr, ul.kboard-default-list > li, .board-list li';
    $(rowSel).each((_, row) => {
      const $row = $(row);
      const a = $row
        .find('a[href]')
        .filter((_, el) => /[?&]uid=\d+|kboard_content_redirect=\d+|mod=document/.test($(el).attr('href') ?? ''))
        .first();
      const href = a.attr('href') ?? '';
      const id = href.match(/[?&]uid=(\d+)/)?.[1] ?? href.match(/kboard_content_redirect=(\d+)/)?.[1];
      if (!id) return;
      const title = a.text() || $row.find('.kboard-list-title, .subject, .title').text();
      push(id, title, toAbs(href), findDate($row.text()));
    });

    // Skin B — onclick="go_board_view('N')" / kboard_document('N') (href는 보통 #none)
    $('a[onclick*="board_view"], a[onclick*="kboard_document"]').each((_, a) => {
      const $a = $(a);
      const id = ($a.attr('onclick') ?? '').match(/(?:board_view|kboard_document)\(['"]?(\d+)/)?.[1];
      if (!id) return;
      const date = findDate($a.closest('.subject, li, tr, .kboard-list-content').parent().text());
      // go_board_view는 같은 게시판 URL + ?mod=document&uid=N 으로 이동(동일 kboard 엔진)
      push(id, $a.text(), `${boardListUrl}${sep}mod=document&uid=${id}`, date);
    });

    return items;
  }
}

export function createWordpressKboard(selectors: SelectorConfig): WordpressKboardAdapter {
  return new WordpressKboardAdapter(selectors);
}
