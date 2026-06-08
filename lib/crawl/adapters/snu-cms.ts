// Design Ref: college-grad-wiki §4.3 — snu-cms 엔진 (SNU 표준 CMS)
// 영문 경로슬러그 + 게시판 ?md=v&bbsidx={id} (변종 ?bm=v=). 정적 SSR.
// 대상: eng·humanities·science·business·nursing·agriculture·gses·mba·grad-general.

import * as cheerio from 'cheerio';
import type { BoardItem, SelectorConfig } from '../types';
import { BaseAdapter } from '../adapter';

export class SnuCmsAdapter extends BaseAdapter {
  key = 'snu-cms' as const;

  // SNU 표준 CMS 게시판의 변종을 모두 처리(실측 2026-06-03):
  //   A) bbsidx= 링크(table 행/카드 무관) — 행 첫 앵커가 썸네일·태그여도 누락 안 됨(agriculture·business)
  //   B) /newsroom/view/{c}/{s}/{id} 경로형 뉴스룸(science)
  //   C) bbsidx 없는 레거시는 id_attr 행기반 fallback
  parseBoardList(html: string, boardListUrl: string): BoardItem[] {
    const $ = cheerio.load(html);
    const items: BoardItem[] = [];
    const seen = new Set<string>();
    const findDate = (txt: string) => txt.match(/20\d{2}[.\-/]\s?\d{1,2}[.\-/]\s?\d{1,2}/)?.[0]?.replace(/\s/g, '');
    const add = (id: string | undefined, rawTitle: string, url: string, date?: string) => {
      if (!id || seen.has(id)) return;
      const title = rawTitle.replace(/\s+/g, ' ').trim();
      if (title.length < 2) return; // 아이콘·더보기 제외
      seen.add(id);
      items.push({ id, title, date, url });
    };

    // A) bbsidx 게시판
    $('a[href*="bbsidx="]').each((_, a) => {
      const $a = $(a);
      const id = ($a.attr('href') ?? '').match(/bbsidx=(\d+)/)?.[1];
      add(id, $a.text(), itemUrl(boardListUrl, id ?? ''), findDate($a.closest('tr, li, article, .item').text()));
    });

    // B) /newsroom/view/.../{id} 경로형(science)
    $('a[href*="/newsroom/view/"]').each((_, a) => {
      const $a = $(a);
      const href = $a.attr('href') ?? '';
      const id = href.match(/\/(\d+)\/?(?:[?#]|$)/)?.[1];
      let url = href;
      try { url = href.startsWith('http') ? href : new URL(href, boardListUrl).href; } catch { /* keep */ }
      add(id, $a.text(), url, findDate($a.closest('article, li, .item').text()));
    });

    // C) fallback: bbsidx·newsroom 모두 없을 때 id_attr 행기반
    if (items.length === 0) {
      const rowSel = this.selectors.board?.list_item_selector ?? 'table tbody tr';
      $(rowSel).each((_, tr) => {
        const $tr = $(tr);
        const idAttr = this.selectors.board?.id_attr
          ? $tr.find(`[${this.selectors.board.id_attr}]`).first().attr(this.selectors.board.id_attr)
          : undefined;
        if (!idAttr) return;
        add(idAttr, $tr.find('a[href]').first().text(), itemUrl(boardListUrl, idAttr), $tr.find('td').last().text().trim());
      });
    }
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
