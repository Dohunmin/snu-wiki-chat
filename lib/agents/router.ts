import path from 'path';
import fs from 'fs';
import type { AgentContext } from './types';
import type { Role } from '@/lib/auth/roles';
import { registry } from './registry';
import { WikiAgent } from './wiki-agent';
import agentsConfig from '@/data/agents.config.json';
// Phase B — Semantic Routing (의미 기반 위키 후보 추천)
import { semanticRoutingHints } from '@/lib/embed/search';

export interface RoutingResult {
  selectedAgentIds: string[];
  contexts: AgentContext[];
  isGlobal: boolean;
}

const MIN_ABSOLUTE_SCORE = 3;
const RELATIVE_THRESHOLD = 0.4;
const MAX_WIKIS = 6;
const ALWAYS_CONTEXT_CAP = 5;
const TOTAL_CHUNK_BUDGET = 30;

function prefilterScore(agent: ReturnType<typeof registry.getAll>[0], queryWords: string[]): number {
  let score = 0;
  for (const kw of agent.config.keywords) {
    const kl = kw.toLowerCase();
    if (queryWords.some(w => kl.includes(w) || w.includes(kl))) {
      score += Math.min(kw.length / 2, 5);
    }
  }
  // WikiAgent preScore: entities/topics/stance/fact 메타데이터 스캔
  if (agent instanceof WikiAgent && agent.preScore(queryWords.join(' '), 'admin' as Role)) {
    score += 5;
  }
  return score;
}

function detectScoreGap(scores: number[]): number {
  if (scores.length <= 1) return scores.length;

  let maxGap = 0;
  let maxGapIdx = scores.length;

  for (let i = 0; i < scores.length - 1; i++) {
    const gap = scores[i] - scores[i + 1];
    if (gap > maxGap && scores[i + 1] < MIN_ABSOLUTE_SCORE * 2) {
      maxGap = gap;
      maxGapIdx = i;
    }
  }
  return maxGapIdx;
}

type ConceptEntry = {
  wikis: string[];
  aliases: string[];
  linkedPages: { wiki: string; type: string; id: string }[];
};

let _conceptIndex: Record<string, ConceptEntry> | null = null;

function getConceptIndex(): Record<string, ConceptEntry> {
  if (_conceptIndex) return _conceptIndex;
  const conceptPath = path.join(process.cwd(), 'data', 'concept-index.json');
  if (!fs.existsSync(conceptPath)) return {};
  try {
    _conceptIndex = JSON.parse(fs.readFileSync(conceptPath, 'utf-8'));
    return _conceptIndex!;
  } catch {
    return {};
  }
}

function lookupConceptIndex(queryWords: string[]): {
  forcedWikis: Set<string>;
  guaranteedPages: Map<string, Set<string>>;
} {
  const forcedWikis = new Set<string>();
  const guaranteedPages = new Map<string, Set<string>>();
  const conceptIndex = getConceptIndex();

  for (const [concept, entry] of Object.entries(conceptIndex)) {
    const cl = concept.toLowerCase();
    const matches = queryWords.some(w =>
      cl.includes(w) || w.includes(cl) ||
      entry.aliases.some(a => a.toLowerCase().includes(w) || w.includes(a.toLowerCase()))
    );
    if (matches) {
      for (const wiki of entry.wikis) forcedWikis.add(wiki);
      for (const page of entry.linkedPages) {
        if (!guaranteedPages.has(page.wiki)) guaranteedPages.set(page.wiki, new Set());
        guaranteedPages.get(page.wiki)!.add(page.id);
      }
    }
  }
  return { forcedWikis, guaranteedPages };
}

/** lensPersona는 일반 라우팅에서 항상 제외, adminOnly는 비admin에게 제외 */
function getRoutableAgents(userRole: Role) {
  return registry.getAll().filter(a => {
    if (a.config.lensPersona) return false;
    if (a.config.adminOnly && userRole !== 'admin') return false;
    return true;
  });
}

