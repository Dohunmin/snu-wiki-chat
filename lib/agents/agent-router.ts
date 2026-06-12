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
/** college 그룹 신호 — 특정 단과대명(isCollegeReferenced)이 아닌 *그룹 전체* 지칭 범위. */
export type CollegeGroupScope = '단과대' | '대학원' | 'both' | 'none';

/**
 * 통합 쿼리 플랜 — 단일 Haiku 콜(planQuery)이 산출하는 의도 데이터.
 *   흩어진 정규식 분류기(complexity.ts/recency.ts/college-route.ts)를 대체(unified-intent-router).
 */
export interface QueryPlan {
  intent: AgentIntent;                 // 답변 스타일 (fact/insight)
  complexity: 'simple' | 'complex';    // → 컨텍스트 예산 (16k/40k)
  recency: boolean;                    // → 최신 source 주입
  collegeBreadth: CollegeGroupScope;   // → 단과대/대학원 그룹 admit
  collegeAggregate: CollegeGroupScope; // → 그룹 전체 집계 force-select
  resolvedQuery: string;               // 후속질문을 직전 맥락으로 푼 독립형 질문(분류·검색용). 독립적이면 원문 그대로.
  isFollowup: boolean;                 // 직전 맥락에 의존하는 후속질문 여부(이력 로드 신호 — followupRe/매직넘버 대체).
  reason: string;
  via: 'llm' | 'fallback';
}

/** planQuery에 넘기는 직전 대화 턴(맥락 해소용). */
export type ChatTurn = { role: 'user' | 'assistant'; content: string };

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

/** 토큰 사용량 누적기 — 측정 스크립트(shadow-intent 등)가 실비용 산정에 사용. 프로덕션 동작엔 무영향. */
export const routerUsage = { calls: 0, inputTokens: 0, outputTokens: 0 };
function recordUsage(u: { input_tokens: number; output_tokens: number }) {
  routerUsage.calls++;
  routerUsage.inputTokens += u.input_tokens;
  routerUsage.outputTokens += u.output_tokens;
}

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
    recordUsage(resp.usage);
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

// ─── unified-intent-router: 통합 QueryPlan (planQuery) ──────────────────────────
// routeToAgent(위 ROUTER_SYSTEM)는 flag OFF(shadow) 동안 라이브 intent→mode를 *불변*으로 유지(회귀 0).
// planQuery(아래 PLAN_SYSTEM)는 INTENT_PLAN_ENABLED=ON일 때 라이브 소비 + offline shadow 비교용.
//   cutover(검증 후) 시 routeToAgent/ROUTER_SYSTEM/extractAgent 은퇴 → planQuery 단일화.

const PLAN_SYSTEM = `당신은 서울대 거버넌스 챗봇의 *질문 분석기*입니다. 질문을 읽고 아래 5개 항목을 JSON 한 줄로 판정하세요.

═══ 1) intent — 답변 방식 (fact / insight) ═══
⚠️ 데이터가 내부에 있냐 / 웹이 필요하냐는 **기준 아님**. "웹 필요해 보인다"는 이유로 insight 금지.
- **fact**: 내부 자료로 *직접 찾아 보고·나열·비교*하면 되는 질문(자료가 곧 답). 구체적 사실의 연관성·차이·패턴 *보고*, 이슈·현황·연혁의 *단순 보고*도 fact.
  예: "2026 예산은?", "이사회 안건 종류", "법인화 후 재정구조 변화", "인문대 이슈 알려줘", "역대 총장 전공과 사업의 연관성".
- **insight**: 사실을 *해석·판단·진단·제안*하거나, **외부 정보**(외부 시선·여론·언론 언급·타 대학/기관 비교)가 필요한 질문. 자료로 답돼도 해석/판단/원인/제안이면 insight.
  예: "예산 늘릴 방안?", "~가능할까?", "종합대학 체계가 최선인가", "어떻게 개선해야 하나", "채용 어려운 이유/원인", "외부에서 서울대를 보는 시선·부정 언급", "인문대와 사회대 입장 차이".
  ⭐ 이유·원인·의미·의의를 묻는 건 "~는 무엇인가"로 끝나도 insight. 외부 정보 필요시 insight. 애매하면 insight.

═══ 2) complexity — 필요한 자료 범위 (simple / complex) ═══
- "simple": 단일 사실 조회(무엇/얼마/언제/누구·짧은 목록·연락처), 또는 단일 주제 이슈·현황을 *나열·보고*만 요구(분석·비교·인과 없음). 예: "2026 예산은?", "이사회 안건 종류", "인문대 이슈 알려줘".
- "complex": 분석·종합·비교·다면적·여러 물음. 예: "원인이 뭐야", "개선 방안", "A와 B 비교", "정리해줘", "각 단과대별 ~", "재정구조 어떻게 변했나? 재원구성 변화는?".
  애매하면 complex.

═══ 3) recency — 최신성 (true / false) ═══
질문에 **명시적 시간어**(최근·최신·올해·이번·지금·현재·작년·N년·요즘)가 있을 때만 true. "이슈·내용·현황·정보 알려줘"처럼 시간어 없이 일반 조회면 **false**(최신성 임의 추론 금지). "역대·과거·연혁" 등 과거지향도 false.

═══ 4) collegeBreadth — 단과대/대학원 그룹 전체 지칭 ("단과대"|"대학원"|"both"|"none") ═══
특정 단과대명(공대·경영대 등)을 콕 집지 않고 *그룹 전체*를 가리키나.
- "단과대": "전공 추천", "각 학과", "계열별", "단과대 현안".  "대학원": "대학원별", "전문대학원 종류".  "both": 둘 다.
- "none": 특정 단과대명만 있거나("공대 소개"), 거버넌스 질문("역대 총장", "서울대 재정").

═══ 5) collegeAggregate — 그룹 전체 집계 ("단과대"|"대학원"|"both"|"none") ═══
*모든/각/전체/~별*로 그룹을 한 번에 집계해 묻나.
- "단과대": "각 단과대별 학과", "모든 단과대 비교", "단과대별 정원".  "대학원": "대학원별 교과", "각 대학원 정원".  "none": 집계 아니면.
(aggregate가 특정 그룹이면 collegeBreadth도 같은 그룹으로 설정.)

═══ 6) standalone — 독립형 질문 + isFollowup ═══
직전 대화가 함께 주어질 수 있다. 현재 질문이 지시어("그거/위/더 자세히/외부 자료")나 생략된 주어로 **직전 맥락에 의존**하면, 직전 대화를 근거로 **혼자 읽어도 뜻이 통하는 완결된 질문**으로 다시 써서 standalone에 넣고 isFollowup=true. 이미 독립적이면 standalone에 **현재 질문 원문 그대로**, isFollowup=false. (intent·complexity 등 1~5도 standalone 기준으로 판정.)
⭐ 후속이 *측면·항목만* 바꾸고(소개→대학원/예산/입시/연혁 등) 대상을 새로 명시하지 않으면, **직전 대상(주어·조직·연도)을 그대로 유지**해 채운다 — 임의로 일반화·확대 금지.
  예: [직전: 이석재 이사 소개] "외부 자료 확인해" → "이석재 이사의 전공·학문적 배경·교수경력을 외부 자료로 확인"(isFollowup:true).
  예: [직전: 공과대학 소개] "대학원은?" → "공과대학 대학원 소개"(isFollowup:true, 대상 '공대' 유지).

출력(엄수): JSON 한 줄만. 코드펜스/다른 텍스트 금지. standalone을 맨 앞에. reason은 20자 이내.
예: {"standalone":"2026년 예산은?","isFollowup":false,"intent":"fact","complexity":"simple","recency":false,"collegeBreadth":"none","collegeAggregate":"none","reason":"단일 사실 조회"}
예: {"standalone":"이석재 이사의 학문적 배경을 외부 자료로 확인","isFollowup":true,"intent":"insight","complexity":"complex","recency":false,"collegeBreadth":"none","collegeAggregate":"none","reason":"외부 정보 필요"}`;

