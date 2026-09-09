const fs = require('fs');
const { eq } = require('drizzle-orm');
const { db } = require('../db/client');
const { documents, facts, relationships } = require('../db/schema');
const { extractTextByPage } = require('./pdfParser');
const { extractFacts } = require('./factExtractor');
const { embedTexts } = require('./embeddings');
const { ensureCollection, upsertFactVectors, searchSimilarFacts } = require('./vectorStore');
const { judgeRelationship } = require('./relationshipJudge');

const TOP_K = Number(process.env.TOP_K) || 3;
const PAGE_CONCURRENCY = Number(process.env.PAGE_CONCURRENCY) || 6;
const FACT_CONCURRENCY = Number(process.env.FACT_CONCURRENCY) || 8;
// Cap facts per document so a huge PDF does not trigger thousands of LLM calls.
// Set MAX_FACTS=0 to disable.
const MAX_FACTS = process.env.MAX_FACTS !== undefined ? Number(process.env.MAX_FACTS) : 600;

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Run an async mapper over `items` with at most `limit` in flight at once.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

async function processDocument(documentId, filePath, onProgress = () => {}) {
  const report = (pct, stage) => {
    try { onProgress({ pct: Math.round(pct), stage }); } catch (_) {}
  };

  try {
    console.log(`[processDocument] Starting pipeline for documentId=${documentId}`);
    report(2, 'Starting');

    await ensureCollection();

    // 1. Extract text page by page.
    console.log(`[processDocument] Step 1: Extracting text from PDF...`);
    report(4, 'Reading PDF');
    const pages = await extractTextByPage(filePath);
    console.log(`[processDocument] Extracted ${pages.length} pages.`);

    const fullText = pages.map(p => p.text).join('\n\n').trim();
    if (fullText) {
      await db.update(documents).set({ content: fullText }).where(eq(documents.id, documentId));
    }

    // 2. Extract facts from every page (bounded concurrency).
    console.log(`[processDocument] Step 2: Extracting facts from ${pages.length} pages...`);
    let pagesDone = 0;
    const perPageFacts = await mapLimit(pages, PAGE_CONCURRENCY, async (page) => {
      const extracted = await extractFacts(page.text, page.page);
      pagesDone++;
      report(5 + 15 * (pagesDone / pages.length), `Extracting facts (${pagesDone}/${pages.length} pages)`);
      return extracted.map(f => ({ ...f, page: page.page }));
    });
    let allFacts = perPageFacts.flat();
    console.log(`[processDocument] Extracted ${allFacts.length} raw facts.`);

    allFacts = allFacts.filter(f => f && typeof f.text === 'string' && f.text.trim());
    if (MAX_FACTS && allFacts.length > MAX_FACTS) {
      console.log(`[processDocument] Capping ${allFacts.length} facts to MAX_FACTS=${MAX_FACTS} (set MAX_FACTS=0 to disable).`);
      allFacts = allFacts.slice(0, MAX_FACTS);
    }
    console.log(`[processDocument] ${allFacts.length} usable facts.`);

    if (allFacts.length === 0) {
      report(100, 'Done');
      await db.update(documents).set({ status: 'done' }).where(eq(documents.id, documentId));
      console.log(`[processDocument] No usable facts; marked ${documentId} done.`);
      return;
    }

    // 3a. Embed all fact texts.
    console.log(`[processDocument] Embedding ${allFacts.length} facts...`);
    report(22, `Embedding ${allFacts.length} facts`);
    const vectors = await embedTexts(allFacts.map(f => f.text));

    // 3b. Bulk-insert facts, keeping generated ids in input order.
    console.log(`[processDocument] Inserting ${allFacts.length} facts...`);
    report(34, 'Saving facts');
    const factRows = allFacts.map(f => {
      const attributes = {
        subject: f.subject ?? null,
        value: f.value ?? null,
        unit: f.unit ?? null,
        time_scope: f.time_scope ?? null,
      };
      return {
        documentId,
        text: f.text,
        page: f.page,
        spanStart: f.span_start,
        spanEnd: f.span_end,
        attributes,
        content: JSON.stringify({ ...f, ...attributes }),
      };
    });
    const insertedIds = [];
    for (const part of chunk(factRows, 1000)) {
      const rows = await db.insert(facts).values(part).returning({ id: facts.id });
      insertedIds.push(...rows.map(r => r.id));
    }
    allFacts.forEach((f, i) => { f.id = insertedIds[i]; f.vector = vectors[i]; });

    // 3c. Make every fact searchable before relationship detection.
    console.log(`[processDocument] Upserting ${allFacts.length} vectors...`);
    report(42, 'Indexing vectors');
    await upsertFactVectors(allFacts.map(f => ({ id: f.id, vector: f.vector })));

    const factById = new Map(allFacts.map(f => [f.id, f]));

    // 3d. Relationship detection - parallel across facts, bounded concurrency.
    console.log(`[processDocument] Judging relationships (concurrency ${FACT_CONCURRENCY})...`);
    let processed = 0;
    const relRows = [];
    await mapLimit(allFacts, FACT_CONCURRENCY, async (newFact) => {
      try {
        const candidates = await searchSimilarFacts(newFact.vector, TOP_K, newFact.id);
        const judged = await Promise.all(candidates.map(async (c) => {
          const other = factById.get(c.id);
          if (!other || other.id === newFact.id) return null;
          const candidateFact = {
            id: other.id,
            text: other.text,
            span_start: other.span_start,
            span_end: other.span_end,
            subject: other.subject ?? null,
            value: other.value ?? null,
            unit: other.unit ?? null,
            time_scope: other.time_scope ?? null,
          };
          const judgment = await judgeRelationship(newFact, candidateFact);
          return { candidateFact, judgment };
        }));
        for (const j of judged) {
          if (j && j.judgment.type !== 'unrelated') {
            relRows.push({
              sourceFactId: newFact.id,
              targetFactId: j.candidateFact.id,
              type: j.judgment.type,
              explanation: j.judgment.explanation,
              confidence: j.judgment.confidence,
            });
          }
        }
      } catch (err) {
        console.error(`[processDocument] Fact ${newFact.id} relationship step failed: ${err.message}`);
      } finally {
        processed++;
        if (processed % 25 === 0 || processed === allFacts.length) {
          report(45 + 53 * (processed / allFacts.length), `Analyzing relationships (${processed}/${allFacts.length})`);
          console.log(`[processDocument] Relationships: ${processed}/${allFacts.length} facts, ${relRows.length} found`);
        }
      }
    });

    // 3e. Bulk-insert relationships.
    if (relRows.length) {
      console.log(`[processDocument] Inserting ${relRows.length} relationships...`);
      report(99, 'Saving relationships');
      for (const part of chunk(relRows, 1000)) {
        await db.insert(relationships).values(part);
      }
    }

    // 4. Mark done.
    report(100, 'Done');
    await db.update(documents).set({ status: 'done' }).where(eq(documents.id, documentId));
    console.log(`[processDocument] Finished document ${documentId}: ${allFacts.length} facts, ${relRows.length} relationships.`);
  } catch (error) {
    console.error(`[processDocument] Error processing document ${documentId}:`, error);
    await db.update(documents).set({ status: 'failed' }).where(eq(documents.id, documentId));
    throw error;
  } finally {
    if (filePath) {
      fs.promises.unlink(filePath).catch(() => {});
    }
  }
}

module.exports = { processDocument };
