/**
 * 상위 라우터 E2E — route.ts와 동일한 함수 체인을 admin 역할로 직접 호출.
 *   진짜 Haiku 라우터 + 진짜 Sonnet 답변 + 진짜 web_search. usage에서 실비용 계산.
 *   검증: 라우터 의도 → effective mode → 파이프라인 선택 → 웹 발동 판단 → 답변 스타일.
 *   ⚠️ 유료(Sonnet+web). 비용 보고·승인 후에만 실행.
 *   npx tsx --env-file=.env.local scripts/test-router-e2e.ts
 */
import fs from 'fs';
import { routeToAgent } from '@/lib/agents/agent-router';
import { routeQuery } from '@/lib/agents/router';
import { complexityBudget } from '@/lib/agents/complexity';
import { enforceContextBudget } from '@/lib/agents/context-budget';
import { buildNumberedContexts } from '@/lib/llm/citations';
import { buildSystemPromptParts, buildUserMessage, buildPolicySystemPrompt } from '@/lib/llm/prompts';
import { getAnthropicClient, LLM_MODEL, MAX_TOKENS } from '@/lib/llm/client';
import type { Role } from '@/lib/auth/roles';

// route.ts와 동일한 web_search 도구/가이드 (배관 일치)
const WEB_SEARCH_TOOL = { type: 'web_search_20250305', name: 'web_search', max_uses: 1 };
const WEB_SEARCH_TOOL_POLICY = { type: 'web_search_20250305', name: 'web_search', max_uses: 1 };
const WEB_GUIDE_NORMAL = `\n\n[웹 검색 도구]\n- 기본은 위키 컨텍스트([N])로만 답한다. 위키에 있으면 검색 안 함.\n- 위키에 없는 외부 기관·타 대학·최신/비교만 web_search. 결과는 [제목](URL)로 인용.`;
const WEB_GUIDE_POLICY = `\n\n[웹 검색 도구 — 인사이트(능동 판단·직접 실행)]\n- 외부 정보가 필요하면 네가 판단해 직접 web_search(최대 1회). 거절·되묻기 금지.\n- 내부 거버넌스 사실로 충분하면 검색 안 함(비용).`;

// 4사분면 × 2개 실질문 (DB 실측, test-router.out.md 기준 — 임의 생성 아님)
//   외부 칸은 실질문이 드묾(코퍼스 내부 중심) → #23/#4는 "웹 발동 여부 관찰" 경계 케이스.
const QUESTIONS: { q: string; quadrant: string; expect: string }[] = [
  { q: '서울대 전체 예산은 얼마이고 어떻게 구성되나요?', quadrant: 'fact·내부', expect: 'normal, 웹 미발동' },
  { q: '이사회가 주로 다루는 안건을 어떤 것들이 있습니까?', quadrant: 'fact·내부', expect: 'normal, 웹 미발동' },
  { q: '외부에서 서울대학교를 보는 시선, 최근의 사회적 이슈에서 서울대학교가 부정적으로 언급된 사례', quadrant: 'fact·외부', expect: 'normal, 웹 발동(두 축 분리 증명)' },
  { q: '지금까지 서울대학교 역대 총장의 전공/전문성과 역점 추진 사업에 연관성이 있는가?', quadrant: 'fact·외부(경계)', expect: 'normal, 내부데이터→웹 미발동 예상' },
  { q: '서울대학교에서 신임교원 임용 절차를 단과대학의 특성을 고려하지 않고 일괄적으로 운영하는 이유는 무엇인가?', quadrant: 'insight·내부', expect: 'policy, 웹 미발동' },
  { q: '평의원회는 서울대 규정 상 정해지지 않은 권한을 행사하는 것 아니야?', quadrant: 'insight·내부', expect: 'policy, 웹 미발동' },
  { q: 'AI 관련 연구나 프로젝트와 관련하여 서울대가 최근 카이스트에 밀리고 있다는 관측이 많은데, 이렇게 된 원인을 진단해 주세요.', quadrant: 'insight·외부', expect: 'policy, 웹 발동' },
  { q: '서울대의 부동산 자산에 대해 이야기할게. 다른 학교나 서울대병원은 서울 도심의 건물을 사고 있어. 하지만 서울대는 도심 건물을 샀는지 모르겠어.', quadrant: 'insight·외부(경계)', expect: 'policy, 외부비교→웹 발동 가능' },
];

