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
