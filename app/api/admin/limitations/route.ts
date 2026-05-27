// Design Ref: §2.5 — knowledge-map-questions.json 읽고 cluster + outlier 그룹핑.
// cluster: 한계율 기반 정렬. outlier: 위키별 그룹 (한계 답변만).

import { auth } from '@/lib/auth/config';
import { canAccessAdmin } from '@/lib/auth/roles';
import { db } from '@/lib/db/client';
import { sql } from 'drizzle-orm';
import type { LimitationCluster, LimitationQuestion } from '@/lib/limitations/types';

export interface OutlierGroup {
  wiki: string;
  total: number;            // 이 위키에 속한 outlier 총
  limited: number;          // 그 중 한계
  questions: Array<{        // 한계 답변만 (limited만)
    id: string;
    question: string;
    limitationExcerpt: string;
    createdAt: string;
  }>;
}

export interface LimitationsApiResponse {
  clusters: LimitationCluster[];
  outliers: OutlierGroup[];
  totalCount: number;
  limitedCount: number;
  updatedAt: string;
}

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user) {
    return Response.json({ error: '로그인이 필요합니다.' }, { status: 401 });
  }
  if (!canAccessAdmin(session.user.role)) {
    return Response.json({ error: '관리자 전용입니다.' }, { status: 403 });
  }

  const url = new URL(req.url);
  const wikiFilter = url.searchParams.get('wiki') ?? '';
  const sortBy = (url.searchParams.get('sort') ?? 'rate') as 'rate' | 'limited' | 'recent';

  // DB에서 전체 질문 + 클러스터 라벨 로드
  const qRes = await db.execute(sql`
    SELECT id, question, answer, question_created_at AS "createdAt", routed_agents AS "routedAgents",
           quality, wiki, limitation, limitation_excerpt AS "limitationExcerpt",
           cluster_id AS "clusterId", pca_x AS "pcaX", pca_y AS "pcaY", placement_wiki AS "placementWiki"
    FROM limitation_questions
  `);
  const labelRes = await db.execute(sql`SELECT cluster_id AS "clusterId", label FROM limitation_clusters`);
  const tsRes = await db.execute(sql`SELECT MAX(evaluated_at) AS "maxAt" FROM limitation_questions`);
  const updatedAt = (() => {
    const m = (tsRes.rows[0] as { maxAt: unknown } | undefined)?.maxAt;
    return m instanceof Date ? m.toISOString() : (m ? String(m) : '');
  })();

  // DB row → LimitationQuestion 형태 (그룹핑 로직 재사용)
  const allQs: LimitationQuestion[] = (qRes.rows as unknown as Array<Record<string, unknown>>).map(r => ({
    id: r.id as string,
    question: r.question as string,
    answer: r.answer as string,
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
    routedAgents: (r.routedAgents as string[]) ?? [],
    embedding: [],
    quality: r.quality as LimitationQuestion['quality'],
    wiki: (r.wiki as string) ?? '',
    limitation: r.limitation as boolean,
    limitationExcerpt: (r.limitationExcerpt as string) ?? '',
    clusterId: Number(r.clusterId),
    pcaCoord: [Number(r.pcaX), Number(r.pcaY)],
    placementWiki: (r.placementWiki as string) ?? '',
  }));

  const labelMap = new Map<number, string>();
  for (const row of labelRes.rows as unknown as Array<{ clusterId: number; label: string }>) {
    labelMap.set(Number(row.clusterId), row.label);
  }

  if (allQs.length === 0) {
    return Response.json({
      clusters: [], outliers: [],
      totalCount: 0, limitedCount: 0, updatedAt: '',
      error: '한계 답변 데이터가 아직 없습니다. 갱신을 실행해주세요.',
    });
  }

  // 위키 필터 — questions의 wiki(또는 placementWiki) 기준
  const filteredQs = wikiFilter
    ? allQs.filter(q => (q.wiki || q.placementWiki) === wikiFilter)
    : allQs;

  // cluster 그룹핑
  const byCluster = new Map<number, LimitationQuestion[]>();
  for (const q of filteredQs) {
    if (q.clusterId < 0) continue;
    const arr = byCluster.get(q.clusterId) ?? [];
    arr.push(q);
    byCluster.set(q.clusterId, arr);
  }

  // 카드 펼침에 한계 답변만 표시 — 한계 false 질문은 노이즈, 보충 도구 본질과 무관.
  // 헤더의 total/limited/rate는 그대로 (한계율 신호 유지).
  let clusters: LimitationCluster[] = Array.from(byCluster.entries()).map(([cid, items]) => {
    const limitedItems = items.filter(q => q.limitation);
    return {
      clusterId: cid,
      wiki: dominantWiki(items),
      label: labelMap.get(cid) ?? `클러스터 ${cid}`,
      total: items.length,
      limited: limitedItems.length,
      rate: limitedItems.length / items.length,
      questions: limitedItems.map(q => ({
        id: q.id, question: q.question,
        limitation: q.limitation, limitationExcerpt: q.limitationExcerpt,
        createdAt: q.createdAt,
      })),
    };
  })
  // 한계 0건 클러스터는 아예 제외 — 답변도 못 보고 보충 신호 아님 (사용자 요청)
  .filter(c => c.limited > 0);

  clusters = sortClusters(clusters, sortBy);

  // outlier (단일 질문) — 위키별 그룹핑, 한계 답변만 노출
  const byWikiOutlier = new Map<string, LimitationQuestion[]>();
  for (const q of filteredQs) {
    if (q.clusterId !== -1) continue;
    const w = q.wiki || q.placementWiki || 'other';
    const arr = byWikiOutlier.get(w) ?? [];
    arr.push(q);
    byWikiOutlier.set(w, arr);
  }

  let outliers: OutlierGroup[] = Array.from(byWikiOutlier.entries())
    .map(([wiki, items]) => {
      const limited = items.filter(q => q.limitation);
      return {
        wiki,
        total: items.length,
        limited: limited.length,
        questions: limited.map(q => ({
          id: q.id, question: q.question,
          limitationExcerpt: q.limitationExcerpt,
          createdAt: q.createdAt,
        })),
      };
    })
    .filter(g => g.limited > 0)      // 한계 없는 outlier 그룹은 노출 X (보충 신호 아님)
    .sort((a, b) => b.limited - a.limited);

  return Response.json({
    clusters,
    outliers,
    totalCount: allQs.length,
    limitedCount: allQs.filter(q => q.limitation).length,
    updatedAt,
  } satisfies LimitationsApiResponse);
}

function dominantWiki(items: LimitationQuestion[]): string {
  const counts: Record<string, number> = {};
  for (const q of items) {
    const w = q.wiki || q.placementWiki || '';
    if (!w) continue;
    counts[w] = (counts[w] ?? 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
}

function sortClusters(clusters: LimitationCluster[], sortBy: string): LimitationCluster[] {
  if (sortBy === 'rate') {
    // 한계율 우선, 동률은 한계 절대수, 동률은 size
    return clusters.sort((a, b) => b.rate - a.rate || b.limited - a.limited || b.total - a.total);
  }
  if (sortBy === 'limited') {
    return clusters.sort((a, b) => b.limited - a.limited || b.rate - a.rate);
  }
  // recent — questions가 비어있는 cluster(한계 0건)는 0으로 처리(맨 뒤)
  return clusters.sort((a, b) => {
    const ma = a.questions.length > 0 ? Math.max(...a.questions.map(q => +new Date(q.createdAt))) : 0;
    const mb = b.questions.length > 0 ? Math.max(...b.questions.map(q => +new Date(q.createdAt))) : 0;
    return mb - ma;
  });
}
