import { NextRequest } from 'next/server';
import type Anthropic from '@anthropic-ai/sdk';
import { auth } from '@/lib/auth/config';
import { canChat } from '@/lib/auth/roles';
import type { Role } from '@/lib/auth/roles';
import { routeQuery } from '@/lib/agents/router';
import { enforceContextBudget } from '@/lib/agents/context-budget';
import { complexityBudget } from '@/lib/agents/complexity';
import { getStructuredFact, getLiveBoard, type DirectAnswer } from '@/lib/agents/structured';
import { loadPersonaContext } from '@/lib/agents/lens';
import {
  buildSystemPromptParts,
  buildUserMessage,
  buildLensSystemPrompt,
  buildLensUserMessage,
} from '@/lib/llm/prompts';
import {
  buildNumberedContexts,
  resolveText,
  extractCitedNumbers,
  resolveCitations,
  safeFlushPoint,
  detectOldFormatCitations,
  buildOldFormatRetryPrompt,
} from '@/lib/llm/citations';
import { validateTables, buildTableFixPrompt } from '@/lib/llm/table-audit';
import { getAnthropicClient, LLM_MODEL, MAX_TOKENS } from '@/lib/llm/client';
import { logQuestionToSheet } from '@/lib/google-sheets';
import { db } from '@/lib/db/client';
import { conversations, messages, users } from '@/lib/db/schema';
import { eq, asc } from 'drizzle-orm';
import { z } from 'zod';

const chatSchema = z.object({
  message: z.string().min(1).max(2000),
  conversationId: z.string().optional(),
  mode: z.string().regex(/^(normal|lens:[a-z0-9-]+)$/).default('normal'),
});

