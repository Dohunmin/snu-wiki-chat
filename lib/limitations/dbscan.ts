// Design Ref: §2.2 — DBSCAN cosine distance, 외부 의존 없음.
// 137~수천 건 규모에서 distance matrix 사전 계산 (메모리 N²·8byte, 1000건=8MB로 무방).

/**
 * DBSCAN — Density-Based Spatial Clustering.
 * @param vectors  N×D 벡터 배열 (각 행이 한 점)
 * @param eps      cosine distance 임계 (1.0=완전 반대, 0=동일)
 * @param minPts   클러스터 최소 멤버 수
 * @returns labels — 각 점의 clusterId. -1 = outlier (noise), 0+ = cluster index.
 */
export function dbscan(vectors: number[][], eps: number, minPts: number): number[] {
  const N = vectors.length;
  if (N === 0) return [];

  // 사전 정규화 — cosine 계산 단순화 (정규화된 벡터의 cosine = dot product)
  const norms = vectors.map(v => {
    let sum = 0;
    for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
    return Math.sqrt(sum) || 1;  // 0 벡터 방어
  });

  function distance(i: number, j: number): number {
    const a = vectors[i], b = vectors[j];
    let dot = 0;
    for (let k = 0; k < a.length; k++) dot += a[k] * b[k];
    const sim = dot / (norms[i] * norms[j]);
    return 1 - sim;
  }

  function regionQuery(p: number): number[] {
    const neighbors: number[] = [];
    for (let q = 0; q < N; q++) {
      if (q !== p && distance(p, q) <= eps) neighbors.push(q);
    }
    return neighbors;
  }

  const labels = new Array<number>(N).fill(-2);  // -2 = unvisited
  let clusterId = 0;

  for (let p = 0; p < N; p++) {
    if (labels[p] !== -2) continue;
    const neighbors = regionQuery(p);
    // p 본인 포함 시 size = neighbors.length + 1 (p는 neighbors에서 제외했으니 +1)
    if (neighbors.length + 1 < minPts) {
      labels[p] = -1;  // outlier (나중에 다른 cluster의 border로 변경 가능)
      continue;
    }

    labels[p] = clusterId;
    const seeds = [...neighbors];
    while (seeds.length > 0) {
      const q = seeds.shift()!;
      if (labels[q] === -1) labels[q] = clusterId;        // outlier → border
      if (labels[q] !== -2) continue;
      labels[q] = clusterId;
      const qNeighbors = regionQuery(q);
      if (qNeighbors.length + 1 >= minPts) {
        for (const r of qNeighbors) {
          if (labels[r] === -2 || labels[r] === -1) seeds.push(r);
        }
      }
    }
    clusterId++;
  }

  return labels;
}
