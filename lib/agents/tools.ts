/**
 * Agent 도구 레이어 (middle-path 1안) — 모델이 *고르는* 진짜 도구.
 *
 * 기존 파이프라인은 LLM 호출 *전에* routeQuery+getContext가 컨텍스트를 강제 주입했다(모델 agency 0).
 * 여기서는 내부 위키 검색을 모델이 호출하는 `search_wiki` 도구로 노출 → 모델이 "내부를 검색할지/
 * 무엇을 검색할지"를 스스로 결정. web_search(외부)와 동급 도구로 나란히 둬, 오케스트레이터가
 * 내부↔외부를 goal에 맞춰 고르게 한다.
 *
 * ⚠️ Phase A(스캐폴드): 정의·핸들러만. route.ts 연결은 Phase B(플래그 뒤). 현행 동작 불변.
 * 가드 보존: sensitive 필터는 routeQuery→getContext 내부(role 기반)에 그대로 → 도구레벨 강제.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { Role } from '@/lib/auth/roles';
import { routeQuery } from '@/lib/agents/router';
import { enforceContextBudget } from '@/lib/agents/context-budget';
import type { QueryPlan } from '@/lib/agents/agent-router';
import { CitationRegistry } from '@/lib/llm/citations';

/** Anthropic tool 스키마 — 모델이 내부 위키를 검색하는 도구. */
export const SEARCH_WIKI_TOOL: Anthropic.Tool = {
  name: 'search_wiki',
  description:
    '서울대 거버넌스·단과대·대학원 내부 위키를 검색해 관련 자료를 반환한다. ' +
    '각 자료 블록 헤더의 [N]은 인용 번호이며, 답변에서 출처를 밝힐 때 그 [N]만 사용한다. ' +
    '내부 자료로 답할 수 있는 질문이면 외부 검색보다 먼저 이 도구를 쓴다. ' +
    '서로 다른 측면이면 질의를 바꿔 여러 번 호출해도 된다.',
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: '검색할 질문 또는 핵심 키워드. 직전 맥락에 의존하지 않는 완결된 질문일수록 정확하다.',
      },
    },
    required: ['query'],
  },
};

/** search_wiki 1회 실행에 필요한 호출측 컨텍스트(권한·예산·누적 인용기). route.ts가 클로저로 주입. */
export interface SearchWikiContext {
  role: Role;
  /** 인용 번호 누적기 — 여러 search_wiki 호출에 걸쳐 [N] 연속 부여. */
  registry: CitationRegistry;
  /** 라우팅 힌트(단과대 breadth/recency 등). pre-check가 산출(없으면 undefined). */
  plan?: QueryPlan;
  /** 이 호출의 컨텍스트 char 예산(보편 예산 — 비용 캡). */
  budgetChars: number;
}

/**
 * search_wiki 핸들러 — routeQuery+예산+인용 누적을 감싼다.
 *   tool_result로 돌려줄 markdown(헤더에 [N] 주입됨)을 반환. 매칭 0이면 명시 문자열.
 *   registry는 호출 간 상태를 유지하므로 같은 source는 같은 [N]으로 dedup된다.
 */
export async function runSearchWiki(
  args: { query: string },
  ctx: SearchWikiContext,
): Promise<string> {
  const query = (args.query ?? '').trim();
  if (!query) return '검색어가 비어 있습니다.';

  const routing = await routeQuery(query, ctx.role, ctx.plan);
  const budgeted = await enforceContextBudget(query, routing.contexts, ctx.budgetChars);
  if (budgeted.length === 0) {
    return `내부 위키에서 "${query}" 관련 자료를 찾지 못했습니다.`;
  }
  // addOnlyNew: 이미 제공된(seed·이전 검색) source는 빼고 *새 자료*만 반환 → 겹침 재전송 차단(비용·과검색 방지).
  const md = ctx.registry.addOnlyNew(budgeted);
  if (!md) {
    return `"${query}"에 대한 추가 내부 자료가 없습니다 — 관련 자료는 이미 위에 제공되어 있습니다. ` +
      `더 검색하지 말고, 외부 정보가 필요하면 web_search를, 충분하면 그대로 답변하세요.`;
  }
  return md;
}
