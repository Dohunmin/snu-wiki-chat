import { pgTable, text, timestamp, jsonb, integer, boolean, vector, real } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id:           text('id').primaryKey(),
  email:        text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  name:         text('name').notNull(),
  role:         text('role').notNull().default('pending'),  // admin | tier1 | tier2 | pending
  approvedBy:   text('approved_by'),
  approvedAt:   timestamp('approved_at'),
  createdAt:    timestamp('created_at').defaultNow().notNull(),
  updatedAt:    timestamp('updated_at').defaultNow().notNull(),
});

export const conversations = pgTable('conversations', {
  id:        text('id').primaryKey(),
  userId:    text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  title:     text('title'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const messages = pgTable('messages', {
  id:             text('id').primaryKey(),
  conversationId: text('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  role:           text('role').notNull(),  // 'user' | 'assistant'
  content:        text('content').notNull(),
  routedAgents:   text('routed_agents').array(),
  sources:        jsonb('sources'),
  mode:           text('mode').notNull().default('normal'),  // 'normal' | 'lens:{personaId}'
  createdAt:      timestamp('created_at').defaultNow().notNull(),
});

export const uploads = pgTable('uploads', {
  id:          text('id').primaryKey(),
  userId:      text('user_id').notNull().references(() => users.id),
  agentId:     text('agent_id').notNull(),
  fileName:    text('file_name').notNull(),
  content:     text('content').notNull(),
  status:      text('status').notNull().default('pending'),  // pending | approved | rejected
  reviewedBy:  text('reviewed_by'),
  createdAt:   timestamp('created_at').defaultNow().notNull(),
  reviewedAt:  timestamp('reviewed_at'),
});

export const syntheses = pgTable('syntheses', {
  id:             text('id').primaryKey(),
  userId:         text('user_id').references(() => users.id, { onDelete: 'cascade' }),
  conversationId: text('conversation_id').references(() => conversations.id, { onDelete: 'set null' }),
  query:          text('query').notNull(),
  answeredAt:     text('answered_at').notNull(),
  routedTo:       text('routed_to').array(),
  tags:           text('tags').array(),
  content:        text('content').notNull(),
  createdAt:      timestamp('created_at').defaultNow().notNull(),
});

export const sensitiveTopics = pgTable('sensitive_topics', {
  id:        text('id').primaryKey(),
  agentId:   text('agent_id').notNull(),
  topic:     text('topic').notNull(),
  createdBy: text('created_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// Design Ref: §3.1 Data Model — chunk_embeddings 테이블
// Plan SC: SC1 (pgvector 설치 + chunk_embeddings 테이블 작동)
// 기존 6개 테이블 영향 없음. ragEnabled 위키만 임베딩 저장.
export const chunkEmbeddings = pgTable('chunk_embeddings', {
  id:          text('id').primaryKey(),                              // {wikiId}:{pageType}:{pageId}:{chunkIdx}
  wikiId:      text('wiki_id').notNull(),
  pageType:    text('page_type').notNull(),                          // source | fact | stance | overview | topic | entity
  pageId:      text('page_id').notNull(),
  chunkIdx:    integer('chunk_idx').notNull(),
  chunkText:   text('chunk_text').notNull(),
  embedding:   vector('embedding', { dimensions: 1024 }).notNull(),  // Voyage 3 = 1024차원
  sensitive:   boolean('sensitive').default(false).notNull(),
  metadata:    jsonb('metadata'),                                    // { title, topic, holder, category, ... }
  contentHash: text('content_hash').notNull(),                       // SHA-256 (증분 갱신용)
  createdAt:   timestamp('created_at').defaultNow().notNull(),
});

// Design Ref: limitation-storage §2.1 — 한계 답변 추적 데이터 (파일 → DB 이전).
// Vercel read-only fs(EROFS) 회피 + pgvector ANN 증분 클러스터링.
// chunk_embeddings와 동일 pgvector 패턴. 기존 테이블 영향 없음.
export const limitationQuestions = pgTable('limitation_questions', {
  id:                text('id').primaryKey(),                         // messages.id (user 질문)
  question:          text('question').notNull(),
  answer:            text('answer').notNull(),
  questionCreatedAt: timestamp('question_created_at').notNull(),
  routedAgents:      jsonb('routed_agents').$type<string[]>().default([]).notNull(),
  embedding:         vector('embedding', { dimensions: 1024 }).notNull(),
  // Sonnet 평가
  quality:           text('quality').notNull(),                       // answered | partial | no_data
  wiki:              text('wiki').default('').notNull(),
  limitation:        boolean('limitation').default(false).notNull(),
  limitationExcerpt: text('limitation_excerpt').default('').notNull(),
  // DBSCAN (ANN 증분 할당)
  clusterId:         integer('cluster_id').default(-1).notNull(),
  // 지식 지형도 호환 (PCA 2D)
  pcaX:              real('pca_x').default(0).notNull(),
  pcaY:              real('pca_y').default(0).notNull(),
  placementWiki:     text('placement_wiki').default('').notNull(),
  evaluatedAt:       timestamp('evaluated_at').defaultNow().notNull(),
});

// 클러스터 라벨 캐시 (멤버 동일하면 재사용)
export const limitationClusters = pgTable('limitation_clusters', {
  clusterId: integer('cluster_id').primaryKey(),
  label:     text('label').notNull(),
  memberIds: jsonb('member_ids').$type<string[]>().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// ─── college-grad-wiki (per-college) ──────────────────────────────────────────
// Design Ref: §3.3 — Tier3/Tier4 additive 테이블. 기존 11테이블·chunk_embeddings 무변경.
//   per-college 피봇: 조직 격리는 wiki_id가 담당하므로 chunk_embeddings에 college/tier 컬럼 추가 안 함.
//   여기 2테이블만 신규 — 자주 변하는 연락처(T3)·최신 공지(T4)를 정적 wiki 밖으로 분리해 신선도 유지.

// Tier3 — 구조화 사실 캐시 (연락처·인원·명단). 1레코드 직답 → LLM 0토큰.
// Plan SC: "공대 학장 이메일?" → 1레코드 직접반환
export const structuredFacts = pgTable('structured_facts', {
  id:        text('id').primaryKey(),                                  // `${org}:${field}`
  org:       text('org').notNull(),                                    // org.id (= 단과대/대학원 wiki_id)
  field:     text('field').notNull(),                                  // dean_contact | faculty_count | student_count | faculty_roster | dept_count
  value:     jsonb('value').$type<Record<string, unknown>>().notNull(),
  sourceUrl: text('source_url').notNull(),
  fetchedAt: timestamp('fetched_at').defaultNow().notNull(),
  ttlDays:   integer('ttl_days').default(90).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// Tier4 — 라이브 게시판 캐시 (최신 공지·뉴스). 크롤 produces, chat reads(읽기 전용 — §9.2 격리).
// 갱신은 오프라인(crawl --tier 4 / 백그라운드). 런타임은 캐시만 읽고, 미스/만료 시 Tier1 degrade.
export const liveCache = pgTable('live_cache', {
  id:        text('id').primaryKey(),                                  // `${org}:${board}`
  org:       text('org').notNull(),
  board:     text('board').notNull(),                                  // notice | news | research
  payload:   jsonb('payload').$type<unknown>().notNull(),              // BoardItem[]
  sourceUrl: text('source_url'),
  fetchedAt: timestamp('fetched_at').defaultNow().notNull(),
  ttlHours:  integer('ttl_hours').default(6).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
