/**
 * Retrieval Confidence Gate — 게이트형 LLM 평가자 (4-way verdict).
 *
 * plan: docs/01-plan/features/retrieval-confidence-gate.plan.md §10~§11
 *   - 질문 + 검색된 컨텍스트(원문)만 근거로 per-aspect 판정 → 다중위키의 부실 축을 missing에 노출
 *   - verdict 4-way = 답변 전략 디스패처(answerable/opinion-grounded/external-needed/internal-gap)
 *   - grounding(자료 밖 지식 금지) + 동의어 인정
 *   - §11.1 PARSE_FAIL 대응: 코드펜스 금지 + 넉넉한 max_tokens + 견고 파싱
 *
 * 아직 chat 흐름에 배선하지 않음 — gold-set 검증(scripts/eval-gold.ts) 통과 후 라우팅에 연결.
 */
import { getAnthropicClient } from '@/lib/llm/client';
import type { AgentContext } from './types';

export const EVALUATOR_MODEL = 'claude-haiku-4-5-20251001';

export type Verdict = 'answerable' | 'opinion-grounded' | 'external-needed' | 'internal-gap';
export type Coverage = 'yes' | 'partial' | 'no';

export interface AspectJudgment {
  aspect: string;
  covered: Coverage;
}

export interface EvaluatorResult {
  verdict: Verdict;
  aspects: AspectJudgment[];
  missing: string[];
  /** 파싱 실패·모델 오류 시 true (게이트는 보수적으로 통과시켜야 함) */
  failed?: boolean;
  raw?: string;
}

const VERDICTS: Verdict[] = ['answerable', 'opinion-grounded', 'external-needed', 'internal-gap'];

function buildEvaluatorPrompt(question: string, contextText: string): string {
  return `당신은 서울대학교 거버넌스 위키 챗봇의 "검색 평가자"입니다.
사용자 질문과 검색된 위키 자료(컨텍스트)를 보고, **이 자료만으로** 질문에 답할 수 있는지 분류하세요.

[엄격한 규칙]
- 오직 아래 컨텍스트만 근거로 판단하세요. 당신이 따로 아는 외부 지식은 절대 쓰지 마세요.
- 표현 차이는 같은 것으로 인정하세요(예: "장학금"≈"학생경비", "정부출연금"≈"국고지원금").
- 질문을 정보 요소(aspect) 1~4개로 분해하고, 각 요소가 컨텍스트에서 다뤄지는지 yes/partial/no로 판정하세요.

[verdict — 정확히 하나. 반드시 위 aspect 커버리지와 일관되게 결정]
- answerable: 핵심 aspect 대부분이 yes. 컨텍스트가 질문의 핵심 사실을 직접 답함(사실 조회형).
- opinion-grounded: yes/partial aspect가 있으나(관련 사실은 컨텍스트에 존재), 질문의 핵심이 의견·제안·평가·전망·진단 등 기록에 없는 판단을 요구함(사실로 근거는 제시 가능).
- external-needed: 핵심이 **서울대 자체 기록으로는 결코 답할 수 없는 외부 정보**를 요구함. 즉 답을 채우려면 *다른 기관·외부 순위·시장/언론* 자료가 반드시 있어야 함.
    예) "카이스트와 비교", "QS 세계대학 순위", "최근 언론 보도/외부 평판".
    ⚠️ 서울대 자신의 재정·계획·회의·전략처럼 **원래 서울대 위키가 담을 영역인데 자료가 불완전한** 경우는 external-needed가 아닙니다 → opinion-grounded(판단형) 또는 answerable(사실형).
- internal-gap: **거의 모든 aspect = no**. 관련 사실이 컨텍스트에 사실상 전혀 없는 진짜 공백.

⚠️ 결정 규칙(엄수):
  1. aspect 중 yes/partial이 **하나라도** 있으면 internal-gap 금지.
  2. 빠진 정보가 *서울대 내부 영역*(자체 재정·계획·회의·전략·인사 등)이면 external-needed 금지 → 핵심이 판단·제안이면 opinion-grounded, 사실 조회면 answerable.
  3. external-needed는 빠진 핵심이 *타기관/외부순위/시장·언론* 등 서울대 기록 밖일 때만.
  4. internal-gap은 모든(혹은 거의 모든) aspect=no일 때만.
  5. **확인된 부재(grounded negative)는 answerable**: 관련 기록이 컨텍스트에 충분히 있고 그 기록이 "그런 사례/항목이 없음"을 *확인*해 주면, 그 aspect는 covered=yes 이고 verdict는 answerable 입니다.
     (예: "부결된 안건?" → 이사회 기록 다수가 있고 모두 의결/보류/철회뿐이라 부결이 없음을 확인 가능 → answerable, internal-gap 아님.)
     단순히 "그 항목이 컨텍스트에 안 보임"과 "기록은 있는데 그 항목이 없음을 확인"은 다릅니다 — 후자만 grounded negative.

[출력] 아래 JSON 한 개만 출력하세요. 코드펜스(\`\`\`)·설명·서론 없이 '{' 로 시작하세요.
{"aspects":[{"aspect":"요소 요약","covered":"yes|partial|no"}],"verdict":"answerable|opinion-grounded|external-needed|internal-gap","missing":["컨텍스트에 없는 요소"]}

[질문]
${question}

[검색된 컨텍스트]
${contextText}`;
}

