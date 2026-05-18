import { pgTable, text, timestamp, jsonb, integer, boolean, vector } from 'drizzle-orm/pg-core';

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
