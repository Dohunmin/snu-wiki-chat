import { NextRequest } from 'next/server';
import type Anthropic from '@anthropic-ai/sdk';
import { auth } from '@/lib/auth/config';
import { canChat, canUseLens } from '@/lib/auth/roles';
import type { Role } from '@/lib/auth/roles';
import { routeQuery } from '@/lib/agents/router';
import { getBackgroundContexts } from '@/lib/agents/background';
import { routeToAgent, planQuery, type AgentIntent, type QueryPlan } from '@/lib/agents/agent-router';
import { enforceContextBudget } from '@/lib/agents/context-budget';
import { complexityBudget, budgetForComplexity } from '@/lib/agents/complexity';
import { getStructuredFact, getLiveBoard, type DirectAnswer } from '@/lib/agents/structured';
import { loadPersonaContext, personaToContext, canonicalToContext } from '@/lib/agents/lens';
import { SEARCH_WIKI_TOOL, runSearchWiki } from '@/lib/agents/tools';
import {
  buildSystemPromptParts,
  buildUserMessage,
  buildLensSystemPrompt,
  buildLensUserMessage,
  buildPolicySystemPrompt,
  buildAgentLoopSystemPrompt,
  buildAgentLoopUserMessage,
} from '@/lib/llm/prompts';
import { selectRecentHistory, type ChatTurn } from '@/lib/llm/memory';
import {
  buildNumberedContexts,
  CitationRegistry,
  resolveText,
  extractCitedNumbers,
  resolveCitations,
  safeFlushPoint,
  detectOldFormatCitations,
  buildOldFormatRetryPrompt,
} from '@/lib/llm/citations';
import { validateTables, buildTableFixPrompt } from '@/lib/llm/table-audit';
import { getAnthropicClient, LLM_MODEL, MAX_TOKENS } from '@/lib/llm/client';
import {
  WEB_SEARCH_TOOL_POLICY,
  WEB_SEARCH_GUIDANCE_POLICY,
  WEB_SEARCH_GUIDANCE_FACT,
  webSearchGuidanceLens,
  renderWebSources,
} from '@/lib/llm/web-search';
import { logQuestionToSheet } from '@/lib/google-sheets';
import { db } from '@/lib/db/client';
import { conversations, messages, users } from '@/lib/db/schema';
import { eq, asc } from 'drizzle-orm';
import { z } from 'zod';

const chatSchema = z.object({
  message: z.string().min(1).max(2000),
  conversationId: z.string().optional(),
  mode: z.string().regex(/^(normal|policy|lens:[a-z0-9-]+)$/).default('normal'),
});

