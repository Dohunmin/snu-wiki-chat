// Design Ref: §2.5 — knowledge-map-questions.json 읽고 cluster + outlier 그룹핑.
// cluster: 한계율 기반 정렬. outlier: 위키별 그룹 (한계 답변만).

import fs from 'fs/promises';
import path from 'path';
import { auth } from '@/lib/auth/config';
import { canAccessAdmin } from '@/lib/auth/roles';
import type {
  LimitationsJsonFile, LimitationCluster, LimitationQuestion,
} from '@/lib/limitations/types';

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

  let json: LimitationsJsonFile;
  try {
    const raw = await fs.readFile(
      path.join(process.cwd(), 'public/knowledge-map-questions.json'),
      'utf-8'
    );
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      // 기존 배열 형식 — 한 번도 갱신 안 됨
      return Response.json({
        clusters: [], outliers: [],
        totalCount: 0, limitedCount: 0,
        updatedAt: '',
        error: '한계 답변 데이터가 아직 없습니다. 갱신을 실행해주세요.',
      });
    }
    json = parsed;
  } catch {
    return Response.json({
      clusters: [], outliers: [],
      totalCount: 0, limitedCount: 0, updatedAt: '',
      error: '데이터 파일을 찾을 수 없습니다.',
    });
  }

  const allQs = json.questions ?? [];

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
      label: json.clusterLabels[String(cid)]?.label ?? `클러스터 ${cid}`,
      total: items.length,
      limited: limitedItems.length,
      rate: limitedItems.length / items.length,
      questions: limitedItems.map(q => ({
        id: q.id, question: q.question,
        limitation: q.limitation, limitationExcerpt: q.limitationExcerpt,
        createdAt: q.createdAt,
      })),
    };
  });

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
    updatedAt: json.updatedAt,
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
