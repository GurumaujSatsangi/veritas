/**
 * Re-analyze the whole corpus for CROSS-document relationships.
 *
 * Relationship detection normally runs only when a document is uploaded, and it
 * compares against whatever is already indexed. So if you upload A then B, only
 * B gets compared to A - and never the other way round. This script re-embeds
 * every fact, re-indexes it in Qdrant tagged with its document, then compares
 * every fact against the nearest facts in *other* documents and stores any new
 * relationships it finds. Existing relationships are left alone.
 *
 *   npm run reanalyze
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { db } = require('../src/db/client');
const { facts, relationships } = require('../src/db/schema');
const { embedTexts } = require('../src/services/embeddings');
const { ensureCollection, upsertFactVectors, searchSimilarFacts } = require('../src/services/vectorStore');
const { judgeRelationship } = require('../src/services/relationshipJudge');

const TOP_K = Number(process.env.TOP_K) || 5;
const CONCURRENCY = Number(process.env.FACT_CONCURRENCY) || 8;

async function mapLimit(items, limit, fn) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

function pairKey(a, b) { return [a, b].sort().join('|'); }

(async () => {
  await ensureCollection();

  const rows = await db.select().from(facts);
  console.log(`Loaded ${rows.length} facts.`);
  if (!rows.length) { console.log('Nothing to do.'); process.exit(0); }

  const all = rows.map(r => ({
    id: r.id,
    documentId: r.documentId,
    text: r.text,
    span_start: r.spanStart,
    span_end: r.spanEnd,
    subject: (r.attributes && r.attributes.subject) ?? null,
    value: (r.attributes && r.attributes.value) ?? null,
    unit: (r.attributes && r.attributes.unit) ?? null,
    time_scope: (r.attributes && r.attributes.time_scope) ?? null,
  }));

  const docIds = new Set(all.map(f => f.documentId));
  console.log(`${docIds.size} documents in the corpus.`);
  if (docIds.size < 2) {
    console.log('Need at least 2 documents for cross-document analysis. Upload another and re-run.');
    process.exit(0);
  }

  console.log('Embedding all facts...');
  const vectors = await embedTexts(all.map(f => f.text));
  all.forEach((f, i) => { f.vector = vectors[i]; });

  console.log('Re-indexing vectors (tagged with document id)...');
  await upsertFactVectors(all.map(f => ({ id: f.id, vector: f.vector, documentId: f.documentId })));

  // Pairs that already have a relationship (either direction).
  const existing = await db
    .select({ s: relationships.sourceFactId, t: relationships.targetFactId })
    .from(relationships);
  const known = new Set(existing.map(e => pairKey(e.s, e.t)));
  console.log(`${known.size} relationships already recorded.`);

  const byId = new Map(all.map(f => [f.id, f]));
  const newRels = [];
  let done = 0;

  await mapLimit(all, CONCURRENCY, async (f) => {
    try {
      const hits = await searchSimilarFacts(f.vector, TOP_K, {
        excludeId: f.id,
        sameDocumentId: f.documentId, // only OTHER documents
      });
      for (const h of hits) {
        const other = byId.get(h.id);
        if (!other || other.documentId === f.documentId) continue;
        const key = pairKey(f.id, other.id);
        if (known.has(key)) continue;
        known.add(key); // claim it so no worker judges the same pair twice
        const j = await judgeRelationship(f, other);
        if (j.type !== 'unrelated') {
          newRels.push({
            sourceFactId: f.id,
            targetFactId: other.id,
            type: j.type,
            explanation: j.explanation,
            confidence: j.confidence,
          });
        }
      }
    } catch (e) {
      console.error(`fact ${f.id}: ${e.message}`);
    } finally {
      done++;
      if (done % 50 === 0 || done === all.length) {
        console.log(`${done}/${all.length} facts, ${newRels.length} new cross-document relationships`);
      }
    }
  });

  if (newRels.length) {
    console.log(`Inserting ${newRels.length} relationships...`);
    for (let i = 0; i < newRels.length; i += 1000) {
      await db.insert(relationships).values(newRels.slice(i, i + 1000));
    }
  }
  const byType = newRels.reduce((a, r) => (a[r.type] = (a[r.type] || 0) + 1, a), {});
  console.log('Done. New cross-document relationships by type:', byType);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
