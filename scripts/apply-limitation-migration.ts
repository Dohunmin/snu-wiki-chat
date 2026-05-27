/**
 * limitation_questions/clusters 마이그레이션을 Neon에 직접 적용 (일회성).
 * drizzle journal 안 거치고 0003 SQL 직접 실행 (0002 pgvector와 동일 방식).
 * 실행: npx tsx --env-file=.env.local scripts/apply-limitation-migration.ts
 */
import { loadEnvFile } from 'process';
try { loadEnvFile('.env.local'); } catch {}

import pg from 'pg';

// 마이그레이션 SQL 인라인 (drizzle/은 .gitignore라 재현성 위해 여기 보존).
// 신규 테이블 2개만. chunk_embeddings 등 기존 테이블 무영향. 멱등(IF NOT EXISTS).
const MIGRATION = `
CREATE TABLE IF NOT EXISTS limitation_questions (
  id                  TEXT PRIMARY KEY,
  question            TEXT NOT NULL,
  answer              TEXT NOT NULL,
  question_created_at TIMESTAMP NOT NULL,
  routed_agents       JSONB NOT NULL DEFAULT '[]'::jsonb,
  embedding           VECTOR(1024) NOT NULL,
  quality             TEXT NOT NULL,
  wiki                TEXT NOT NULL DEFAULT '',
  limitation          BOOLEAN NOT NULL DEFAULT FALSE,
  limitation_excerpt  TEXT NOT NULL DEFAULT '',
  cluster_id          INTEGER NOT NULL DEFAULT -1,
  pca_x               REAL NOT NULL DEFAULT 0,
  pca_y               REAL NOT NULL DEFAULT 0,
  placement_wiki      TEXT NOT NULL DEFAULT '',
  evaluated_at        TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS limitation_questions_vec_idx
  ON limitation_questions USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX IF NOT EXISTS limitation_questions_cluster_idx
  ON limitation_questions (cluster_id);
CREATE TABLE IF NOT EXISTS limitation_clusters (
  cluster_id  INTEGER PRIMARY KEY,
  label       TEXT NOT NULL,
  member_ids  JSONB NOT NULL,
  updated_at  TIMESTAMP NOT NULL DEFAULT NOW()
);
`;

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.POSTGRES_URL });
  console.log('🔧 마이그레이션 적용 중 (Neon)...');
  await pool.query(MIGRATION);   // pg는 multi-statement 지원

  // 검증
  const { rows } = await pool.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_name IN ('limitation_questions','limitation_clusters','chunk_embeddings')
    ORDER BY table_name
  `);
  console.log('✅ 존재 테이블:', rows.map(r => r.table_name).join(', '));
  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
