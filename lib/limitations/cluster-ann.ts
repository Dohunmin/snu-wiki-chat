// Design Ref: limitation-storage §2.2 — pgvector ANN 증분 클러스터 할당 + 전체 재계산 보정.
// 새 질문만 embedding <=> 이웃 검색(search.ts 패턴) → 클러스터 할당. 전체 N² 회피.

import { db } from '@/lib/db/client';
import { sql } from 'drizzle-orm';
import { dbscan } from './dbscan';

export const EPS = 0.40;
export const MIN_PTS = 2;

interface NeighborRow { id: string; cluster_id: number; dist: number }

/**
 * 신규 질문 1개를 ANN 이웃 검색으로 클러스터 할당.
 * - 이웃 없음 → outlier(-1)
 * - 이웃 모두 outlier → 새 클러스터 생성 (이웃 outlier들도 승격)
 * - 이웃이 기존 클러스터 → 최근접 클러스터 합류 (병합은 rebuildAllClusters로 보정)
 */
export async function assignClusterANN(
  questionId: string,
  embedding: number[],
): Promise<{ clusterId: number; affectedClusterIds: number[] }> {
  const vec = `[${embedding.join(',')}]`;

  const res = await db.execute(sql`
    SELECT id, cluster_id, embedding <=> ${vec}::vector AS dist
    FROM limitation_questions
    WHERE id != ${questionId} AND embedding <=> ${vec}::vector <= ${EPS}
    ORDER BY dist
    LIMIT 50
  `);
  const neighbors = (res.rows as unknown as NeighborRow[]) ?? [];

  // minPts=2 → 자기 포함이므로 이웃 1개 이상 필요
  if (neighbors.length < MIN_PTS - 1) {
    return { clusterId: -1, affectedClusterIds: [] };
  }

  // dist 정렬 유지된 이웃의 클러스터 (>=0)
  const neighborClusters = [...new Set(
    neighbors.map(n => Number(n.cluster_id)).filter(c => c >= 0)
  )];

  if (neighborClusters.length === 0) {
    // 모든 이웃이 outlier → 새 클러스터 생성, 이웃들도 함께 승격
    const newId = await nextClusterId();
    const outlierIds = neighbors
      .filter(n => Number(n.cluster_id) === -1)
      .map(n => n.id);
    for (const id of [questionId, ...outlierIds]) {
      await db.execute(sql`UPDATE limitation_questions SET cluster_id = ${newId} WHERE id = ${id}`);
    }
    return { clusterId: newId, affectedClusterIds: [newId] };
  }

  // 최근접 이웃의 클러스터에 합류 (neighbors가 dist순이라 neighborClusters[0]이 최근접)
  const target = neighborClusters[0];
  await db.execute(sql`UPDATE limitation_questions SET cluster_id = ${target} WHERE id = ${questionId}`);
  // 여러 클러스터에 걸친 경우 = 잠재 병합 지점 → affected로 표시(라벨 갱신 + 보정 대상)
  return { clusterId: target, affectedClusterIds: neighborClusters };
}

async function nextClusterId(): Promise<number> {
  const res = await db.execute(sql`SELECT COALESCE(MAX(cluster_id), -1) + 1 AS next FROM limitation_questions`);
  return Number((res.rows[0] as { next: number }).next);
}

/**
 * 전체 재계산 보정 — ANN 증분 누적 오차(병합 누락 등) 정리.
 * 전체 embedding 로드 → 메모리 정밀 DBSCAN → cluster_id 일괄 갱신.
 * 수동/주기 실행 (데이터 적어 비용 작음).
 */
export async function rebuildAllClusters(): Promise<{ clusters: number; outliers: number; total: number }> {
  const res = await db.execute(sql`
    SELECT id, embedding::text AS emb
    FROM limitation_questions
    ORDER BY question_created_at
  `);
  const rows = res.rows as unknown as { id: string; emb: string }[];
  if (rows.length === 0) return { clusters: 0, outliers: 0, total: 0 };

  const ids = rows.map(r => r.id);
  const embeddings = rows.map(r => r.emb.slice(1, -1).split(',').map(Number));
  const labels = dbscan(embeddings, EPS, MIN_PTS);

  for (let i = 0; i < ids.length; i++) {
    await db.execute(sql`UPDATE limitation_questions SET cluster_id = ${labels[i]} WHERE id = ${ids[i]}`);
  }

  const clusterSet = new Set(labels.filter(l => l >= 0));
  return {
    clusters: clusterSet.size,
    outliers: labels.filter(l => l === -1).length,
    total: ids.length,
  };
}
