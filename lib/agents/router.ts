import path from 'path';
import fs from 'fs';
import type { AgentContext } from './types';
import type { Role } from '@/lib/auth/roles';
import { registry } from './registry';
import { WikiAgent } from './wiki-agent';
import agentsConfig from '@/data/agents.config.json';
// Phase B — Semantic Routing (의미 기반 위키 후보 추천)
import { semanticRoutingHints } from '@/lib/embed/search';
// Phase 3 — 전역 top-K 검색 (rag-cost-reduction)
import { globalTopK, partitionByWiki } from '@/lib/embed/global-retrieve';
import type { KeywordRankedChunk } from '@/lib/embed/types';
import { detectBreadthIntent } from './recency';
import { isCollegeGroup, isCollegeReferenced, detectGroupBreadth, detectGroupAggregate } from './college-route';
// college-grad-wiki — tier 분류 (T3/T4 게이트)
import { classifyTier, type Tier } from './tier-classifier';
// unified-intent-router — 통합 QueryPlan 소비 (plan?: 있으면 정규식 대체, 없으면 fallback)
import type { QueryPlan, CollegeGroupScope } from './agent-router';

export interface RoutingResult {
  selectedAgentIds: string[];
  contexts: AgentContext[];
  isGlobal: boolean;
  /** college-grad-wiki — 단과대/대학원 위키가 선택됐을 때만 set. 기존 9위키는 undefined. */
  tier?: Tier;
  /** 선택된 college/grad wiki_id (= org.id, e.g. 'eng'). T3/T4 핸들러가 사용. */
  college?: string;
}

const MIN_ABSOLUTE_SCORE = 3;
const RELATIVE_THRESHOLD = 0.4;
const MAX_WIKIS = 6;
// "전체/종합" 글로벌 경로에서 단과대/대학원이 breadth로 admit됐을 때 dispatch 상한.
//   거버넌스(9)는 전부 dispatch하되, 단과대/대학원 28개 전체를 getContext하면 비용·답변 희석 →
//   prefilter 상위 N개로 캡. 집계 레이어는 alwaysContext인 대학현황(status)이 이미 제공.
const GLOBAL_COLLEGE_CAP = 4;
const ALWAYS_CONTEXT_CAP = 5;
const TOTAL_CHUNK_BUDGET = 22;   // 30→22: B-2 가중분배라 하위 청크는 토큰만 먹고 기여 적음(입력 토큰 절감)

/** unified-intent-router: college 그룹 신호(plan)가 특정 그룹을 커버하나. getRoutableAgents/aggregate 공용. */
const coversGroup = (scope: CollegeGroupScope | undefined, grp: '단과대' | '대학원') =>
  scope === grp || scope === 'both';

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

/**
 * lensPersona 항상 제외, adminOnly는 비admin 제외.
 * 단과대/대학원은 두 신호 중 하나면 후보 풀에 admit:
 *   (1) 명시 지칭 — 특정 단과대명/약칭(isCollegeReferenced). 기존 격리 정밀도 유지.
 *   (2) 그룹 breadth — "각 단과대"·"전공"·"대학원별" 등 그룹 전체 지칭(detectGroupBreadth).
 * admit ≠ 강제 선택. 이후 prefilter/semantic/MAX_WIKIS 게이트를 통과해야 실제 라우팅됨.
 *   → 거버넌스 질문(신호 0)은 단과대 전부 제외(오염 0) 그대로, 횡단·집계 질문만 recall 복구.
 */
function getRoutableAgents(userRole: Role, query: string, plan?: QueryPlan) {
  // plan 있으면(flag ON) collegeBreadth/Aggregate 소비, 없으면 정규식 fallback(flag OFF/스크립트).
  const breadth = plan
    ? {
        '단과대': coversGroup(plan.collegeBreadth, '단과대') || coversGroup(plan.collegeAggregate, '단과대'),
        '대학원': coversGroup(plan.collegeBreadth, '대학원') || coversGroup(plan.collegeAggregate, '대학원'),
      }
    : detectGroupBreadth(query);
  return registry.getAll().filter(a => {
    if (a.config.lensPersona) return false;
    if (a.config.adminOnly && userRole !== 'admin') return false;
    if (isCollegeGroup(a.config)) {
      const grp = a.config.group as '단과대' | '대학원';
      if (!isCollegeReferenced(query, a.config) && !breadth[grp]) return false;
    }
    return true;
  });
}