// web_search 도구·모드별 가이드·외부 출처 렌더는 lib/llm/web-search.ts로 추출(실측 하니스가 동일 프롬프트 import).
//   Case B 수정(2026-06-29): admin/tier1 fact·policy에서 "내부에 없음 → 검색"(P5보다 우선) 강제 + 안티패턴 가드.

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return Response.json({ error: '로그인이 필요합니다.' }, { status: 401 });
  }

  const role = session.user.role as Role;
  if (!canChat(role)) {
    return Response.json({ error: '채팅 권한이 없습니다.' }, { status: 403 });
  }

  const body = await req.json();
  const parsed = chatSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: '질문 형식이 올바르지 않습니다.' }, { status: 400 });
  }

  const { message, conversationId, mode: requestedMode } = parsed.data;
  const userId = session.user.id;

  // lens 모드 — admin + tier1 (사용자가 명시적으로 고른 모드 → 라우터 우회). tier2·pending 차단.
  if (requestedMode.startsWith('lens:') && !canUseLens(role)) {
    return Response.json({ error: '접근 권한이 없습니다.' }, { status: 403 });
  }
  // 명시적 policy 요청 — admin + tier1만. (라우터 자동승급은 아래에서 role을 다시 확인하므로 무관)
  if (requestedMode === 'policy' && role !== 'admin' && role !== 'tier1') {
    return Response.json({ error: '접근 권한이 없습니다.' }, { status: 403 });
  }

  // Design Ref: §2.2 — conversationId ownership 검증 (보안 floor).
  // 정상 흐름에선 클라 자동 readOnly가 미리 차단하므로 여기 도달 X.
  // Dev tools / 직접 fetch 우회 시에만 발동.
  if (conversationId) {
    const [conv] = await db
      .select({ userId: conversations.userId })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);
    if (!conv) {
      return Response.json({ error: '대화를 찾을 수 없습니다.' }, { status: 404 });
    }
    if (conv.userId !== userId) {
      return Response.json({ error: '본인 대화에만 메시지를 보낼 수 있습니다.' }, { status: 403 });
    }
  }

  try {
    await ensureUserExists(userId, session.user.name, role);
  } catch (err) {
    console.error('Failed to ensure chat user exists', err);
    return Response.json({ error: '사용자 정보를 준비하지 못했습니다.' }, { status: 500 });
  }

  // ── 후속질문 맥락 해소: 직전 턴 1회 로드(분류·검색·이력 일관 구동). ──────────────────────
  //   현재 user 메시지는 아직 미저장(아래 line ~260) → slice 불필요. 첫 턴(convId 없음)은 skip.
  //   이 한 번의 로드를 planQuery(맥락 해소)·답변 LLM 이력이 공유 → DB 중복쿼리·휴리스틱 제거.
  let recentTurns: ChatTurn[] = [];
  if (conversationId) {
    const prev = await db
      .select({ role: messages.role, content: messages.content })
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(asc(messages.createdAt));
    recentTurns = prev.filter(
      (m): m is ChatTurn => m.role === 'user' || m.role === 'assistant',
    );
  }

  // ── 상위 라우터 (multi-agent §5 Phase 3): 질문 의도 분류 → effective mode 결정 ──────────
  //   UI 토글 없음 → 클라는 항상 mode='normal' 전송. Haiku 라우터가 질문을 fact/insight로
  //   분류해 'normal'일 때만 실질 모드를 정한다. lens·명시적 policy는 사용자가 직접 고른 것 → 우회.
  //   권한 게이트: insight(=policy 파이프)는 admin·tier1만. tier2·pending은 insight 의도여도 fact.
  //   비용: 라우터 = Haiku ~$0.001/질문(짧은 분류). 실패 시 내부적으로 키워드 fallback(무료).
  let mode = requestedMode;
  let routerIntent: AgentIntent | null = null;
  let queryPlan: QueryPlan | null = null;
  // agent-loop(middle-path 1안): 플래그 ON + normal 요청이면 도구기반 루프 경로. OFF면 현행과 byte-identical.
  //   loopMode면 fact/insight 분기(→policy 승급) 건너뜀 — 루프가 통합 처리(분류기 휴리스틱 제거 방향).
  //   lens·명시 policy 요청은 사용자가 직접 고른 것 → 레거시 유지.
  const loopMode = process.env.AGENT_LOOP_ENABLED === 'true' && requestedMode === 'normal';
  // unified-intent-router: 기본 ON(planQuery 통합 라우터 라이브 소비) — shadow 검증(실질의로그 121건) 통과 후 활성화.
  //   비상 복구: INTENT_PLAN_ENABLED=false 설정 시 기존 routeToAgent로 즉시 복귀(재배포 불필요).
  const usePlan = process.env.INTENT_PLAN_ENABLED !== 'false';
  if (requestedMode === 'normal') {
    const canInsight = role === 'admin' || role === 'tier1';
    if (usePlan) {
      queryPlan = await planQuery(message, recentTurns.slice(-6));   // 직전 3교환으로 맥락 해소
      routerIntent = queryPlan.intent;
      // loopMode면 mode를 normal로 유지(루프가 외부reach·분석 깊이를 자기판단). webEnabled은 role로만 결정.
      if (queryPlan.intent === 'insight' && canInsight && !loopMode) mode = 'policy';
      console.log(
        `[plan] intent=${queryPlan.intent} cx=${queryPlan.complexity} rec=${queryPlan.recency} ` +
        `cb=${queryPlan.collegeBreadth} ca=${queryPlan.collegeAggregate} via=${queryPlan.via} ` +
        `role=${role} loop=${loopMode} → mode=${mode} | ${queryPlan.reason}`,
      );
    } else {
      const decision = await routeToAgent(message);
      routerIntent = decision.agent;
      if (decision.agent === 'insight' && canInsight && !loopMode) mode = 'policy';
      console.log(
        `[router] intent=${decision.agent} via=${decision.via} role=${role} loop=${loopMode} ` +
        `→ mode=${mode} | ${decision.reason}`,
      );
    }
  }

  // C안(가드된 agentic): 웹 도달 = insight(policy) + admin/tier1의 fact까지. tier2·lens·pending fact는 미도달(신뢰·격리 floor).
  //   fact 웹은 "내부로 답 안 될 때만" 모델이 자기판단 — 외부 reach를 상단 분류기가 아닌 답변 agent가 결정.
  //   lens도 포함: 실명 인물 시각이 외부 동향(해외 사례 등)과 합성될 수 있게 — 단 오귀속 가드(webSearchGuidanceLens) 필수.
  //   lens는 이미 admin·tier1 게이트(canUseLens)라 role 조건 자동 충족. tier2·pending은 애초 lens 미도달.
  const webEnabled =
    mode === 'policy' ||
    ((mode === 'normal' || mode.startsWith('lens:')) && (role === 'admin' || role === 'tier1'));

  let routing;
  let systemPrompt: string | Anthropic.TextBlockParam[];
  let userMessage;
  let citationMapping: Map<number, { wiki: string; page: string; topic?: string }>;
  let citationSummary: string;
  let lensPersonaInfo: { id: string; displayName: string; insufficient: boolean } | undefined;
  let convId = conversationId;
  // agent-loop: 누적 인용기 + 예산을 스트리밍 클로저까지 노출(loopMode 도구 디스패치가 사용).
  let citationRegistry: CitationRegistry | null = null;
  let budgetChars = 0;
  // 후속질문이면 라우터가 푼 독립형 질문으로 검색·예산 산정(맥락 정조준). 독립질문이면 원문과 동일.
  //   사용자에게 보이는 질문·DB 저장·답변 LLM 입력은 원문(message) 유지 — resolvedQuery는 내부 검색/분류용.
  const effectiveQuery = queryPlan?.resolvedQuery || message;

  try {
    routing = await routeQuery(effectiveQuery, role, usePlan ? (queryPlan ?? undefined) : undefined);

    // Design Ref: §4.1 I-9 — AnswerClass 3/4 직답 분기 (college-grad-wiki).
    //   governance 쿼리는 routing.answerClass === undefined → 이 블록 통째로 skip → 아래 일반 RAG와 byte-identical.
    //   AC3 적중: structured_facts 1레코드 → LLM 0토큰. AC4 적중: live_cache 게시판 리스트.
    //   미스/TTL 만료(direct === null) → fall through → 일반 RAG(AnswerClass 1 degrade).
    //   ⚠️ answerClass(1~4)=답변 방식 분류, 권한 tier1/tier2와 무관.
    if ((routing.answerClass === 3 || routing.answerClass === 4) && routing.college) {
      const direct =
        routing.answerClass === 3
          ? await getStructuredFact(routing.college, message)
          : await getLiveBoard(routing.college, message);
      if (direct) {
        return streamDirectAnswer({
          direct,
          message,
          conversationId,
          userId,
          mode,
          selectedAgentIds: routing.selectedAgentIds,
          agentNames: routing.contexts.map((c) => c.agentName),
          userName: session.user.name ?? '',
          userEmail: session.user.email ?? '',
          role,
        });
      }
    }

    // 외부 담론 배경(edu-trends 등) — 의미유사도 게이트 통과 시에만 주입.
    //   routeQuery는 배경 소스를 제외하므로(getRoutableAgents), 여기서만 들어온다.
    //   실측: keyword 라우팅은 on-topic을 자주 놓침(4중 1) → 임베딩 게이트가 신뢰 가능한 발동 판단.
    //   외부 라벨·만능 아님 가드는 background.ts가 본문 상단 마커로 부착. 토큰은 chunkCap으로 고정.
    const backgroundContexts = await getBackgroundContexts(effectiveQuery, role);
    if (backgroundContexts.length > 0) {
      routing.contexts = [...routing.contexts, ...backgroundContexts];
    }

    // 보편 컨텍스트 예산 — 모든 경로 합류점에서 총량 캡(비용 꼬리 차단) + 질문 복잡도별 예산.
    //   단순 factoid=작은 예산(저렴), 종합형=큰 예산(OLD급 품질). 실측 75% 단순 → 평균↓ + 깊은 품질 보존.
    //   CONTEXT_BUDGET_CHARS 설정 시 고정값으로 override(실험용).
    budgetChars = process.env.CONTEXT_BUDGET_CHARS
      ? Number(process.env.CONTEXT_BUDGET_CHARS)
      : (usePlan && queryPlan ? budgetForComplexity(queryPlan.complexity) : complexityBudget(message));
    const budgetedContexts = await enforceContextBudget(effectiveQuery, routing.contexts, budgetChars);

    // 번호 인용 매핑 구축 — LLM이 [N]만 사용하도록
    const numbered = buildNumberedContexts(budgetedContexts);
    citationMapping = numbered.mapping;
    citationSummary = numbered.summary;

    if (loopMode) {
      // agent-loop: 상단 routeQuery 결과를 registry에 seed(첫 왕복 절약) — 모델은 부족하면 도구로 추가 검색.
      //   인용 [N]은 이 registry가 도구호출에 걸쳐 누적. citationMapping은 같은 Map 참조(스트리밍 중 grow).
      citationRegistry = new CitationRegistry();
      const seedMarkdown = citationRegistry.add(budgetedContexts);
      citationMapping = citationRegistry.mapping;
      citationSummary = citationRegistry.summary;
      // 캐싱(A): 루프는 매 iter가 누적 대화를 재전송 → 시스템(고정)에 cache_control로 재읽기 10% 단가.
      systemPrompt = [{ type: 'text', text: buildAgentLoopSystemPrompt(role, { webEnabled }), cache_control: { type: 'ephemeral' } }];
      userMessage = buildAgentLoopUserMessage(message, seedMarkdown, citationRegistry.summary);
    } else if (mode.startsWith('lens:')) {
      const personaId = mode.slice(5);
      const persona = await loadPersonaContext(personaId, message, role);
      if (!persona) {
        return Response.json({ error: '존재하지 않는 페르소나입니다.' }, { status: 400 });
      }
      // stance도 [N] 번호 인용 네임스페이스에 포함 → 입장 인용이 클릭 가능한 출처가 됨(budgetedContexts와 동일 처리).
      // Canonical 레이어(L0): 공약 등 canonical source를 컨텍스트 *최상단*에 pin → 답변의 1차 조직 프레임.
      //   순서 = [canonical(L0), ...중립위키, persona stance(L1)]. canonical이 먼저라 낮은 [N]+상단 배치.
      //   ⚠️ 프레임이지 필터 아님 — 비매칭 축 stance도 그대로 활용(buildLensSystemPrompt 지침).
      const canonicalCtx = canonicalToContext(persona);
      const stanceCtx = personaToContext(persona);
      const lensContexts = [
        ...(canonicalCtx ? [canonicalCtx] : []),
        ...budgetedContexts,
        ...(stanceCtx ? [stanceCtx] : []),
      ];
      const lensNumbered = (canonicalCtx || stanceCtx)
        ? buildNumberedContexts(lensContexts)
        : numbered;
      citationMapping = lensNumbered.mapping;
      citationSummary = lensNumbered.summary;
      // webEnabled(admin·tier1)면 lens도 외부 보강 가능 — 단 오귀속 가드 부착(웹≠그의 입장).
      systemPrompt = buildLensSystemPrompt(budgetedContexts, persona, role)
        + (webEnabled ? webSearchGuidanceLens(persona.name) : '');
      userMessage = buildLensUserMessage(message, lensNumbered.contextMarkdown, lensNumbered.summary, persona);
      lensPersonaInfo = {
        id: persona.id,
        displayName: persona.displayName,
        insufficient: persona.insufficient,
      };
    } else if (mode === 'policy') {
      // 공약설계 — fact 프롬프트 + 공약 레이어. 외부지식은 web_search(max 2) 경유로 [제목](URL) 인용.
      systemPrompt = buildPolicySystemPrompt(budgetedContexts, role) + WEB_SEARCH_GUIDANCE_POLICY;
      userMessage = buildUserMessage(message, numbered.contextMarkdown, numbered.summary);
    } else {
      // Design Ref: rag-cost-reduction §2 M1b — 안정 system prefix에 prompt caching 적용.
      //   stable(고정 P0~P6 + 가이드)에 cache_control 부여 → 재시도/멀티턴/동시질의서 입력단가 ~1/10.
      //   tail(agentList·tier2 경고)은 가변이라 캐시 밖. lens 모드는 회귀위험 커 현재 미적용(후속).
      //   본문(userMessage) 캐싱은 적중률 실측(M0c [chat-usage] cacheR/cacheW) 후 결정.
      const parts = buildSystemPromptParts(budgetedContexts, role);
      systemPrompt = [
        { type: 'text', text: parts.stable, cache_control: { type: 'ephemeral' } },
        // admin/tier1 fact: 가드된 웹 자기판단 부착(C안). tier2 fact: 내부 KB 전용(웹 가이드 없음).
        { type: 'text', text: webEnabled ? parts.tail + WEB_SEARCH_GUIDANCE_FACT : parts.tail },
      ];
      userMessage = buildUserMessage(message, numbered.contextMarkdown, numbered.summary);
    }

    if (!convId) {
      convId = crypto.randomUUID();
      await db.insert(conversations).values({
        id: convId,
        userId,
        title: message.slice(0, 50),
      });
    }

    await db.insert(messages).values({
      id: crypto.randomUUID(),
      conversationId: convId,
      role: 'user',
      content: message,
      routedAgents: routing.selectedAgentIds,
      sources: null,
      mode,
    });

    // 대화 목록 정렬키 = 마지막 활동(updatedAt). 후속질문도 부모 대화를 상위로 올리려면
    //   매 턴 시작(user 메시지) 시 bump해야 함 — 안 그러면 생성시각에 고정돼 활동중 대화가 안 올라옴.
    //   신규 대화는 방금 생성한 defaultNow와 동일값(무해). 정렬 쿼리는 desc(updatedAt).
    await db.update(conversations).set({ updatedAt: new Date() }).where(eq(conversations.id, convId));

  } catch (err) {
    console.error('Failed to prepare chat response', err);
    return Response.json({ error: '대화를 저장하거나 자료를 찾는 중 오류가 발생했습니다.' }, { status: 500 });
  }

  // ── 중지(abort) 전파 ─────────────────────────────────────────────────────
  //   문제: 클라가 fetch를 abort해도 req.signal은 *스트리밍 응답 도중* 신뢰성 있게 발동하지 않음
  //   (특히 dev/Vercel). 그래서 기존 `req.signal?.aborted` break 체크가 한 번도 안 걸려
  //   서버가 끝까지 생성 → 전체 답변 DB 저장 → output 토큰 풀 청구(=중지가 무의미)였음.
  //   해결: ReadableStream.cancel()(소비자=HTTP 파이프 절단 시 확실히 호출)을 1차 트리거로,
  //   req.signal을 2차로 두고, 통합 신호(abortController)를 **Anthropic SDK 요청에 직접 전파**한다.
  //   → 클라 중지 시 Anthropic 생성이 실제로 끊겨 output 청구가 그 지점에서 멈춘다.
  //   ⚠️ input 토큰은 요청 송신 시점에 이미 확정(환불 불가) — 절감 대상은 미생성 output뿐.
  const abortController = new AbortController();
  if (req.signal) {
    if (req.signal.aborted) abortController.abort();
    else req.signal.addEventListener('abort', () => abortController.abort());
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (data: object) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          // 클라이언트 연결 끊김 — 이후 송신 중단
          closed = true;
        }
      };

      // catch에서 부분 응답 저장에 쓰이므로 try 밖에 선언(스코프 노출)
      let fullContentRaw = '';   // LLM 원본 ([N] 포함)
      let buffer = '';            // 스트리밍 중 [N] 버퍼

      try {
        send({
          type: 'routing',
          agents: routing.selectedAgentIds,
          agentNames: routing.contexts.map(c => c.agentName),
          conversationId: convId,
          lensPersona: lensPersonaInfo,
          mode,                    // effective 모드(normal|policy|lens:xxx) — UI 배지용
          intent: routerIntent,    // 상위 라우터 분류(fact|insight|null) — UI 표시 후속 훅
        });

        const client = getAnthropicClient();

        // 직전 5교환(최대 10개 메시지) 전문 포함 — **plan.isFollowup일 때만**(독립 질문은 생략, 토큰 절감).
        //   후속 판정은 라우터(planQuery)가 직전 맥락을 보고 내림 → followupRe/매직넘버 휴리스틱 폐기.
        //   recentTurns는 상단에서 1회 로드(현재 user 메시지 미저장 시점) → slice(0,-1) 불필요. DB 재쿼리 제거.
        type AnthropicMessage = { role: 'user' | 'assistant'; content: string };
        const history: AnthropicMessage[] = [];
        const isFollowup = queryPlan
          ? queryPlan.isFollowup
          : recentTurns.length > 0 && [...message.trim()].length <= 20;   // !usePlan 롤백 경로 보수적 fallback
        // 공약설계(policy)는 토론 모드 → 후속 여부와 무관하게 항상 직전 맥락 로드 (Design: memory.ts/FR6).
        const isPolicyDebate = mode === 'policy';
        if ((isFollowup || isPolicyDebate) && recentTurns.length > 0) {
          // policy: 넓은 창(8교환)+char 예산(12k)으로 토론 연속성. normal/lens: 직전 5교환.
          const selected = isPolicyDebate
            ? selectRecentHistory(recentTurns, { maxMessages: 16, maxChars: 12000 })
            : recentTurns.slice(-10);
          const turns = selected.slice();
          while (turns.length && turns[0].role !== 'user') turns.shift();   // 선두 assistant 제거(Anthropic: 첫 메시지 user)
          for (const m of turns) history.push({ role: m.role, content: m.content });
        }

        // ── 스트리밍 (+ agent-loop 도구 디스패치) ───────────────────────────────
        // 레거시(loopMode=false): 단일 스트림(MAX_ITERS=1, 도구 미부착/웹만).
        // loopMode=true: search_wiki(client tool)를 stop_reason='tool_use' 때 실행→결과 주입→재스트림.
        //   마지막 iter엔 search_wiki 제거 → 모델이 반드시 답변(도구 무한루프 방지). 인용 [N]은 공유 registry가 누적.
        // web_search는 server tool — 스트림 내부에서 자동 실행되어 segment를 멈추지 않음(stop_reason!=='tool_use').
        let stopReason: string | null = null;
        const streamUsage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; webSearches?: number } = {};
        const webCitations: { url: string; title: string }[] = [];   // web_search 인용 메타 누적 → 본문 끝 출처 블록

        const webTools = webEnabled ? [WEB_SEARCH_TOOL_POLICY] : [];
        const MAX_ITERS = loopMode ? 4 : 1;
        const MAX_SEARCH_WIKI = 3;   // 총 search_wiki 호출 캡(anti-runaway). 실제 비용절감은 addOnlyNew dedup이 담당.
        let searchWikiCount = 0;
        const convo: Anthropic.MessageParam[] = [...history, { role: 'user', content: userMessage }];

        // 캐싱(A) 롤링 브레이크포인트: 매 호출 직전 *마지막 메시지의 마지막 블록*에 cache_control →
        //   누적 대화(seed+이전 tool_result)가 통째로 캐시 prefix가 됨(다음 호출서 10% 재읽기).
        //   이전 마커는 제거해 항상 system(1)+rolling(1)=2개 유지(4개 한도 내). loopMode 전용.
        let prevRollingBlock: Record<string, unknown> | null = null;
        const markRollingCache = () => {
          if (prevRollingBlock) { delete prevRollingBlock.cache_control; prevRollingBlock = null; }
          const last = convo[convo.length - 1];
          if (!last) return;
          if (typeof last.content === 'string') last.content = [{ type: 'text', text: last.content }];
          const blocks = last.content as unknown as Array<Record<string, unknown>>;
          const lb = blocks[blocks.length - 1];
          if (lb) { lb.cache_control = { type: 'ephemeral' }; prevRollingBlock = lb; }
        };

        for (let iter = 0; iter < MAX_ITERS; iter++) {
          if (closed || abortController.signal.aborted) break;
          const isLastIter = iter === MAX_ITERS - 1;
          // search_wiki는 loopMode·중간iter·캡 미달일 때만 부착. 캡 도달/마지막iter/레거시는 웹만(또는 미부착) → 답변 강제.
          const allowSearch = loopMode && !isLastIter && searchWikiCount < MAX_SEARCH_WIKI;
          const iterTools = allowSearch ? [SEARCH_WIKI_TOOL, ...webTools] : webTools;

          if (loopMode) markRollingCache();
          const anthropicStream = client.messages.stream({
            model: LLM_MODEL,
            max_tokens: MAX_TOKENS,
            system: systemPrompt,
            messages: convo,
            ...(iterTools.length ? { tools: iterTools as unknown as never } : {}),
          }, { signal: abortController.signal });   // 중지 시 Anthropic 생성까지 실제 중단(output 청구 정지)

          // 세그먼트 단위 usage(누적) + 텍스트 처리.
          //   loopMode: 텍스트를 segText에 모았다가 *세그먼트 끝*에 판정 — search_wiki를 호출한 세그먼트면
          //     중간 진행텍스트("검색하겠습니다" 등)로 보고 **폐기**, 아니면(최종 답변) 송신. → 중간 문구 절대 노출 안 됨.
          //   legacy: 기존대로 buffer+safeFlushPoint 실시간 스트리밍(회귀 0).
          let segOutput = 0;
          let segWeb = 0;
          let segText = '';
          let segHadSearchWiki = false;
          for await (const chunk of anthropicStream) {
            if (closed || abortController.signal.aborted) break;
            if (chunk.type === 'message_start') {
              const u = chunk.message.usage;
              streamUsage.input = (streamUsage.input ?? 0) + u.input_tokens;
              streamUsage.cacheRead = (streamUsage.cacheRead ?? 0) + (u.cache_read_input_tokens ?? 0);
              streamUsage.cacheWrite = (streamUsage.cacheWrite ?? 0) + (u.cache_creation_input_tokens ?? 0);
            } else if (chunk.type === 'message_delta') {
              stopReason = chunk.delta.stop_reason ?? stopReason;
              segOutput = chunk.usage.output_tokens;
              const stu = (chunk.usage as { server_tool_use?: { web_search_requests?: number } }).server_tool_use;
              if (stu?.web_search_requests) segWeb = stu.web_search_requests;
            } else if (
              chunk.type === 'content_block_delta' &&
              chunk.delta.type === 'text_delta'
            ) {
              if (loopMode) {
                segText += chunk.delta.text;   // 세그먼트 끝에 송신/폐기 판정(중간 문구 차단)
              } else {
                fullContentRaw += chunk.delta.text;
                buffer += chunk.delta.text;
                const flushPoint = safeFlushPoint(buffer);
                if (flushPoint > 0) {
                  const toFlush = buffer.slice(0, flushPoint);
                  send({ type: 'chunk', content: resolveText(toFlush, citationMapping) });
                  buffer = buffer.slice(flushPoint);
                }
              }
            } else if (
              chunk.type === 'content_block_start' &&
              (chunk.content_block as { type?: string }).type === 'tool_use' &&
              (chunk.content_block as { name?: string }).name === 'search_wiki'
            ) {
              segHadSearchWiki = true;   // 이 세그먼트는 도구 호출 차례 → 텍스트 폐기 대상
            } else if (
              chunk.type === 'content_block_delta' &&
              (chunk.delta as { type?: string }).type === 'citations_delta'
            ) {
              const cit = (chunk.delta as { citation?: { url?: string; title?: string } }).citation;
              if (cit?.url) webCitations.push({ url: cit.url, title: cit.title ?? cit.url });
            } else if (
              chunk.type === 'content_block_start' &&
              (chunk.content_block as { type?: string }).type === 'web_search_tool_result'
            ) {
              const wb = (chunk.content_block as { content?: Array<{ url?: string; title?: string }> }).content;
              if (Array.isArray(wb)) for (const r of wb) if (r?.url) webCitations.push({ url: r.url, title: r.title ?? r.url });
            }
          }
          streamUsage.output = (streamUsage.output ?? 0) + segOutput;
          if (segWeb) streamUsage.webSearches = (streamUsage.webSearches ?? 0) + segWeb;

          if (loopMode) {
            // 최종 답변 세그먼트(search_wiki 미호출)만 송신. search_wiki 세그먼트의 진행텍스트는 폐기.
            if (!segHadSearchWiki && segText) {
              fullContentRaw += segText;
              send({ type: 'chunk', content: resolveText(segText, citationMapping) });
            }
          } else if (buffer.length > 0) {
            // legacy: 세그먼트 경계 남은 버퍼 flush(부분 [N] 안전).
            send({ type: 'chunk', content: resolveText(buffer, citationMapping) });
            buffer = '';
          }

          if (closed || abortController.signal.aborted) break;
          if (!loopMode) break;

          // client tool(search_wiki) 호출 여부 판정 → 있으면 실행·주입·재스트림.
          const finalMsg = await anthropicStream.finalMessage();
          const toolUses = finalMsg.content.filter(
            (b: Anthropic.ContentBlock): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'search_wiki',
          );
          if (finalMsg.stop_reason !== 'tool_use' || toolUses.length === 0) break;
          searchWikiCount += toolUses.length;

          convo.push({ role: 'assistant', content: finalMsg.content as Anthropic.ContentBlockParam[] });
          const toolResults: Anthropic.ToolResultBlockParam[] = [];
          for (const tu of toolUses) {
            const q = String((tu.input as { query?: string })?.query ?? '');
            let out: string;
            try {
              out = await runSearchWiki(
                { query: q },
                { role, registry: citationRegistry!, plan: usePlan ? (queryPlan ?? undefined) : undefined, budgetChars },
              );
            } catch (e) {
              out = `검색 중 오류: ${e instanceof Error ? e.message : '알 수 없음'}`;
            }
            console.log(`[agent-loop] iter=${iter} search_wiki q="${q.slice(0, 40)}" → ${out.length}자`);
            toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: out });
          }
          convo.push({ role: 'user', content: toolResults });
        }

        // Design Ref: rag-cost-reduction §2 M0c — 계측 로깅(평균 비용·캐시 적중·절단 추적)
        console.log(
          `[chat-usage] agents=${routing.selectedAgentIds.join('+') || '-'} ` +
          `in=${streamUsage.input ?? '?'} out=${streamUsage.output ?? '?'} ` +
          `cacheR=${streamUsage.cacheRead ?? 0} cacheW=${streamUsage.cacheWrite ?? 0} ` +
          `web=${streamUsage.webSearches ?? 0} stop=${stopReason ?? '?'}`,
        );
        if (streamUsage.webSearches) {
          // 웹검색 발동 = 유료(검색비 + 결과 입력토큰). 비용 모니터링.
          console.log(`[chat-usage] 🌐 web_search ${streamUsage.webSearches}회 — 외부/최신 정보 보강(유료 ~$0.05~0.09)`);
        }
        if (stopReason === 'max_tokens') {
          console.warn('[chat-usage] ⚠️ max_tokens 절단 발생 — 답변 말미(P5 한계마커/인용) 손실 가능');
        }
        // [missed-web] Case B 측정(비용 0): 웹 도구가 부착됐는데(webEnabled) 한 번도 안 쏘고(web=0)
        //   답변이 한계/외부떠넘김으로 끝났다면 = 웹 회피 후보. 패치(web-search.ts) 효과 추적용.
        if (webEnabled && !streamUsage.webSearches) {
          const declined = /범위 밖|자료가? (없|부족)|외부.{0,8}확인.{0,4}필요|확인하시기 바랍|snu\.ac\.kr|📌 한계|분석의 한계|자료 한계/.test(fullContentRaw);
          if (declined) {
            console.warn(`[missed-web] ⚠️ webEnabled+web_search 0회+한계/외부떠넘김 — 웹 회피 후보(Case B). mode=${mode} q="${message.slice(0, 40)}"`);
          }
        }

        // ─── 옛 형식 [위키] sid 검출 + retry ──────────────────────────
        // LLM이 P2 무시하고 옛 형식 직접 출력 시 1회 재요청.
        // 발견되면 비-스트리밍 retry → 'replace' 이벤트로 답변 영역 교체.
        const oldFormats = detectOldFormatCitations(fullContentRaw);
        if (!closed && !abortController.signal.aborted && oldFormats.length > 0) {
          console.log(`[citation] ${oldFormats.length} old-format detected, retrying once...`);
          try {
            const retryPrompt = buildOldFormatRetryPrompt(oldFormats, citationSummary);
            const retryResp = await client.messages.create({
              model: LLM_MODEL,
              max_tokens: MAX_TOKENS,
              system: systemPrompt,
              messages: [
                ...history,
                { role: 'user', content: userMessage },
                { role: 'assistant', content: fullContentRaw },
                { role: 'user', content: retryPrompt },
              ],
            });
            const retryRaw = retryResp.content[0]?.type === 'text' ? retryResp.content[0].text : '';
            const retryOldFormats = detectOldFormatCitations(retryRaw);
            if (retryOldFormats.length === 0) {
              // retry 성공 — fullContentRaw 교체
              fullContentRaw = retryRaw;
              const resolved = resolveText(retryRaw, citationMapping);
              send({ type: 'replace', content: resolved });
            } else {
              console.error(`[citation] retry still has ${retryOldFormats.length} old-format, accepting`);
              // retry도 실패 — 그대로 진행 (답변 폐기보다는 덜 완벽한 상태로 전달)
            }
          } catch (err) {
            console.error('[citation] retry failed:', err);
            // 실패 시 원본 그대로 진행
          }
        }

        // ─── 표 산수 검산 + 자동 교정 ──────────────────────────────────
        // 표의 비중 합·항목 합이 안 맞으면(LLM 첫 계산 오류) 정확한 불일치를 콕 집어 1회 재요청.
        // 사용자에겐 경고가 아니라 '맞는 답'만 보임. 틀린 표가 있을 때만 호출(평소 비용 영향 0).
        if (!closed && !abortController.signal.aborted) {
          const tableIssues = validateTables(resolveText(fullContentRaw, citationMapping));
          if (tableIssues.length > 0) {
            console.log(`[table-audit] ${tableIssues.length} arithmetic issue(s), fixing once...`);
            try {
              // 경량 retry — 산수 교정엔 위키 컨텍스트 불필요(표 안 숫자만 재계산).
            //   전체 컨텍스트(~72k) 재전송 안 함 → 비용 ~10배 절감. [N] 인용·서술은 그대로 유지 지시.
            const fixResp = await client.messages.create({
                model: LLM_MODEL,
                max_tokens: MAX_TOKENS,
                system: '당신은 서울대학교 거버넌스 위키 어시스턴트입니다. 인용은 [N] 번호 형식만 유지하고 내부 ID를 노출하지 마세요. 아래 답변의 수치 표 산수만 정확히 교정합니다.',
                messages: [
                  { role: 'user', content: '직전에 작성한 답변의 수치 표를 검토합니다.' },
                  { role: 'assistant', content: fullContentRaw },
                  { role: 'user', content: buildTableFixPrompt(tableIssues) },
                ],
              });
              const fixRaw = fixResp.content[0]?.type === 'text' ? fixResp.content[0].text : '';
              // 교정본이 오류를 줄였을 때만 채택(악화 방지)
              if (fixRaw && validateTables(resolveText(fixRaw, citationMapping)).length < tableIssues.length) {
                fullContentRaw = fixRaw;
                send({ type: 'replace', content: resolveText(fixRaw, citationMapping) });
              } else {
                console.error('[table-audit] fix did not reduce issues, keeping original');
              }
            } catch (err) {
              console.error('[table-audit] fix failed:', err);
            }
          }
        }

        // web_search 인용 메타를 본문 끝 "🌐 외부 출처"로 첨부 (policy·fact·lens 공통 — 모델 인라인 의존 X, 메타데이터 직접 렌더).
        if (webCitations.length > 0) {
          const block = renderWebSources(webCitations);
          if (block) {
            fullContentRaw += block;
            send({ type: 'chunk', content: block });
          }
        }

        // DB·sources 모두 resolve된 텍스트 + LLM이 실제 인용한 source만
        const fullContent = resolveText(fullContentRaw, citationMapping);
        const citedNumbers = extractCitedNumbers(fullContentRaw);
        const citedSources = resolveCitations(citedNumbers, citationMapping);

        send({ type: 'sources', refs: citedSources });

        await db.insert(messages).values({
          id: crypto.randomUUID(),
          conversationId: convId!,
          role: 'assistant',
          content: fullContent,
          routedAgents: routing.selectedAgentIds,
          sources: citedSources,
          mode,
        });

        // Google Sheets 로깅 — done 전에 await (Vercel 함수 종료 전 완료 보장)
        if (fullContent.trim()) {
          await logQuestionToSheet({
            name: session.user.name ?? '',
            email: session.user.email ?? '',
            role,
            question: message,
            answer: fullContent,
            wikis: routing.selectedAgentIds?.join(', ') ?? '',
            mode,
            conversationId: convId!,
          }).catch(err => console.error('[Sheets] log failed:', err));
        }

        send({ type: 'done', conversationId: convId });
      } catch (err) {
        // 사용자 중지(abort)는 정상 흐름 — 에러 로그·에러 이벤트 없이 부분답변만 '중지됨'으로 저장.
        const aborted = abortController.signal.aborted;
        if (!aborted) console.error('Chat stream failed', err);
        const errMsg = err instanceof Error ? err.message : '알 수 없는 오류가 발생했습니다.';
        // 부분 응답이라도 저장 — user 메시지 고아화 방지(다음 턴 user-user 연속 → Anthropic 거부 차단)
        //               + 사용자가 읽던 부분 답변 보존
        try {
          const partial = resolveText(fullContentRaw, citationMapping).trim();
          const sources = resolveCitations(extractCitedNumbers(fullContentRaw), citationMapping);
          if (aborted) {
            // 중지: 빈 답이어도 placeholder 저장(user 메시지 고아화/연속 user 차단). 클라는 이미 끊겨 send는 no-op.
            await db.insert(messages).values({
              id: crypto.randomUUID(),
              conversationId: convId!,
              role: 'assistant',
              content: partial ? `${partial}\n\n---\n\n_(생성을 중지했습니다.)_` : '_(생성을 중지했습니다.)_',
              routedAgents: routing.selectedAgentIds,
              sources,
              mode,
            });
          } else if (partial) {
            await db.insert(messages).values({
              id: crypto.randomUUID(),
              conversationId: convId!,
              role: 'assistant',
              content: `${partial}\n\n---\n\n⚠️ 응답 생성 중 오류가 발생해 일부만 저장되었습니다.`,
              routedAgents: routing.selectedAgentIds,
              sources,
              mode,
            });
            send({ type: 'error', message: errMsg, keepContent: true });
          } else {
            send({ type: 'error', message: errMsg });
          }
        } catch (persistErr) {
          console.error('Failed to persist partial answer', persistErr);
          if (!aborted) send({ type: 'error', message: errMsg });
        }
      } finally {
        try {
          controller.close();
        } catch {
          // 이미 닫힘(클라 disconnect) — 무시
        }
      }
    },
    cancel() {
      // 소비자(HTTP 응답 파이프) 절단 = 클라 중지/이탈. req.signal보다 확실히 발동 →
      //   Anthropic 요청까지 abort 전파해 output 생성·청구를 즉시 멈춘다.
      abortController.abort();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}