export async function routeQuery(query: string, userRole: Role): Promise<RoutingResult> {
  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/[\s,]+/).filter(w => w.length >= 2);
  const globalKeywords: string[] = agentsConfig.routing.globalKeywords;
  const agents = getRoutableAgents(userRole);

  // === Tier 0: 글로벌 키워드 → 전체 위키 full coverage ===
  const hasGlobalKeyword = globalKeywords.some(kw => queryLower.includes(kw));
  if (hasGlobalKeyword) {
    const contexts = await Promise.all(
      agents.map(a => a.getContext(query, userRole, true))
    );
    return { selectedAgentIds: contexts.map(c => c.agentId), contexts, isGlobal: true };
  }

  // === Stage 1: 각 에이전트 prefilter 점수 계산 ===
  const scored = agents
    .map(agent => ({ agent, score: prefilterScore(agent, queryWords) }))
    .sort((a, b) => b.score - a.score);

  // === Concept Index + Semantic Routing 병렬 조회 → forced wikis + guaranteed pages ===
  // - lookupConceptIndex: 수동 큐레이션된 cross-wiki 개념 매핑 (즉시)
  // - semanticRoutingHints: 임베딩 기반 의미 매칭 (Phase B, ~80ms)
  //   동의어 의존 쿼리("장학금" ↔ "학생경비")에서 키워드 매칭 약해도
  //   벡터 유사도로 위키를 자동 포함시킴.
  const [conceptResult, semanticHints] = await Promise.all([
    Promise.resolve(lookupConceptIndex(queryWords)),
    // 계층 필터: top-1은 absoluteMax(1.0)면 OK (약한 매칭이라도 살림),
    //           top-2 이후는 tightMax(0.85)인 위키만 (명확한 매칭만 추가)
    semanticRoutingHints(query, userRole, { topK: 50, maxWikis: 5, absoluteMax: 1.0, tightMax: 0.85 }),
  ]);
  const { guaranteedPages } = conceptResult;
  // forcedWikis = concept-index hits + semantic routing hints (union)
  //   단, 라우팅 가능한 위키(getRoutableAgents)에 한정 — adminOnly/lensPersona 자동 제외
  const routableIds = new Set(agents.map(a => a.config.id));
  const forcedWikis = new Set<string>();
  for (const w of conceptResult.forcedWikis) if (routableIds.has(w)) forcedWikis.add(w);
  for (const w of semanticHints) if (routableIds.has(w)) forcedWikis.add(w);

  const topScore = scored[0]?.score ?? 0;
  const relativeThreshold = topScore * RELATIVE_THRESHOLD;
  const gapCutoff = detectScoreGap(scored.map(s => s.score));

  // === 적응형 선택 ===
  const selected = scored.filter((s, i) => {
    if (s.agent.config.alwaysContext) return true;
    if (forcedWikis.has(s.agent.config.id)) return true;
    if (topScore === 0) return true;
    if (s.score < MIN_ABSOLUTE_SCORE) return false;
    if (s.score < relativeThreshold) return false;
    if (i > gapCutoff) return false;
    return true;
  });

  // === MAX_WIKIS cap: forced/always는 우선 보호 ===
  // 기존: selected.slice(0, MAX_WIKIS) — 키워드 점수순으로 잘려 forced 위키가 누락될 수 있음
  // 수정: forcedWikis + alwaysContext 위키가 cap 안에 우선 들어가고, 나머지가 빈 자리 채움
  const forcedAndAlwaysSelected = selected.filter(s =>
    forcedWikis.has(s.agent.config.id) || s.agent.config.alwaysContext,
  );
  const otherSelected = selected.filter(s =>
    !forcedWikis.has(s.agent.config.id) && !s.agent.config.alwaysContext,
  );
  const remainingCapacity = Math.max(0, MAX_WIKIS - forcedAndAlwaysSelected.length);
  const cappedSelected = [
    ...forcedAndAlwaysSelected,        // 모든 forced/always 보존 (cap 초과해도)
    ...otherSelected.slice(0, remainingCapacity),
  ];

  const finalSelected = cappedSelected.length > 0 ? cappedSelected : scored.slice(0, MAX_WIKIS);

  // === Stage 2: chunk cap 분배 ===
  const refCount = finalSelected.filter(s => s.agent.config.alwaysContext).length;
  const normalCount = finalSelected.length - refCount;
  const normalCap = normalCount > 0
    ? Math.max(
        Math.floor((TOTAL_CHUNK_BUDGET - refCount * ALWAYS_CONTEXT_CAP) / normalCount),
        5
      )
    : ALWAYS_CONTEXT_CAP;

  const contexts = await Promise.all(finalSelected.map(s =>
    s.agent.getContext(query, userRole, hasGlobalKeyword, {
      chunkCap: s.agent.config.alwaysContext ? ALWAYS_CONTEXT_CAP : normalCap,
      guaranteedPageIds: guaranteedPages.get(s.agent.config.id),
    })
  ));

  const filteredContexts = contexts.filter(c => c.confidence > 0.3);
  const finalContexts = filteredContexts.length > 0 ? filteredContexts : contexts;

  return {
    selectedAgentIds: finalContexts.map(c => c.agentId),
    contexts: finalContexts,
    isGlobal: false,
  };
}
