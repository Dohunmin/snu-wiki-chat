import { pgTable, text, timestamp, jsonb } from 'drizzle-orm/pg-core';

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

export const sensitiveTopics = pgTable('sensitive_topics', {
  id:        text('id').primaryKey(),
  agentId:   text('agent_id').notNull(),
  topic:     text('topic').notNull(),
  createdBy: text('created_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
