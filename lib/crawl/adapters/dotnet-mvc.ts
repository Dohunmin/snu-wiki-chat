// Design Ref: college-grad-wiki §4.3 — dotnet-mvc 엔진 (.NET MVC + AngularJS SPA)
// 게시판이 ng-repeat 클라이언트 렌더(EUC-KR). 단, 렌더된 HTML/스크립트에 목록 데이터가
//   JSON으로 들어있음: {"Idx":N,...,"Title":"...","RegDate":"YYYY-MM-DD ..."}.
//   → render=dynamic(playwright)로 가져온 HTML에서 JSON 추출. view=/kr/Board/Detail/{type}/{Idx}.
// 대상: gspa.
import type { BoardItem, MainContent, SelectorConfig } from '../types';
import { BaseAdapter } from '../adapter';

export class DotnetMvcAdapter extends BaseAdapter {
  key = 'dotnet-mvc' as const;

  // gspa 전 페이지 끝에 CCTV 영상정보처리기기 방침 보일러플레이트가 렌더됨 → 절단.
  //   상단 "전체메뉴보기…닫기" 메뉴 토글 잔재도 제거.
  extractMain(html: string, url: string): MainContent {
    const m = super.extractMain(html, url);
    let md = m.markdown.replace(/^전체메뉴보기.*?닫기\s*/m, '').trim();
    const cut = md.search(/본교는 개인정보보호법 제25조|영상정보처리기기 운영·관리 방침|영상정보처리기기를 설치·운영/);
    if (cut > 0) md = md.slice(0, cut).trim();
    return { ...m, markdown: md, charCount: md.replace(/\s+/g, '').length };
  }

  parseBoardList(html: string, boardListUrl: string): BoardItem[] {
    const type = boardListUrl.match(/\/List\/([^/?#]+)/)?.[1] ?? 'Notice';
    let origin = '';
    try { origin = new URL(boardListUrl).origin; } catch { /* */ }
    const items: BoardItem[] = [];
    const seen = new Set<string>();
    // 한 객체 내 Idx … Title … RegDate (목록 데이터는 Content:"" 라 중괄호 미포함 → [^{}] 안전)
    const re = /"Idx":(\d+)[^{}]*?"Title":"((?:[^"\\]|\\.)*?)"[^{}]*?"RegDate":"([^"]*?)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      const id = m[1];
      if (seen.has(id)) continue;
      seen.add(id);
      const title = m[2].replace(/\\"/g, '"').replace(/\\\//g, '/').replace(/\s+/g, ' ').trim();
      if (!title) continue;
      const date = (m[3] || '').slice(0, 10);
      items.push({ id, title, date, url: `${origin}/kr/Board/Detail/${type}/${id}` });
    }
    return items;
  }
}

export function createDotnetMvc(selectors: SelectorConfig): DotnetMvcAdapter {
  return new DotnetMvcAdapter(selectors);
}
