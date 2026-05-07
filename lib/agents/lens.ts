/**
 * Candidate Lens — 인물 시각 기반 분석 모드
 *
 * 일반 라우팅에서 분리된 lensPersona 위키를 lens 모드 전용으로 로드한다.
 * admin 외 호출 시 항상 null 반환 (서버 가드 다층 방어).
 */

import path from 'path';
import fs from 'fs';
import type { WikiData, AgentConfig } from './types';
import type { Role } from '@/lib/auth/roles';
import { canAccessSensitive } from '@/lib/auth/roles';
import agentsConfig from '@/data/agents.config.json';

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

  // 쿼리 단어 빈도 + topic 매칭 가산점으로 스코어링
  const scored = allowedStances
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
    .filter(({ score }) => score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, STANCE_LIMIT);

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
