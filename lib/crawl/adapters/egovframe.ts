// Design Ref: college-grad-wiki §4.3 — egovframe 엔진 (전자정부 표준프레임워크)
// *.do?nttId={id} 라우팅. 정적 SSR. 대상: medicine·dent.
// 정적 정보페이지(인사말/연혁/비전/학과/전략)는 공통 extractMain(밀도기반)으로 처리.
// parseBoardList(Tier4)는 nttId 링크/fnView·fnDetail onclick 최소 파싱.

import * as cheerio from 'cheerio';
import type { BoardItem, SelectorConfig } from '../types';
import { BaseAdapter } from '../adapter';

export class EgovframeAdapter extends BaseAdapter {
  key = 'egovframe' as const;

  parseBoardList(html: string, boardListUrl: string): BoardItem[] {
    const $ = cheerio.load(html);
    const items: BoardItem[] = [];
    $('a[href*="nttId="], a[onclick*="fnView"], a[onclick*="fnDetail"], a[onclick*="goView"]').each((_, a) => {
      const $a = $(a);
      const href = $a.attr('href') ?? '';
      const onclick = $a.attr('onclick') ?? '';
      const m = href.match(/nttId=(\d+)/) ?? onclick.match(/'?(\d{2,})'?/);
      if (!m) return;
      const title = $a.text().replace(/\s+/g, ' ').trim();
      if (!title) return;
      items.push({ id: m[1], title, url: boardListUrl });
    });
    return items;
  }
}

export function createEgovframe(selectors: SelectorConfig): EgovframeAdapter {
  return new EgovframeAdapter(selectors);
}