/** 코드펜스/서론이 섞여도 첫 번째 균형 잡힌 JSON 객체를 추출 */
export function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null; // 미완결(절단) — 파싱 실패로 처리
}

function coerce(parsed: unknown, raw: string): EvaluatorResult {
  const obj = (parsed ?? {}) as Record<string, unknown>;
  const verdict = VERDICTS.includes(obj.verdict as Verdict) ? (obj.verdict as Verdict) : null;
  const aspectsRaw = Array.isArray(obj.aspects) ? obj.aspects : [];
  const aspects: AspectJudgment[] = aspectsRaw
    .map((a) => {
      const o = (a ?? {}) as Record<string, unknown>;
      const cov = ['yes', 'partial', 'no'].includes(o.covered as string) ? (o.covered as Coverage) : 'no';
      return { aspect: String(o.aspect ?? '').slice(0, 200), covered: cov };
    })
    .filter((a) => a.aspect);
  const missing = (Array.isArray(obj.missing) ? obj.missing : [])
    .map((m) => String(m).slice(0, 200))
    .filter(Boolean);

  if (!verdict) {
    return { verdict: 'answerable', aspects, missing, failed: true, raw };
  }
  // 일관성 안전망(사용자 규칙): internal-gap인데 yes/partial aspect가 있으면 진짜 공백이 아님
  //   → opinion-grounded로 보정 (관련 사실은 있으나 핵심은 판단·기록밖). plan §11.2.
  if (verdict === 'internal-gap' && aspects.some(a => a.covered !== 'no')) {
    return { verdict: 'opinion-grounded', aspects, missing };
  }
  return { verdict, aspects, missing };
}

/** 컨텍스트 합치기 — 평가자에 넘길 원문(과대 토큰 방지 cap) */
export function joinContexts(contexts: AgentContext[], capChars = 14000): string {
  if (contexts.length === 0) return '(검색된 자료 없음)';
  const blocks = contexts.map((c) => `### [${c.agentName}]\n${c.relevantData}`);
  const joined = blocks.join('\n\n');
  return joined.length > capChars ? joined.slice(0, capChars) + '\n…(생략)' : joined;
}

export async function evaluateRetrieval(
  question: string,
  contexts: AgentContext[],
): Promise<EvaluatorResult> {
  const contextText = joinContexts(contexts);
  const client = getAnthropicClient();
  try {
    const msg = await client.messages.create({
      model: EVALUATOR_MODEL,
      max_tokens: 1024, // §11.1: 절단 방지 위해 넉넉히
      temperature: 0,   // rag 감사 step0: 게이트 결정론화 — 경계질문 판정 흔들림(노이즈)을 실회귀와 분리
      messages: [{ role: 'user', content: buildEvaluatorPrompt(question, contextText) }],
    });
    const raw = msg.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    const jsonStr = extractJsonObject(raw);
    if (!jsonStr) return { verdict: 'answerable', aspects: [], missing: [], failed: true, raw };
    try {
      return coerce(JSON.parse(jsonStr), raw);
    } catch {
      return { verdict: 'answerable', aspects: [], missing: [], failed: true, raw };
    }
  } catch (err) {
    return {
      verdict: 'answerable',
      aspects: [],
      missing: [],
      failed: true,
      raw: err instanceof Error ? err.message : String(err),
    };
  }
}