// Sonnet 4.6 단가 ($/MTok) + web_search ($/검색) — 실측 usage로 실비용 산출
const PRICE = { in: 3, out: 15, cacheRead: 0.30, cacheWrite: 3.75, web: 0.01 };
const ROLE: Role = 'admin';

function costOf(u: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; web?: number }): number {
  return (
    ((u.input ?? 0) * PRICE.in + (u.output ?? 0) * PRICE.out + (u.cacheRead ?? 0) * PRICE.cacheRead + (u.cacheWrite ?? 0) * PRICE.cacheWrite) / 1e6 +
    (u.web ?? 0) * PRICE.web
  );
}

async function main() {
  const client = getAnthropicClient();
  const out: string[] = ['# 상위 라우터 E2E — 실질문 4사분면 (admin 역할)\n'];
  let totalCost = 0;

  for (let i = 0; i < QUESTIONS.length; i++) {
    const { q, quadrant, expect } = QUESTIONS[i];

    // 1) 상위 라우터 → effective mode (route.ts와 동일 로직, admin)
    const decision = await routeToAgent(q);
    const canInsight = ROLE === 'admin' || ROLE === 'tier1';
    const mode = decision.agent === 'insight' && canInsight ? 'policy' : 'normal';

    // 2) 컨텍스트 (route.ts와 동일)
    const routing = await routeQuery(q, ROLE);
    const budgeted = await enforceContextBudget(q, routing.contexts, complexityBudget(q));
    const numbered = buildNumberedContexts(budgeted);

    // 3) 파이프라인별 프롬프트/도구 (route.ts와 동일 분기)
    let system: unknown;
    let tools: unknown;
    if (mode === 'policy') {
      system = buildPolicySystemPrompt(budgeted, ROLE) + WEB_GUIDE_POLICY;
      tools = [WEB_SEARCH_TOOL_POLICY];
    } else {
      const parts = buildSystemPromptParts(budgeted, ROLE);
      system = [
        { type: 'text', text: parts.stable, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: parts.tail + WEB_GUIDE_NORMAL },
      ];
      tools = [WEB_SEARCH_TOOL];
    }
    const userMessage = buildUserMessage(q, numbered.contextMarkdown, numbered.summary);

    // 4) 실제 Sonnet 호출 (non-stream — web_search는 서버측 실행되어 단일 응답에 반영)
    const resp = await client.messages.create({
      model: LLM_MODEL,
      max_tokens: MAX_TOKENS,
      system: system as never,
      messages: [{ role: 'user', content: userMessage }],
      tools: tools as never,
    });

    const u = resp.usage as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; server_tool_use?: { web_search_requests?: number } };
    const webN = u.server_tool_use?.web_search_requests ?? 0;
    const cost = costOf({ input: u.input_tokens, output: u.output_tokens, cacheRead: u.cache_read_input_tokens, cacheWrite: u.cache_creation_input_tokens, web: webN });
    totalCost += cost;
    const answer = resp.content.filter((b): b is { type: 'text'; text: string } => b.type === 'text').map(b => b.text).join('');

    const webFired = webN > 0 ? `🌐 발동(${webN})` : '— 미발동';
    console.log(`\n[${i + 1}] ${quadrant}  →  intent=${decision.agent}(${decision.via})  mode=${mode}  web=${webFired}  $${cost.toFixed(3)}`);
    console.log(`    Q: ${q.slice(0, 60)}`);
    console.log(`    기대: ${expect}`);

    out.push(
      `\n---\n\n## [${i + 1}] ${quadrant}\n`,
      `**질문**: ${q}\n`,
      `- 라우터 판정: \`${decision.agent}\` (${decision.via}) — ${decision.reason}`,
      `- effective mode: \`${mode}\`  ·  web_search: **${webFired}**  ·  비용: **$${cost.toFixed(3)}** (in ${u.input_tokens} / out ${u.output_tokens})`,
      `- 기대: ${expect}\n`,
      `<details><summary>답변 전문</summary>\n\n${answer}\n\n</details>\n`,
    );
  }

  console.log(`\n━━━ 총 비용: $${totalCost.toFixed(3)} (${QUESTIONS.length}질문) ━━━`);
  out.push(`\n---\n\n**총 비용: $${totalCost.toFixed(3)}** (${QUESTIONS.length}질문, 라우터 Haiku 포함)\n`);
  fs.writeFileSync('scripts/test-router-e2e.out.md', out.join('\n'), 'utf-8');
  console.log('✅ scripts/test-router-e2e.out.md');
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
