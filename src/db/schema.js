const { sql } = require('drizzle-orm');
const {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  doublePrecision,
  timestamp,
  index,
} = require('drizzle-orm/pg-core');

// NOTE: these definitions mirror the tables that actually exist in the
// Neon database (UUID primary keys, `uuid_generate_v4()` defaults).

const documents = pgTable('documents', {
  id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
  title: text('title').notNull(),
  content: text('content'),
  status: text('status').default('processing'),
  createdAt: timestamp('created_at').defaultNow(),
});

const facts = pgTable('facts', {
  id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
  documentId: uuid('document_id').references(() => documents.id, { onDelete: 'cascade' }),
  text: text('text').notNull(),
  page: integer('page'),
  spanStart: integer('span_start'),
  spanEnd: integer('span_end'),
  attributes: jsonb('attributes').default(sql`'{}'::jsonb`),
  // legacy column kept in sync in case it is NOT NULL in the DB
  content: text('content'),
  createdAt: timestamp('created_at').defaultNow(),
}, (table) => ({
  documentIdIdx: index('idx_facts_document_id').on(table.documentId),
}));

const relationships = pgTable('relationships', {
  id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
  sourceFactId: uuid('source_fact_id').references(() => facts.id, { onDelete: 'cascade' }),
  targetFactId: uuid('target_fact_id').references(() => facts.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  explanation: text('explanation'),
  confidence: doublePrecision('confidence'),
  createdAt: timestamp('created_at').defaultNow(),
}, (table) => ({
  sourceFactIdIdx: index('idx_relationships_source_fact_id').on(table.sourceFactId),
  targetFactIdIdx: index('idx_relationships_target_fact_id').on(table.targetFactId),
}));

module.exports = {
  documents,
  facts,
  relationships
};
