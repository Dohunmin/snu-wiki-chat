// Design Ref: §2.1 — API/UI/스크립트 공유 타입.

export interface LimitationQuestion {
  id: string;                          // DB messages.id (캐시 key)
  question: string;
  answer: string;                      // 답변 (전체)
  createdAt: string;                   // ISO
  routedAgents: string[];              // 라우팅 위키 ID들
  embedding: number[];                 // Voyage 1024차원 (cluster용)

  // Sonnet 평가
  quality: 'answered' | 'partial' | 'no_data';
  wiki: string;                        // 위키 ID (Sonnet 판정, 없으면 routedAgents[0] fallback)
  limitation: boolean;                 // 신규: 한계 명시 답변인가
  limitationExcerpt: string;           // 신규: 한계 부분 최대 300자

  // DBSCAN
  clusterId: number;                   // -1 = outlier

  // 지식 지형도 호환
  pcaCoord: [number, number];
  placementWiki: string;
}

export interface ClusterLabelEntry {
  label: string;
  memberIds: string[];                 // 캐시 key 비교용 (set 동일하면 라벨 재사용)
}

export interface LimitationsJsonFile {
  questions: LimitationQuestion[];
  clusterLabels: Record<string, ClusterLabelEntry>;   // key = String(clusterId)
  updatedAt: string;
  totalCount: number;
}

export interface LimitationCluster {
  clusterId: number;                   // -1 → outlier 그룹
  wiki: string;                        // 클러스터 우세 위키
  label: string;                       // outlier면 "단일 질문"
  total: number;
  limited: number;
  rate: number;                        // limited / total
  questions: Array<{
    id: string;
    question: string;
    limitation: boolean;
    limitationExcerpt: string;
    createdAt: string;
  }>;
}

export interface RefreshResult {
  processed: number;                   // 이번 batch 처리한 새 질문 수
  hasMore: boolean;                    // DB에 아직 미처리 질문 남음
  totalCount: number;                  // 누적 총 수
  durationMs: number;                  // 이번 batch 소요
  newClusterCount: number;             // 이번 batch에서 새로 라벨링한 클러스터
}
