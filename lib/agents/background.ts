/**
 * 배경 소스 게이트 — "외부 담론 배경"(edu-trends 등)을 *언제 넣을지* 판단해 주입.
 *
 * 핵심 설계 (사용자 합의):
 *  1) 발동 판단 = 의미 유사도. routeQuery(키워드/RRF)는 실측상 on-topic을 자주 놓쳐(4중 1) 신뢰 불가 →
 *     질문↔배경위키 임베딩 top-sim ≥ 임계일 때만 주입(off-topic 자동 제외). 실데이터 보정: on≈0.69 / off≈0.60.
 *  2) 만능 아님 = relevantData 상단에 "외부 2차 자료·부분 참고·SNU사실 아님" 마커를 박아 모델이 배경으로만 쓰게.
 *  3) 토큰 안전 = chunkCap으로 상위 N청크만 주입 → 위키가 커져도 주입량 고정(커질수록 더 정확한 N개를 고를 뿐).
 *
 * 인용 [N]·wiki 링크 보존: agentName/sources는 건드리지 않음(WIKI_TO_AGENT 링크·[N] 키 일관성 유지).
 */
import { registry } from './registry';
import { searchVector } from '@/lib/embed/search';
import type { AgentContext } from './types';
import type { Role } from '@/lib/auth/roles';

const SIM_THRESHOLD = Number(process.env.BACKGROUND_SIM_THRESHOLD ?? 0.65);
const MAX_CHUNKS = Number(process.env.BACKGROUND_MAX_CHUNKS ?? 4);
// 하드 토큰 캡 — getContext의 chunkCap이 topic/recency 경로에서 느슨해 질의별로 크게 튀므로(2.8k~11.8k)
//   섹션(## 단위) + 문자 상한으로 *강제 고정*. 위키가 커져도 주입량 일정(사용자 우려 해소).
const MAX_CHARS = Number(process.env.BACKGROUND_MAX_CHARS ?? 4000);

/** ## 섹션 단위로 상위 N개만 + 문자 상한. 헤더 중간 절단 없이 통째 섹션을 버려 [N] 정합 유지. */
function capBody(text: string): string {
  let secs = text.split(/\n(?=## )/).slice(0, MAX_CHUNKS);
  while (secs.join('\n').length > MAX_CHARS && secs.length > 1) secs.pop();
  return secs.join('\n');
}

const MARKER =
  '> 【외부 담론·동향 배경】 아래는 해외 기사·담론 등 **외부 2차 자료**입니다 (SNU 내부 사실 아님).\n' +
  '> - 세계 동향·벤치마크·논거로만 활용하고, 인용 시 "해외에서는~"처럼 **외부 출처에 귀속**하세요. SNU 사실로 단정 금지.\n' +
  '> - **부분적 참고 자료**일 뿐 완결·권위 자료가 아닙니다. 내부 [N] 자료가 답의 1차 토대이고 이 배경은 보조입니다.\n';

/**
 * 질문에 의미적으로 관련된 배경 소스 컨텍스트를 0개 이상 반환.
 * route.ts가 routeQuery 결과(routing.contexts)에 합쳐 예산·인용에 함께 태운다.
 */
export async function getBackgroundContexts(query: string, userRole: Role): Promise<AgentContext[]> {
  const bgAgents = registry.getAll().filter(a => a.config.backgroundSource && a.config.enabled);
  if (bgAgents.length === 0) return [];

  const out: AgentContext[] = [];
  for (const agent of bgAgents) {
    try {
      // 발동 판단: 의미 유사도 게이트
      const probe = await searchVector(query, agent.config.id, userRole, 1);
      const topSim = probe[0]?.similarity ?? 0;
      if (process.env.RAG_DEBUG === 'true') {
        console.log(`[background] ${agent.config.id} top-sim=${topSim.toFixed(3)} (임계 ${SIM_THRESHOLD}) → ${topSim >= SIM_THRESHOLD ? 'FIRE' : 'skip'}`);
      }
      if (topSim < SIM_THRESHOLD) continue;

      // 상위 N청크만 (토큰 고정). getContext는 (id) 헤더를 유지해 [N] 인용 정합.
      const ctx = await agent.getContext(query, userRole, false, { chunkCap: MAX_CHUNKS });
      if (!ctx.relevantData?.trim()) continue;

      // 외부 배경 마커 + 하드캡(섹션/문자). agentName/sources는 보존 → 인용·링크 유지.
      out.push({ ...ctx, relevantData: `${MARKER}\n${capBody(ctx.relevantData)}` });
    } catch (err) {
      console.error('[background] gate failed for', agent.config.id, err);
    }
  }
  return out;
}
