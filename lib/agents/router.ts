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
  const [conceptResult, semantic] = await Promise.all([
    Promise.resolve(lookupConceptIndex(queryWords)),
    // hints(강제 포함 후보) + 전체 위키 거리(distances, chunk 예산 가중 분배용)
    semanticRoutingHints(query, userRole, { maxWikis: 5, absoluteMax: 1.0, tightMax: 0.85 }),
  ]);
  const { guaranteedPages } = conceptResult;
  const semanticDist = semantic.distances;
  // forcedWikis = concept-index hits + semantic routing hints (union)
  //   단, 라우팅 가능한 위키(getRoutableAgents)에 한정 — adminOnly/lensPersona 자동 제외
  const routableIds = new Set(agents.map(a => a.config.id));
  const forcedWikis = new Set<string>();
  for (const w of conceptResult.forcedWikis) if (routableIds.has(w)) forcedWikis.add(w);
  for (const w of semantic.hints) if (routableIds.has(w)) forcedWikis.add(w);

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

  // === Stage 2: 신뢰도 가중 chunk cap 분배 ===
  // 균등 분배(이전: 모두 floor 5) 대신, 임베딩 근접도 + 키워드 점수가 높은 위키에 예산을 더 배정.
  //   → 관련 위키가 더 풍부한 컨텍스트 확보(답변 품질↑), 한계 위키도 CAP_FLOOR로 유지(recall 보존).
  const refCount = finalSelected.filter(s => s.agent.config.alwaysContext).length;
  const normalWikis = finalSelected.filter(s => !s.agent.config.alwaysContext);
  const budget = TOTAL_CHUNK_BUDGET - refCount * ALWAYS_CONTEXT_CAP;
  const CAP_FLOOR = 3;     // 선택된 위키 최소 보장 청크 (recall)
  const CAP_MAX = 25;      // 한 위키 독점 방지 (= MAX_CHUNKS_RAG)
  const TEMP = 0.07;       // 임베딩 거리 softmax 온도 (작을수록 최상위에 집중)
  const KW_COEF = 0.4;     // 키워드 가중치 비중 (임베딩이 주, 키워드는 보조)

  const knownDists = normalWikis
    .map(s => semanticDist.get(s.agent.config.id))
    .filter((d): d is number => typeof d === 'number');
  const minDist = knownDists.length > 0 ? Math.min(...knownDists) : 0;
  const maxScore = Math.max(1, ...normalWikis.map(s => s.score));

  // 가중치 = 임베딩 근접(softmax, 주) + 키워드(정규화, 보조) — 둘 중 하나만 강해도 예산 확보(하이브리드)
  const weights = normalWikis.map(s => {
    const d = semanticDist.get(s.agent.config.id);
    const emb = typeof d === 'number' ? Math.exp(-(d - minDist) / TEMP) : 0.2;
    const kw = s.score / maxScore;
    return Math.max(emb + KW_COEF * kw, 0.05);
  });
  const sumW = weights.reduce((a, b) => a + b, 0) || 1;

  const capByWiki = new Map<string, number>();
  normalWikis.forEach((s, i) => {
    const raw = Math.round((budget * weights[i]) / sumW);
    // 다중 위키 대비: concept-index(정밀 큐레이션) 또는 키워드 강한 위키는 임베딩이 멀어도 floor 상향
    //   → 다중-위키 질문의 2번째 위키(키워드/개념으로 잡힌)가 충분한 컨텍스트 확보.
    //   (느슨한 의미-forcing(tightMax)은 제외 — noise까지 floor 받아 컨텍스트 비대해짐)
    const relevant = conceptResult.forcedWikis.has(s.agent.config.id) || s.score >= MIN_ABSOLUTE_SCORE;
    const floor = relevant ? CAP_FLOOR + 2 : CAP_FLOOR;
    capByWiki.set(s.agent.config.id, Math.min(CAP_MAX, Math.max(floor, raw)));
  });

  const contexts = await Promise.all(finalSelected.map(s =>
    s.agent.getContext(query, userRole, hasGlobalKeyword, {
      chunkCap: s.agent.config.alwaysContext
        ? ALWAYS_CONTEXT_CAP
        : (capByWiki.get(s.agent.config.id) ?? CAP_FLOOR),
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