export async function routeQuery(query: string, userRole: Role, plan?: QueryPlan): Promise<RoutingResult> {
  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/[\s,]+/).filter(w => w.length >= 2);
  const globalKeywords: string[] = agentsConfig.routing.globalKeywords;
  const agents = getRoutableAgents(userRole, query, plan);

  // === Tier 0: 글로벌 키워드 → 전체 위키 full coverage ===
  const hasGlobalKeyword = globalKeywords.some(kw => queryLower.includes(kw));
  if (hasGlobalKeyword) {
    // 거버넌스는 전부, 단과대/대학원(breadth로 admit된 경우)은 prefilter 상위 GLOBAL_COLLEGE_CAP개만.
    //   신호 없으면 agents에 단과대가 애초에 없음 → pool == 거버넌스(기존 동작 그대로, 회귀 없음).
    const collegeAgents = agents.filter(a => isCollegeGroup(a.config));
    let pool = agents;
    if (collegeAgents.length > GLOBAL_COLLEGE_CAP) {
      const govAgents = agents.filter(a => !isCollegeGroup(a.config));
      const topColleges = collegeAgents
        .map(a => ({ a, score: prefilterScore(a, queryWords) }))
        .sort((x, y) => y.score - x.score)
        .slice(0, GLOBAL_COLLEGE_CAP)
        .map(x => x.a);
      pool = [...govAgents, ...topColleges];
    }
    const contexts = await Promise.all(
      pool.map(a => a.getContext(query, userRole, true, { recency: plan?.recency }))
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

  // cross-college 집계 질문("각 단과대별 학과") → admit된 그룹 위키 전체를 force-select.
  //   detectGroupBreadth는 admit만 → 특정 단과대명 없는 횡단질문은 점수 게이트서 탈락(데이터 있는데 retrieval 0).
  //   detectGroupAggregate(좁은 명시 집계 신호)일 때만 강제 — forcedWikis는 MAX_WIKIS 초과해도 보존(아래 cap 로직).
  //   크기 제어: enforceContextBudget(예산) + M1 관련도순 렌더가 학과-관련 청크를 상단에 채움.
  const aggregate = plan
    ? { '단과대': coversGroup(plan.collegeAggregate, '단과대'), '대학원': coversGroup(plan.collegeAggregate, '대학원') }
    : detectGroupAggregate(query);
  if (aggregate['단과대'] || aggregate['대학원']) {
    for (const a of agents) {
      if (isCollegeGroup(a.config) && aggregate[a.config.group as '단과대' | '대학원']) {
        forcedWikis.add(a.config.id);
      }
    }
  }

  // === Phase 3: 전역 top-K 검색 (rag-cost-reduction.phase3.design) — flag 게이트 ===
  //   위키 통째 덤프 → 전 코퍼스 청크 top-K. 무관 위키는 dispatch 안 됨(0 토큰).
  //   실패 시 catch → 아래 per-wiki 레거시 경로로 fallback(회귀 안전).
  if (process.env.GLOBAL_TOPK_ENABLED === 'true') {
    try {
      const allowedWikiIds = agents.map(a => a.config.id);   // ★ lensPersona/adminOnly 제외(보안)
      // 키워드 풀: prefilterScore>0 위키들의 keywordCandidates 합집합(희귀 고유명사 recall)
      const keywordPool: KeywordRankedChunk[] = [];
      for (const s of scored) {
        if (s.score <= 0) continue;
        if (s.agent instanceof WikiAgent) {
          keywordPool.push(...s.agent.keywordCandidates(query, userRole, 12, guaranteedPages.get(s.agent.config.id)));
        }
      }
      const chunks = await globalTopK(query, userRole, {
        allowedWikiIds, keywordPool, forceIncludeIds: guaranteedPages,
      });
      const byWiki = partitionByWiki(chunks);
      // dispatch = 전역 등장 위키 ∪ alwaysContext(status)만.
      //   ⚠️ concept-forced 위키는 dispatch 안 함 — guaranteed 페이지는 globalTopK forceIncludeIds로
      //      이미 청크 union됨(중복 방지). 전체 dispatch하면 각자 전체검색 재실행 → over-retrieval 재현(S1서 -8% 원인).
      const dispatch = new Set<string>(byWiki.keys());
      for (const a of agents) {
        if (a.config.alwaysContext) dispatch.add(a.config.id);
      }
      // step3(rag 감사 rank2/3): 폭형 질문("최신 N차"·"시간순 정리"·"모든 기록")은 키워드-매칭 위키를
      //   dispatch에 강제 추가 → cand=[]면 getContext가 full 검색 + recency 주입 실행(7,8차/시간순 처리).
      //   semantic top-K가 폭형을 못 풀어 dispatch에서 누락되던 회귀(eval-gold) 교정.
      //   over-retrieval은 보편 예산(route.ts enforceContextBudget 14k)이 캡 → 비용 안전.
      if (detectBreadthIntent(query)) {
        for (const w of forcedWikis) dispatch.add(w);
        for (const s of scored) {
          if (s.score >= MIN_ABSOLUTE_SCORE) dispatch.add(s.agent.config.id);
        }
      }
      const gCtxs = await Promise.all([...dispatch].map(id => {
        const agent = agents.find(a => a.config.id === id);
        if (!agent) return Promise.resolve(null);
        const cand = byWiki.get(id) ?? [];
        const chunkCap = cand.length > 0 ? cand.length
          : (agent.config.alwaysContext ? ALWAYS_CONTEXT_CAP : 5);
        return agent.getContext(query, userRole, false, {
          vectorCandidates: cand, guaranteedPageIds: guaranteedPages.get(id), chunkCap,
          recency: plan?.recency,
        });
      }));
      const gContexts = gCtxs.filter((c): c is AgentContext => c !== null);
      const gFinal = gContexts.filter(c => c.confidence > 0.3);
      const gOut = gFinal.length > 0 ? gFinal : gContexts;
      if (gOut.length > 0) {
        const cSel = [...dispatch].map(id => agents.find(a => a.config.id === id))
          .find(a => a?.config.group === '단과대' || a?.config.group === '대학원');
        return {
          selectedAgentIds: gOut.map(c => c.agentId), contexts: gOut, isGlobal: false,
          tier: cSel ? classifyTier(query) : undefined, college: cSel?.config.id,
        };
      }
      // gOut 비면 아래 per-wiki로 fallback
    } catch (err) {
      console.error('[globalTopK] failed, per-wiki fallback:', err);
    }
  }

  const topScore = scored[0]?.score ?? 0;
  const relativeThreshold = topScore * RELATIVE_THRESHOLD;
  const gapCutoff = detectScoreGap(scored.map(s => s.score));

  // === 적응형 선택 ===
  const selected = scored.filter((s, i) => {
    if (s.agent.config.alwaysContext) return true;
    if (forcedWikis.has(s.agent.config.id)) return true;
    if (topScore === 0) {
      // 아무 위키도 키워드 매칭 0: 거버넌스는 기존 fallback(전체 후보) 유지.
      //   단, breadth로 admit된 단과대/대학원은 semantic/concept로 forced된 것만(위에서 이미 통과) —
      //   여기선 제외해 무관한 그룹 위키가 무더기 진입하는 것 차단(forced 콜리지는 영향 없음).
      return !isCollegeGroup(s.agent.config);
    }
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

  // Design Ref: rag-cost-reduction §2 M2c — fallback 보수화.
  //   기존: selected가 비면 점수 무관 상위 MAX_WIKIS를 끌어옴(무관 위키 진입).
  //   변경: MIN_ABSOLUTE_SCORE 통과분 우선, 그것도 없으면 top-1만(컨텍스트 0 방지).
  //   (semantic-hint-only 위키 컷은 동의어 recall 안전장치라 보류 — Plan Open Decision #2 + sweep 후 결정.)
  const scorePassing = scored.filter(s => s.score >= MIN_ABSOLUTE_SCORE);
  const finalSelected = cappedSelected.length > 0
    ? cappedSelected
    : (scorePassing.length > 0 ? scorePassing.slice(0, MAX_WIKIS) : scored.slice(0, 1));

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
      recency: plan?.recency,
    })
  ));

  const filteredContexts = contexts.filter(c => c.confidence > 0.3);
  const finalContexts = filteredContexts.length > 0 ? filteredContexts : contexts;

  // === college-grad-wiki: 단과대/대학원 위키가 선택됐을 때만 tier 분류 + college 식별 ===
  //   college = 선택된 college wiki_id (wiki_id 자체가 단과대 → detectCollege 휴리스틱 불필요).
  //   기존 9위키만 선택된 governance 쿼리는 tier/college 모두 undefined → 핸들러 분기 미발동.
  const collegeSel = finalSelected.find(
    s => s.agent.config.group === '단과대' || s.agent.config.group === '대학원',
  );
  const tier = collegeSel ? classifyTier(query) : undefined;
  const college = collegeSel?.agent.config.id;

  return {
    selectedAgentIds: finalContexts.map(c => c.agentId),
    contexts: finalContexts,
    isGlobal: false,
    tier,
    college,
  };
}
