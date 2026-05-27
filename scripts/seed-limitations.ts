/**
 * knowledge-map-questions.json (재평가 끝난 137건) → limitation_questions/clusters 시드 (일회성).
 * 재임베딩·재평가 없이 그대로 이전. cluster_id도 기존 정밀 DBSCAN 결과 보존.
 * 실행: npx tsx --env-file=.env.local scripts/seed-limitations.ts
 */
import { loadEnvFile } from 'process';
try { loadEnvFile('.env.local'); } catch {}

import fs from 'fs';
import pg from 'pg';

interface JsonQuestion {
  id: string; question: string; answer: string; createdAt: string;
  routedAgents: string[]; embedding: number[];
  quality: string; wiki: string; limitation: boolean; limitationExcerpt: string;
  clusterId: number; pcaCoord: [number, number]; placementWiki: string;
}

async function main() {
  const data = JSON.parse(fs.readFileSync('public/knowledge-map-questions.json', 'utf-8'));
  const questions: JsonQuestion[] = data.questions ?? [];
  const clusterLabels: Record<string, { label: string; memberIds: string[] }> = data.clusterLabels ?? {};

  const pool = new pg.Pool({ connectionString: process.env.POSTGRES_URL });

  console.log(`🌱 ${questions.length}건 시드 시작...`);
  let n = 0;
  for (const q of questions) {
    const vec = `[${q.embedding.join(',')}]`;
    const [px, py] = q.pcaCoord ?? [0, 0];
    await pool.query(
      `INSERT INTO limitation_questions
        (id, question, answer, question_created_at, routed_agents, embedding,
         quality, wiki, limitation, limitation_excerpt, cluster_id, pca_x, pca_y, placement_wiki)
       VALUES ($1,$2,$3,$4,$5,$6::vector,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (id) DO UPDATE SET
         quality=EXCLUDED.quality, wiki=EXCLUDED.wiki,
         limitation=EXCLUDED.limitation, limitation_excerpt=EXCLUDED.limitation_excerpt,
         cluster_id=EXCLUDED.cluster_id, pca_x=EXCLUDED.pca_x, pca_y=EXCLUDED.pca_y,
         placement_wiki=EXCLUDED.placement_wiki`,
      [
        q.id, q.question, q.answer, q.createdAt, JSON.stringify(q.routedAgents ?? []), vec,
        q.quality, q.wiki ?? '', q.limitation ?? false, q.limitationExcerpt ?? '',
        q.clusterId ?? -1, px, py, q.placementWiki ?? '',
      ]
    );
    n++;
    if (n % 20 === 0) process.stdout.write(`\r  ${n}/${questions.length}`);
  }
  console.log(`\r  ${n}/${questions.length} 질문 완료`);

  // 클러스터 라벨
  let c = 0;
  for (const [cid, entry] of Object.entries(clusterLabels)) {
    await pool.query(
      `INSERT INTO limitation_clusters (cluster_id, label, member_ids)
       VALUES ($1,$2,$3)
       ON CONFLICT (cluster_id) DO UPDATE SET label=EXCLUDED.label, member_ids=EXCLUDED.member_ids`,
      [Number(cid), entry.label, JSON.stringify(entry.memberIds)]
    );
    c++;
  }
  console.log(`  ${c} 클러스터 라벨 완료`);

  // 검증
  const { rows: cnt } = await pool.query(`SELECT count(*)::int AS n FROM limitation_questions`);
  const { rows: lim } = await pool.query(`SELECT count(*)::int AS n FROM limitation_questions WHERE limitation`);
  const { rows: clu } = await pool.query(`SELECT count(DISTINCT cluster_id)::int AS n FROM limitation_questions WHERE cluster_id >= 0`);
  const { rows: out } = await pool.query(`SELECT count(*)::int AS n FROM limitation_questions WHERE cluster_id = -1`);
  console.log(`\n📊 DB 검증: 총 ${cnt[0].n}건 / 한계 ${lim[0].n} / 클러스터 ${clu[0].n}개 / outlier ${out[0].n}`);

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
