import { NextRequest } from 'next/server';
import { auth } from '@/lib/auth/config';
import { canChat } from '@/lib/auth/roles';
import type { Role } from '@/lib/auth/roles';
import { routeQuery } from '@/lib/agents/router';
import { buildSystemPrompt, buildUserMessage } from '@/lib/llm/prompts';
import { getAnthropicClient, LLM_MODEL, MAX_TOKENS } from '@/lib/llm/client';
import { db } from '@/lib/db/client';
import { messages, conversations } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

const chatSchema = z.object({
  message: z.string().min(1).max(2000),
  conversationId: z.string().optional(),
});

export async function POST(req: NextRequest) {
  // 인증 확인
  const session = await auth();
  if (!session?.user) {
    return new Response(JSON.stringify({ error: '로그인이 필요합니다' }), { status: 401 });
  }
  const role = (session.user as { role: Role }).role;
  if (!canChat(role)) {
    return new Response(JSON.stringify({ error: '승인 대기 중입니다' }), { status: 403 });
  }

  // 요청 파싱
  const body = await req.json();
  const parsed = chatSchema.safeParse(body);
  if (!parsed.success) {
    return new Response(JSON.stringify({ error: '잘못된 요청입니다' }), { status: 400 });
  }
  const { message, conversationId } = parsed.data;
  const userId = session.user.id!;

  // 라우팅 실행
  const routing = await routeQuery(message, role);

  // 시스템 프롬프트 + 사용자 메시지 구성
  const systemPrompt = buildSystemPrompt(routing.contexts, role);
  const userMessage = buildUserMessage(message, routing.contexts);

  // 대화 저장 (conversationId 없으면 새로 생성)
  let convId = conversationId;
  if (!convId) {
    convId = crypto.randomUUID();
    await db.insert(conversations).values({
      id: convId,
      userId,
      title: message.slice(0, 50),
    });
  }

  // 사용자 메시지 저장
  await db.insert(messages).values({
    id: crypto.randomUUID(),
    conversationId: convId,
    role: 'user',
    content: message,
    routedAgents: routing.selectedAgentIds,
    sources: null,
  });

  // SSE 스트리밍 응답
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      try {
        // 라우팅 정보 전송
        send({
          type: 'routing',
          agents: routing.selectedAgentIds,
          agentNames: routing.contexts.map(c => c.agentName),
          conversationId: convId,
        });

        // Claude API 스트리밍 호출
        const client = getAnthropicClient();
        let fullContent = '';

        const stream = await client.messages.stream({
          model: LLM_MODEL,
          max_tokens: MAX_TOKENS,
          system: systemPrompt,
          messages: [{ role: 'user', content: userMessage }],
        });

        for await (const chunk of stream) {
          if (
            chunk.type === 'content_block_delta' &&
            chunk.delta.type === 'text_delta'
          ) {
            fullContent += chunk.delta.text;
            send({ type: 'chunk', content: chunk.delta.text });
          }
        }

        // 출처 수집
        const allSources = routing.contexts.flatMap(c => c.sources);
        send({ type: 'sources', refs: allSources });

        // 어시스턴트 메시지 저장
        await db.insert(messages).values({
          id: crypto.randomUUID(),
          conversationId: convId,
          role: 'assistant',
          content: fullContent,
          routedAgents: routing.selectedAgentIds,
          sources: allSources,
        });

        send({ type: 'done', conversationId: convId });
      } catch (err) {
        send({ type: 'error', message: '답변 생성 중 오류가 발생했습니다' });
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
