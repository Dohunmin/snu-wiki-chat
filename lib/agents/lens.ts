/**
 * Candidate Lens — 인물 시각 기반 분석 모드
 *
 * 일반 라우팅에서 분리된 lensPersona 위키를 lens 모드 전용으로 로드한다.
 * admin 외 호출 시 항상 null 반환 (서버 가드 다층 방어).
 */

import path from 'path';
import fs from 'fs';
import type { WikiData, AgentConfig, AgentContext } from './types';
import type { Role } from '@/lib/auth/roles';
import { canAccessSensitive } from '@/lib/auth/roles';
import agentsConfig from '@/data/agents.config.json';
// Phase C — Lens RAG: 의미 매칭으로 stance 회수 (키워드만으론 동의어/은유 놓침)
import { searchVector } from '@/lib/embed/search';
import { rrfFuse } from '@/lib/embed/rrf';
import type { KeywordRankedChunk } from '@/lib/embed/types';

export interface PersonaContext {
  id: string;
  name: string;
  displayName: string;
  /** 매칭된 stance 항목들 (점수순) */
  stances: Array<{
    id: string;
    title: string;
    holder: string;
    topic: string;
    content: string;
    score: number;
  }>;
  /** LLM 시스템 프롬프트에 삽입할 stance 텍스트 블록 */
  stanceBlock: string;
  /** 매칭된 stance 자료가 0개일 때 true → 답변에 한계 명시 */
  insufficient: boolean;
}

const STANCE_LIMIT = 8;
const MIN_SCORE = 1;

export function getPersonaConfig(personaId: string): AgentConfig | null {
  const agents = agentsConfig.agents as AgentConfig[];
  return agents.find(
    a => a.lensPersona && a.personaId === personaId && a.enabled,
  ) ?? null;
}

export async function loadPersonaContext(
  personaId: string,
  query: string,
  userRole: Role,
): Promise<PersonaContext | null> {
  // 다층 가드 #1: admin이 아니면 무조건 차단
  if (userRole !== 'admin') return null;

  const config = getPersonaConfig(personaId);
  if (!config) return null;

  const filePath = path.join(process.cwd(), 'data', config.dataFile);
  if (!fs.existsSync(filePath)) return null;

  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as WikiData;
  const isSensitiveAllowed = canAccessSensitive(userRole);

  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/[\s,]+/).filter(w => w.length >= 2);

  const allowedStances = (data.stances ?? []).filter(
    s => isSensitiveAllowed || !s.sensitive,
  );

  // 1단계 — 키워드 빈도 + topic/title 가산점으로 스코어링
  const keywordScored = allowedStances
    .map(s => {
      let score = 0;
      const text = `${s.title} ${s.topic} ${s.content}`.toLowerCase();
      for (const w of queryWords) {
        const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        score += (text.match(new RegExp(escaped, 'g')) ?? []).length;
      }
      // topic 직접 매칭 강조
      if (queryWords.some(w => s.topic.toLowerCase().includes(w))) score += 5;
      if (queryWords.some(w => s.title.toLowerCase().includes(w))) score += 3;
      return { s, score };
    })
    .sort((a, b) => b.score - a.score);

  // 2단계 — RAG 활성화 시 벡터 검색 + RRF 융합 (의미적 매칭으로 동의어/은유 회수)
  // 예: "교원 보수" ↔ "재정 운영 철학" 같은 의미 매칭은 키워드만으론 못 잡음
  let finalScored: typeof keywordScored;

  if (config.ragEnabled) {
    try {
      // 벡터 검색 — leesj 위키만, stance 타입만 필터링
      const vectorAll = await searchVector(query, config.id, userRole, 30);
      const vectorStances = vectorAll.filter(v => v.pageType === 'stance');

      // RRF 입력 형식으로 변환
      const keywordInput: KeywordRankedChunk[] = keywordScored
        .filter(({ score }) => score > 0)  // score 0은 명백히 무관
        .map(({ s, score }) => ({
          type: 'stance' as const,
          id: s.id,
          title: s.title,
          chunk: s.content,
          score,
        }));

      // RRF 융합 — STANCE_LIMIT(8)개로 제한
      const fused = rrfFuse(keywordInput, vectorStances, { k: 60, limit: STANCE_LIMIT });

      if (process.env.RAG_DEBUG === 'true') {
        console.log(
          `[Lens RAG ${config.id}] kw:${keywordInput.length} vec:${vectorStances.length} → fused:${fused.length}`,
        );
      }

      // fused 결과를 keywordScored 형식({s, score})으로 복원
      const stanceMap = new Map(allowedStances.map(s => [s.id, s]));
      finalScored = fused
        .map(f => {
          const stance = stanceMap.get(f.id);
          return stance ? { s: stance, score: f.score } : null;
        })
        .filter((x): x is { s: typeof allowedStances[number]; score: number } => x !== null);
    } catch (err) {
      // Fallback: 벡터 검색 실패 시 키워드 결과만 사용
      console.error(`[Lens RAG ${config.id}] vector search failed, falling back to keyword:`, err);
      finalScored = keywordScored.filter(({ score }) => score >= MIN_SCORE).slice(0, STANCE_LIMIT);
    }
  } else {
    // RAG 비활성 — 기존 키워드 단독 (PoC 호환)
    finalScored = keywordScored.filter(({ score }) => score >= MIN_SCORE).slice(0, STANCE_LIMIT);
  }

  const scored = finalScored;

  const stanceBlock = scored
    .map(
      ({ s }) =>
        `## [${data.name}-stance] ${s.title} (${s.id}) | topic: ${s.topic}\n${s.content}`,
    )
    .join('\n\n---\n\n');

  return {
    id: personaId,
    name: data.name,
    displayName: config.displayName ?? data.name,
    stances: scored.map(({ s, score }) => ({
      id: s.id,
      title: s.title,
      holder: s.holder,
      topic: s.topic,
      content: s.content,
      score,
    })),
    stanceBlock,
    insufficient: scored.length === 0,
  };
}

/**
 * persona의 stance를 번호 인용(buildNumberedContexts)에 태울 AgentContext로 변환.
 *
 * 헤더를 `## [stance] {title} ({id}) | topic: {topic}` 형식으로 렌더 → buildNumberedContexts가
 *   다른 위키 source와 동일하게 [N] 번호를 부여하고, stance id가 `.stance`로 끝나므로
 *   resolveText가 `/wiki?agent=leesj&type=stances&id=...` 클릭 링크로 변환한다.
 *   (기존 stanceBlock=`[이름-stance]` raw 형식은 번호 매핑에 없어 [N] 불가 → 옛 형식 인용으로 흐르던 문제 해결.)
 * 매칭 stance 0개면 null(insufficient).
 */
export function personaToContext(persona: PersonaContext): AgentContext | null {
  if (persona.stances.length === 0) return null;
  const relevantData = persona.stances
    .map((s) => `## [stance] ${s.title} (${s.id}) | topic: ${s.topic}\n${s.content}`)
    .join('\n\n---\n\n');
  return {
    agentId: persona.id,
    agentName: persona.name,
    relevantData,
    sources: persona.stances.map((s) => ({ wiki: persona.name, page: s.id, topic: s.topic })),
    confidence: 0.9,
  };
}
