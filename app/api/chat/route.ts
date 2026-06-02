import { NextRequest } from 'next/server';
import { auth } from '@/lib/auth/config';
import { canChat } from '@/lib/auth/roles';
import type { Role } from '@/lib/auth/roles';
import { routeQuery } from '@/lib/agents/router';
import { loadPersonaContext } from '@/lib/agents/lens';
import {
  buildSystemPrompt,
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
  let systemPrompt;
  let userMessage;
  let citationMapping: Map<number, { wiki: string; page: string; topic?: string }>;
  let citationSummary: string;
  let lensPersonaInfo: { id: string; displayName: string; insufficient: boolean } | undefined;
  let convId = conversationId;

  try {
    routing = await routeQuery(message, role);

    // 번호 인용 매핑 구축 — LLM이 [N]만 사용하도록
    const numbered = buildNumberedContexts(routing.contexts);
    citationMapping = numbered.mapping;
    citationSummary = numbered.summary;

    if (mode.startsWith('lens:')) {
      const personaId = mode.slice(5);
      const persona = await loadPersonaContext(personaId, message, role);
      if (!persona) {
        return Response.json({ error: '존재하지 않는 페르소나입니다.' }, { status: 400 });
      }
      systemPrompt = buildLensSystemPrompt(routing.contexts, persona, role);
      userMessage = buildLensUserMessage(message, numbered.contextMarkdown, numbered.summary, persona);
      lensPersonaInfo = {
        id: persona.id,
        displayName: persona.displayName,
        insufficient: persona.insufficient,
      };
    } else {
      systemPrompt = buildSystemPrompt(routing.contexts, role);
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

        // 직전 5회 교환(user + assistant 쌍 5개 = 최대 10개 메시지) 전문 포함
        // 토큰 증가 최소화하면서 직전 답변 맥락 보존
        type AnthropicMessage = { role: 'user' | 'assistant'; content: string };
        const history: AnthropicMessage[] = [];
        if (convId) {
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

        const anthropicStream = client.messages.stream({
          model: LLM_MODEL,
          max_tokens: MAX_TOKENS,
          system: systemPrompt,
          messages: [...history, { role: 'user', content: userMessage }],
        });

        // 스트리밍 + [N] → [위키] sid resolve
        // buffer에 누적하다가 safe flush point 까지만 resolve해서 송신
        // → 부분 [N] (예: "[1" 가 chunk 경계에 걸린 경우) 안전 처리
        for await (const chunk of anthropicStream) {
          if (closed || req.signal?.aborted) break;  // 클라 연결 끊김 → LLM 스트림 소비 중단
          if (
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