// Design Ref: college-grad-wiki §4.1 I-9 — Tier3/4 직답 스트림.
//   일반 LLM 경로와 동일한 SSE 이벤트(routing→chunk→sources→done)를 내되 Anthropic 호출 없음.
//   대화 생성·user/assistant 메시지 저장·Sheets 로깅은 일반 경로와 동일하게 수행(이력 일관성).
async function streamDirectAnswer(args: {
  direct: DirectAnswer;
  message: string;
  conversationId: string | undefined;
  userId: string;
  mode: string;
  selectedAgentIds: string[];
  agentNames: string[];
  userName: string;
  userEmail: string;
  role: Role;
}): Promise<Response> {
  const { direct, message, userId, mode, selectedAgentIds, agentNames, userName, userEmail, role } = args;
  let convId = args.conversationId;

  // 대화 생성 + user 메시지 저장 (일반 경로 line 128-145와 동일 패턴)
  if (!convId) {
    convId = crypto.randomUUID();
    await db.insert(conversations).values({ id: convId, userId, title: message.slice(0, 50) });
  }
  await db.insert(messages).values({
    id: crypto.randomUUID(),
    conversationId: convId,
    role: 'user',
    content: message,
    routedAgents: selectedAgentIds,
    sources: null,
    mode,
  });

  // 직답 경로도 동일하게 부모 대화 활동시각 bump (목록 상위 정렬 일관성).
  await db.update(conversations).set({ updatedAt: new Date() }).where(eq(conversations.id, convId));

  // assistant 메시지 저장 (LLM 없이 즉시 — 직답 출처 포함)
  await db.insert(messages).values({
    id: crypto.randomUUID(),
    conversationId: convId,
    role: 'assistant',
    content: direct.answer,
    routedAgents: selectedAgentIds,
    sources: direct.sources,
    mode,
  });

  // Sheets 로깅 (best-effort, 일반 경로와 동일)
  if (direct.answer.trim()) {
    logQuestionToSheet({
      name: userName,
      email: userEmail,
      role,
      question: message,
      answer: direct.answer,
      wikis: selectedAgentIds.join(', '),
      mode,
      conversationId: convId,
    }).catch((err) => console.error('[Sheets] direct log failed:', err));
  }

  const encoder = new TextEncoder();
  const finalConvId = convId;
  const stream = new ReadableStream({
    start(controller) {
      const send = (data: object) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      send({ type: 'routing', agents: selectedAgentIds, agentNames, conversationId: finalConvId, answerClass: direct.answerClass });
      send({ type: 'chunk', content: direct.answer });
      send({ type: 'sources', refs: direct.sources });
      send({ type: 'done', conversationId: finalConvId });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}

async function ensureUserExists(userId: string, name: string | null | undefined, role: Role) {
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (existing) return;

  if (userId !== 'master-admin') {
    throw new Error(`Session user does not exist in DB: ${userId}`);
  }

  await db.insert(users).values({
    id: userId,
    email: 'master-admin@snu.local',
    passwordHash: 'master-login',
    name: name || '관리자',
    role,
    approvedAt: new Date(),
  });
}
