const { pgTable, serial, text, integer, timestamp } = require('drizzle-orm/pg-core');

const documents = pgTable('documents', {
  id: serial('id').primaryKey(),
  title: text('title'),
  content: text('content'),
  status: text('status').default('processing'),
  createdAt: timestamp('created_at').defaultNow(),
});

const facts = pgTable('facts', {
  id: serial('id').primaryKey(),
  documentId: integer('document_id').references(() => documents.id),
  content: text('content'),
  createdAt: timestamp('created_at').defaultNow(),
});

const relationships = pgTable('relationships', {
  id: serial('id').primaryKey(),
  sourceFactId: integer('source_fact_id').references(() => facts.id),
  targetFactId: integer('target_fact_id').references(() => facts.id),
  type: text('type'),
  createdAt: timestamp('created_at').defaultNow(),
});

module.exports = {
  documents,
  facts,
  relationships
};