// college-grad-wiki / web-search-fallback — 위키로 못 답하는 외부·최신·비교 질문만 라이브 검색.
//   max_uses:1로 비용 캡(검색 결과 본문이 입력토큰 → 1회로 제한해 ~$0.09/질문). 평소 질문은 미발동 → $0.
const WEB_SEARCH_TOOL = { type: 'web_search_20250305', name: 'web_search', max_uses: 1 };
const WEB_SEARCH_GUIDANCE = `\n\n[웹 검색 도구]\n` +
  `- 기본은 위 위키 컨텍스트([N])로만 답한다. 위키에 있는 내용은 절대 웹 검색하지 않는다(비용·정확도).\n` +
  `- 다음 경우에만 web_search 사용: (1) 위키에 없는 외부 기관·타 대학·인물(예: 카이스트) (2) 위키 범위를 벗어난 최신/실시간 정보 (3) 위키와 외부를 비교 요청.\n` +
  `- 웹 결과를 사용하면 반드시 본문에 출처를 마크다운 링크 [제목](URL)로 명시한다.\n` +
  `- 위키로 충분하면 web_search를 호출하지 않는다.`;

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

  const { message, conversationId, mode } = parsed.data;
  const userId = session.user.id;

  // lens 모드 권한 검증
  if (mode.startsWith('lens:') && role !== 'admin') {
    return Response.json({ error: '관리자 전용 모드입니다.' }, { status: 403 });
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

  let routing;
  let systemPrompt: string | Anthropic.TextBlockParam[];
  let userMessage;
  let citationMapping: Map<number, { wiki: string; page: string; topic?: string }>;
  let citationSummary: string;
  let lensPersonaInfo: { id: string; displayName: string; insufficient: boolean } | undefined;
  let convId = conversationId;

  try {
    routing = await routeQuery(message, role);

    // Design Ref: §4.1 I-9 — Tier3/4 직답 분기 (college-grad-wiki).
    //   governance 쿼리는 routing.tier === undefined → 이 블록 통째로 skip → 아래 일반 RAG와 byte-identical.
    //   T3 적중: structured_facts 1레코드 → LLM 0토큰. T4 적중: live_cache 게시판 리스트.
    //   미스/TTL 만료(direct === null) → fall through → 일반 RAG(Tier1 degrade).
    if ((routing.tier === 3 || routing.tier === 4) && routing.college) {
      const direct =
        routing.tier === 3
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

    // 보편 컨텍스트 예산 — 모든 경로 합류점에서 총량 캡(비용 꼬리 차단) + 질문 복잡도별 예산.
    //   단순 factoid=작은 예산(저렴), 종합형=큰 예산(OLD급 품질). 실측 75% 단순 → 평균↓ + 깊은 품질 보존.
    //   CONTEXT_BUDGET_CHARS 설정 시 고정값으로 override(실험용).
    const budgetChars = process.env.CONTEXT_BUDGET_CHARS ? Number(process.env.CONTEXT_BUDGET_CHARS) : complexityBudget(message);
    const budgetedContexts = await enforceContextBudget(message, routing.contexts, budgetChars);

    // 번호 인용 매핑 구축 — LLM이 [N]만 사용하도록
    const numbered = buildNumberedContexts(budgetedContexts);
    citationMapping = numbered.mapping;
    citationSummary = numbered.summary;

    if (mode.startsWith('lens:')) {
      const personaId = mode.slice(5);
      const persona = await loadPersonaContext(personaId, message, role);
      if (!persona) {
        return Response.json({ error: '존재하지 않는 페르소나입니다.' }, { status: 400 });
      }
      systemPrompt = buildLensSystemPrompt(budgetedContexts, persona, role);
      userMessage = buildLensUserMessage(message, numbered.contextMarkdown, numbered.summary, persona);
      lensPersonaInfo = {
        id: persona.id,
        displayName: persona.displayName,
        insufficient: persona.insufficient,
      };
    } else {
      // Design Ref: rag-cost-reduction §2 M1b — 안정 system prefix에 prompt caching 적용.
      //   stable(고정 P0~P6 + 가이드)에 cache_control 부여 → 재시도/멀티턴/동시질의서 입력단가 ~1/10.
      //   tail(agentList·tier2 경고)은 가변이라 캐시 밖. lens 모드는 회귀위험 커 현재 미적용(후속).
      //   본문(userMessage) 캐싱은 적중률 실측(M0c [chat-usage] cacheR/cacheW) 후 결정.
      const parts = buildSystemPromptParts(budgetedContexts, role);
      systemPrompt = [
        { type: 'text', text: parts.stable, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: parts.tail + WEB_SEARCH_GUIDANCE },
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

  } catch (err) {
    console.error('Failed to prepare chat response', err);
    return Response.json({ error: '대화를 저장하거나 자료를 찾는 중 오류가 발생했습니다.' }, { status: 500 });
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
        });

        const client = getAnthropicClient();

        // 직전 5회 교환(user + assistant 쌍 5개 = 최대 10개 메시지) 전문 포함.
        // 단, **연속 대화로 판단될 때만** 로드 — 개별 독립 질문은 이력 생략(토큰 절감).
        //   신호: 매우 짧은 질문(맥락 의존) 또는 지시어·접속·후속 표현.
        type AnthropicMessage = { role: 'user' | 'assistant'; content: string };
        const history: AnthropicMessage[] = [];
        const followupRe = /그럼|그러면|그리고|그래서|또 |추가로|그 외|이것 외|이 외|위에서|위 질문|방금|아까|앞서|앞에|지금까지|이어서|계속|왜냐|이거|그거|저거|이건|그건|그렇다면|이를 |위 내용|방금 답변|정리해|요약해|다시 |더 |그것/;
        const isContinuation = [...message.trim()].length <= 12 || followupRe.test(message);
        if (convId && isContinuation) {
          const allPrev = await db
            .select({ role: messages.role, content: messages.content })
            .from(messages)
            .where(eq(messages.conversationId, convId))
            .orderBy(asc(messages.createdAt));

          // 현재 저장된 user 메시지 제외 (마지막 1개)
          // 직전 5회 교환(user+assistant 쌍 5개)까지 포함
          const prev = allPrev.slice(0, -1).slice(-10);
          for (const m of prev) {
            if (m.role === 'user' || m.role === 'assistant') {
              history.push({ role: m.role, content: m.content });
            }
          }
        }

        // web_search: normal 모드만(lens는 페르소나 전용, 회귀위험 회피). 위키로 답하면 미발동 → 비용 0.
        const anthropicStream = client.messages.stream({
          model: LLM_MODEL,
          max_tokens: MAX_TOKENS,
          system: systemPrompt,
          messages: [...history, { role: 'user', content: userMessage }],
          ...(mode.startsWith('lens:') ? {} : { tools: [WEB_SEARCH_TOOL] as unknown as never }),
        });

        // 스트리밍 + [N] → [위키] sid resolve
        // buffer에 누적하다가 safe flush point 까지만 resolve해서 송신
        // → 부분 [N] (예: "[1" 가 chunk 경계에 걸린 경우) 안전 처리
        // Design Ref: rag-cost-reduction §2 M0c — 사용량·절단 계측(Phase 0)
        //   stop_reason: max_tokens 절단을 감지(현재는 무음 통과 → 답변 말미 P5 한계마커/인용 손실).
        //   usage: input/output + 캐시 토큰 로깅 → Phase 1 prompt-caching 적중률 의사결정 데이터.
        //   출력은 불변(로깅만 추가) — 회귀 표면 0.
        let stopReason: string | null = null;
        const streamUsage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; webSearches?: number } = {};

        for await (const chunk of anthropicStream) {
          if (closed || req.signal?.aborted) break;  // 클라 연결 끊김 → LLM 스트림 소비 중단
          if (chunk.type === 'message_start') {
            const u = chunk.message.usage;
            streamUsage.input = u.input_tokens;
            streamUsage.cacheRead = u.cache_read_input_tokens ?? undefined;
            streamUsage.cacheWrite = u.cache_creation_input_tokens ?? undefined;
          } else if (chunk.type === 'message_delta') {
            stopReason = chunk.delta.stop_reason ?? stopReason;
            streamUsage.output = chunk.usage.output_tokens;
            const stu = (chunk.usage as { server_tool_use?: { web_search_requests?: number } }).server_tool_use;
            if (stu?.web_search_requests) streamUsage.webSearches = stu.web_search_requests;
          } else if (
            chunk.type === 'content_block_delta' &&
            chunk.delta.type === 'text_delta'
          ) {
            fullContentRaw += chunk.delta.text;
            buffer += chunk.delta.text;
            const flushPoint = safeFlushPoint(buffer);
            if (flushPoint > 0) {
              const toFlush = buffer.slice(0, flushPoint);
              const resolved = resolveText(toFlush, citationMapping);
              send({ type: 'chunk', content: resolved });
              buffer = buffer.slice(flushPoint);
            }
          }
        }
        // 남은 버퍼 flush (마지막에 미완성 [ 가 있어도 그대로 전송)
        if (buffer.length > 0) {
          const resolved = resolveText(buffer, citationMapping);
          send({ type: 'chunk', content: resolved });
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

        // ─── 옛 형식 [위키] sid 검출 + retry ──────────────────────────
        // LLM이 P2 무시하고 옛 형식 직접 출력 시 1회 재요청.
        // 발견되면 비-스트리밍 retry → 'replace' 이벤트로 답변 영역 교체.
        const oldFormats = detectOldFormatCitations(fullContentRaw);
        if (!closed && oldFormats.length > 0) {
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
        if (!closed) {
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
        console.error('Chat stream failed', err);
        const errMsg = err instanceof Error ? err.message : '알 수 없는 오류가 발생했습니다.';
        // 부분 응답이라도 저장 — user 메시지 고아화 방지(다음 턴 user-user 연속 → Anthropic 거부 차단)
        //               + 사용자가 읽던 부분 답변 보존
        try {
          const partial = resolveText(fullContentRaw, citationMapping).trim();
          if (partial) {
            await db.insert(messages).values({
              id: crypto.randomUUID(),
              conversationId: convId!,
              role: 'assistant',
              content: `${partial}\n\n---\n\n⚠️ 응답 생성 중 오류가 발생해 일부만 저장되었습니다.`,
              routedAgents: routing.selectedAgentIds,
              sources: resolveCitations(extractCitedNumbers(fullContentRaw), citationMapping),
              mode,
            });
            send({ type: 'error', message: errMsg, keepContent: true });
          } else {
            send({ type: 'error', message: errMsg });
          }
        } catch (persistErr) {
          console.error('Failed to persist partial answer', persistErr);
          send({ type: 'error', message: errMsg });
        }
      } finally {
        try {
          controller.close();
        } catch {
          // 이미 닫힘(클라 disconnect) — 무시
        }
      }
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

  // assistant 메시지 저장 (LLM 없이 즉시 — Tier 출처 포함)
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
      send({ type: 'routing', agents: selectedAgentIds, agentNames, conversationId: finalConvId, tier: direct.tier });
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
