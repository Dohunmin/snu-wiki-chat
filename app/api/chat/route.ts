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
import { getAnthropicClient, LLM_MODEL, MAX_TOKENS } from '@/lib/llm/client';
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

  try {
    await ensureUserExists(userId, session.user.name, role);
  } catch (err) {
    console.error('Failed to ensure chat user exists', err);
    return Response.json({ error: '사용자 정보를 준비하지 못했습니다.' }, { status: 500 });
  }

  let routing;
  let systemPrompt;
  let userMessage;
  let lensPersonaInfo: { id: string; displayName: string; insufficient: boolean } | undefined;
  let convId = conversationId;

  try {
    routing = await routeQuery(message, role);

    if (mode.startsWith('lens:')) {
      const personaId = mode.slice(5);
      const persona = await loadPersonaContext(personaId, message, role);
      if (!persona) {
        return Response.json({ error: '존재하지 않는 페르소나입니다.' }, { status: 400 });
      }
      systemPrompt = buildLensSystemPrompt(routing.contexts, persona, role);
      userMessage = buildLensUserMessage(message, routing.contexts, persona);
      lensPersonaInfo = {
        id: persona.id,
        displayName: persona.displayName,
        insufficient: persona.insufficient,
      };
    } else {
      systemPrompt = buildSystemPrompt(routing.contexts, role);
      userMessage = buildUserMessage(message, routing.contexts);
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
      const send = (data: object) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      try {
        send({
          type: 'routing',
          agents: routing.selectedAgentIds,
          agentNames: routing.contexts.map(c => c.agentName),
          conversationId: convId,
          lensPersona: lensPersonaInfo,
        });

        const client = getAnthropicClient();
        let fullContent = '';

        // 직전 1회 교환(user + assistant 쌍)만 전문 포함
        // 토큰 증가 최소화하면서 직전 답변 맥락 완전 보존
        type AnthropicMessage = { role: 'user' | 'assistant'; content: string };
        const history: AnthropicMessage[] = [];
        if (convId) {
          const allPrev = await db
            .select({ role: messages.role, content: messages.content })
            .from(messages)
            .where(eq(messages.conversationId, convId))
            .orderBy(asc(messages.createdAt));

          // 현재 저장된 user 메시지 제외 (마지막 1개)
          // 직전 3회 교환(user+assistant 쌍 3개)까지 포함
          const prev = allPrev.slice(0, -1).slice(-6);
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

        for await (const chunk of anthropicStream) {
          if (
            chunk.type === 'content_block_delta' &&
            chunk.delta.type === 'text_delta'
          ) {
            fullContent += chunk.delta.text;
            send({ type: 'chunk', content: chunk.delta.text });
          }
        }

        const allSources = routing.contexts.flatMap(c => c.sources);
        send({ type: 'sources', refs: allSources });

        await db.insert(messages).values({
          id: crypto.randomUUID(),
          conversationId: convId!,
          role: 'assistant',
          content: fullContent,
          routedAgents: routing.selectedAgentIds,
          sources: allSources,
          mode,
        });

        send({ type: 'done', conversationId: convId });
      } catch (err) {
        console.error('Chat stream failed', err);
        const errMsg = err instanceof Error ? err.message : '알 수 없는 오류가 발생했습니다.';
        send({ type: 'error', message: errMsg });
      } finally {
        controller.close();
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