/** Haiku 실패 시 안전 디폴트 — 과잉서빙(무해) 방향(harm-asymmetry). */
export function defaultPlan(query = ''): QueryPlan {
  return {
    intent: 'insight', complexity: 'complex', recency: false,
    collegeBreadth: 'none', collegeAggregate: 'none',
    resolvedQuery: query, isFollowup: false,   // 실패 시 원문 검색 + 이력 미강제(회귀 0)
    reason: '분류 실패 → 안전 디폴트', via: 'fallback',
  };
}

const SCOPE_VALUES = new Set<CollegeGroupScope>(['단과대', '대학원', 'both', 'none']);
function extractScope(text: string, key: string): CollegeGroupScope {
  const v = text.match(new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`))?.[1] as CollegeGroupScope | undefined;
  return v && SCOPE_VALUES.has(v) ? v : 'none';
}

/**
 * 단일 Haiku 콜 → QueryPlan. intent 추출 성공 시 나머지는 필드별 robust 추출(누락→필드별 안전값),
 *   실패/타임아웃 시 defaultPlan. (필드별 추출 = reason 잘림에도 핵심 복원, 한 필드 실패가 전체 fallback 강제 안 함.)
 */
export async function planQuery(query: string, recentTurns: ChatTurn[] = []): Promise<QueryPlan> {
  // 직전 대화 동봉(맥락 해소) — Anthropic은 첫 메시지가 user여야 함 → 선두 assistant 제거.
  const turns = recentTurns.slice();
  while (turns.length && turns[0].role !== 'user') turns.shift();
  try {
    const resp = await getAnthropicClient().messages.create(
      {
        model: LLM_MODEL_LIGHT,
        max_tokens: 320,   // standalone(완결질문) 추가분 — 절단 방지
        temperature: 0,
        system: PLAN_SYSTEM,
        messages: [...turns, { role: 'user', content: query }],
      },
      { timeout: ROUTER_TIMEOUT_MS, maxRetries: 1 },
    );
    recordUsage(resp.usage);
    const text = resp.content.find((b): b is { type: 'text'; text: string } => b.type === 'text')?.text ?? '';
    const intent = text.match(/"intent"\s*:\s*"(fact|insight)"/)?.[1];
    if (intent === 'fact' || intent === 'insight') {
      const cx = text.match(/"complexity"\s*:\s*"(simple|complex)"/)?.[1];
      const standalone = text.match(/"standalone"\s*:\s*"([^"]*)"/)?.[1]?.trim();
      return {
        intent,
        complexity: cx === 'simple' ? 'simple' : 'complex',   // 안전디폴트 complex
        recency: /"recency"\s*:\s*true/.test(text),
        collegeBreadth: extractScope(text, 'collegeBreadth'),
        collegeAggregate: extractScope(text, 'collegeAggregate'),
        resolvedQuery: standalone && standalone.length > 0 ? standalone : query,  // 누락·빈값이면 원문(회귀 0)
        isFollowup: /"isFollowup"\s*:\s*true/.test(text),
        reason: text.match(/"reason"\s*:\s*"([^"]*)"/)?.[1] ?? '',
        via: 'llm',
      };
    }
    console.error('[plan] intent 추출 실패 → 안전 디폴트. raw:', text.slice(0, 120));
  } catch (err) {
    console.error('[plan] LLM 분류 실패/타임아웃 → 안전 디폴트:', err);
  }
  return defaultPlan(query);
}
