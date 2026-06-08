/**
 * 상위 라우터 (multi-agent-workflow plan §5 Phase 3) — 질문을 어느 하위 에이전트로 배정할지 LLM(Haiku)이 판단.
 *
 * fact    = 자료에 있는 사실을 찾아 보고·요약·비교 (사실이 답).
 * insight = 사실을 넘어 분석·진단·제안·전망·찬반·평가를 요구.
 * (framing 등은 하위 에이전트 생기면 케이스 추가.)
 *
 * 정확성이 관건(D3) → 키워드보다 의도를 이해하는 LLM. Haiku라 ~$0.001/쿼리.
 * 실패(파싱불가/타임아웃) 시 insight 기본값 — harm-asymmetry: 과잉서빙(fact→insight)은 무해, 빈약화(insight→fact)는 손해.
 *   (키워드 분류기는 제거됨 — 진단상 fact 편향 + "이유는 무엇=insight" 안티룰로 네 라우터 규칙과 충돌했음.)
 */
import { getAnthropicClient, LLM_MODEL_LIGHT } from '@/lib/llm/client';

export type AgentIntent = 'fact' | 'insight';

const ROUTER_SYSTEM = `당신은 서울대 거버넌스 챗봇의 *질문 분류기*입니다. 질문의 **답변 방식**을 두 유형으로 분류하세요.
⚠️ 데이터가 내부 자료에 있냐 / 외부 웹검색이 필요하냐는 **분류 기준이 아닙니다** — 그건 답변 에이전트가 따로 판단합니다. "웹이 필요해 보인다"는 이유로 insight로 분류하지 마세요.

- **fact**: 사실을 *직접 찾아 보고·나열·비교*하면 되는 질문 (자료가 곧 답). **외부 사실 조회도 fact**(외부 시선·타 대학·언론 — 웹 필요해도 *보고*면 fact). *구체적 사실*의 연관성·차이·패턴을 *보고*하는 것도 fact.
  예: "2026 예산은?", "이사회 안건 종류", "법인화 후 재정구조 변화", "외부에서 서울대 보는 시선·부정 언급"(웹 필요하지만 fact), "역대 총장 전공과 사업의 연관성"(데이터 보고), "SNU홀딩스와 기술지주 차이"(조직 차이 보고), "일관되게 유지해온 정책은 무엇인가"(패턴 보고).
- **insight**: 사실을 *해석·판단·진단·제안*하도록 요구하는 질문. ⭐ **자료로 답할 수 있어도(웹 불필요해도) 해석/판단/원인/제안을 요구하면 insight.**
  예: "예산 늘릴 방안 그 외 없을까?", "~가능할까?", "종합대학 체계가 *최선인가*", "어떻게 *개선해야* 하나", "채용이 어려운 *이유/원인*"(진단), "X와 Y가 *무슨 상관*?"(의미 해석), "권한 행사하는 것 *아니야?*"(비판·판단), "인문대와 사회대 거버넌스 *입장 차이*"(관점 해석).

판단 기준:
1. **"무엇/얼마/어떤 것들/구체적 차이·연관성/패턴을 *보고*" → fact** (복잡·웹 필요해도).
2. **"왜/이유/원인/무슨 의미·상관/맞나·아니야/어떻게 해야/제안/전망/관점 차이 해석" → insight** (자료로 답 되어도, 웹 불필요해도).
   ⭐ *이유·원인·의미·의의*를 묻는 질문은 **"~는 무엇인가"로 끝나도 insight** (묻는 대상이 사실이 아니라 *해석/진단*이므로). 예: "일괄 운영하는 *이유는 무엇인가*"=insight.
3. **애매하면 → insight** (분석 원하는 걸 fact로 보내면 빈약해 *나쁘고*, 반대는 풍부할 뿐 *무해*).

출력 형식(엄수): JSON 한 줄만. 마크다운 코드블록/펜스로 감싸지 말 것. JSON 앞뒤에 다른 텍스트 금지. reason은 30자 이내로 짧게.
예: {"agent":"insight","reason":"원인 진단 요구"}`;

export interface RouteDecision { agent: AgentIntent; reason: string; via: 'llm' | 'fallback'; }

// 라우터는 매 채팅의 임계경로 → 행(hang)이 곧 채팅 멈춤. 빠른 실패 후 키워드 fallback이 안전.
const ROUTER_TIMEOUT_MS = 4000;

/**
 * Haiku 응답에서 agent 값을 직접 추출 — reason이 max_tokens로 잘려 닫는 }가 없어도 잡힌다.
 *   (진단: 과거 silent fallback의 100%가 "긴 reason 잘림 → 완전한 {} 없음 → 정규식 실패"였음.
 *    agent 값 자체는 응답 앞부분에 멀쩡히 있었으므로 필드 직접 추출이 견고함.)
 */
function extractAgent(text: string): AgentIntent | null {
  const m = text.match(/"agent"\s*:\s*"(fact|insight)"/);
  return m ? (m[1] as AgentIntent) : null;
}

/** Haiku로 질문 의도 분류 → 하위 에이전트 배정. 실패 시 insight 기본값(harm-asymmetry). */
export async function routeToAgent(query: string): Promise<RouteDecision> {
  try {
    const resp = await getAnthropicClient().messages.create(
      {
        model: LLM_MODEL_LIGHT,
        max_tokens: 80,
        temperature: 0,
        system: ROUTER_SYSTEM,
        messages: [{ role: 'user', content: query }],
      },
      { timeout: ROUTER_TIMEOUT_MS, maxRetries: 1 },
    );
    const text = resp.content.find((b): b is { type: 'text'; text: string } => b.type === 'text')?.text ?? '';
    const agent = extractAgent(text);
    if (agent) {
      const reason = text.match(/"reason"\s*:\s*"([^"]*)"/)?.[1] ?? '';
      return { agent, reason, via: 'llm' };
    }
    console.error('[router] agent 추출 실패 → insight 기본값. raw:', text.slice(0, 120));
  } catch (err) {
    console.error('[router] LLM 분류 실패/타임아웃 → insight 기본값:', err);
  }
  return { agent: 'insight', reason: '분류 실패 → insight 기본값', via: 'fallback' };
}
