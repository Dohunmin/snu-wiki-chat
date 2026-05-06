import path from 'path';
import fs from 'fs';
import type { AgentContext } from './types';
import type { Role } from '@/lib/auth/roles';
import { registry } from './registry';
import { WikiAgent } from './wiki-agent';
import agentsConfig from '@/data/agents.config.json';

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

export async function routeQuery(query: string, userRole: Role): Promise<RoutingResult> {
  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/[\s,]+/).filter(w => w.length >= 2);
  const globalKeywords: string[] = agentsConfig.routing.globalKeywords;
  const agents = registry.getAll();

  // === Tier 0: 글로벌 키워드 → 전체 위키 full coverage ===
  const tier1Matches = agents.filter(agent =>
    agent.config.keywords.some(kw => queryLower.includes(kw.toLowerCase()))
  );
  const hasGlobalKeyword = globalKeywords.some(kw => queryLower.includes(kw));
  if (hasGlobalKeyword && tier1Matches.length === 0) {
    const contexts = await Promise.all(
      agents.map(a => a.getContext(query, userRole, true))
    );
    return { selectedAgentIds: contexts.map(c => c.agentId), contexts, isGlobal: true };
  }

  // === Stage 1: 각 에이전트 prefilter 점수 계산 ===
  const scored = agents
    .map(agent => ({ agent, score: prefilterScore(agent, queryWords) }))
    .sort((a, b) => b.score - a.score);

  // === Concept Index 조회 → forced wikis + guaranteed pages ===
  const { forcedWikis, guaranteedPages } = lookupConceptIndex(queryWords);

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
  }).slice(0, MAX_WIKIS);

  const finalSelected = selected.length > 0 ? selected : scored.slice(0, MAX_WIKIS);

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
