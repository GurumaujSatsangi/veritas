require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const express = require('express');
const path = require('path');
const os = require('os');
const multer = require('multer');
const { Queue } = require('bullmq');
const Redis = require('ioredis');
const { eq, or, and, sql } = require('drizzle-orm');
const { alias } = require('drizzle-orm/pg-core');
const { db } = require('./db/client');
const { documents, facts, relationships } = require('./db/schema');

const connection = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

const pdfQueue = new Queue('pdf-processing', { connection });

const upload = multer({
  dest: os.tmpdir(),
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed'), false);
    }
  }
});

const app = express();
const port = process.env.PORT || 3000;

// The `facts` table stores structured columns, but the frontend still expects a
// JSON string under `content` (it does `JSON.parse`). Rebuild that shape here.
function factContentString(fact) {
  return JSON.stringify({
    text: fact.text,
    span_start: fact.spanStart,
    span_end: fact.spanEnd,
    ...(fact.attributes || {}),
  });
}

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.post('/documents/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No PDF file provided' });
    }

    // 1. Insert a documents row with status 'processing'
    const [insertedDoc] = await db.insert(documents).values({
      title: req.file.originalname,
      status: 'processing'
    }).returning({ id: documents.id });

    const documentId = insertedDoc.id;

    // 2. Enqueue the processing job
    const job = await pdfQueue.add('process-pdf', {
      documentId,
      filePath: req.file.path
    });

    // 3. Respond with ids the client polls for progress
    res.json({ documentId, jobId: job.id, status: 'processing' });

  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/documents/:id', async (req, res) => {
  try {
    const documentId = req.params.id;
    const [doc] = await db.select().from(documents).where(eq(documents.id, documentId));
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    res.json(doc);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Live processing progress for a queued job.
app.get('/jobs/:id', async (req, res) => {
  try {
    const job = await pdfQueue.getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const state = await job.getState();
    const progress = (job.progress && typeof job.progress === 'object') ? job.progress : { pct: 0, stage: 'Queued' };
    res.json({ id: job.id, state, progress });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/documents/:id/facts', async (req, res) => {
  try {
    const documentId = req.params.id;
    const docFacts = await db.select().from(facts).where(eq(facts.documentId, documentId));
    res.json(docFacts.map(f => ({
      id: f.id,
      documentId: f.documentId,
      page: f.page,
      createdAt: f.createdAt,
      content: factContentString(f),
    })));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

function selectRelationshipRows() {
  const sourceFact = alias(facts, 'sourceFact');
  const targetFact = alias(facts, 'targetFact');
  const sourceDoc = alias(documents, 'sourceDoc');
  const targetDoc = alias(documents, 'targetDoc');

  const query = db.select({
    id: relationships.id,
    type: relationships.type,
    explanation: relationships.explanation,
    confidence: relationships.confidence,
    sourceFactId: relationships.sourceFactId,
    targetFactId: relationships.targetFactId,
    sourceFactText: sourceFact.text,
    sourceFactSpanStart: sourceFact.spanStart,
    sourceFactSpanEnd: sourceFact.spanEnd,
    sourceFactAttributes: sourceFact.attributes,
    targetFactText: targetFact.text,
    targetFactSpanStart: targetFact.spanStart,
    targetFactSpanEnd: targetFact.spanEnd,
    targetFactAttributes: targetFact.attributes,
    sourceDocumentId: sourceDoc.id,
    sourceDocumentTitle: sourceDoc.title,
    targetDocumentId: targetDoc.id,
    targetDocumentTitle: targetDoc.title,
  })
  .from(relationships)
  .innerJoin(sourceFact, eq(relationships.sourceFactId, sourceFact.id))
  .innerJoin(targetFact, eq(relationships.targetFactId, targetFact.id))
  .innerJoin(sourceDoc, eq(sourceFact.documentId, sourceDoc.id))
  .innerJoin(targetDoc, eq(targetFact.documentId, targetDoc.id));

  return { query, sourceFact, targetFact };
}

function shapeRelationshipRow(r) {
  return {
    id: r.id,
    type: r.type,
    explanation: r.explanation,
    confidence: r.confidence,
    sourceFactId: r.sourceFactId,
    targetFactId: r.targetFactId,
    sourceFactContent: factContentString({
      text: r.sourceFactText,
      spanStart: r.sourceFactSpanStart,
      spanEnd: r.sourceFactSpanEnd,
      attributes: r.sourceFactAttributes,
    }),
    targetFactContent: factContentString({
      text: r.targetFactText,
      spanStart: r.targetFactSpanStart,
      spanEnd: r.targetFactSpanEnd,
      attributes: r.targetFactAttributes,
    }),
    sourceDocumentId: r.sourceDocumentId,
    sourceDocumentTitle: r.sourceDocumentTitle,
    targetDocumentId: r.targetDocumentId,
    targetDocumentTitle: r.targetDocumentTitle,
  };
}

function escapeHtml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function relationshipsPage(heading, rels) {
  const cards = rels.length ? rels.map(r => {
    const a = JSON.parse(r.sourceFactContent || '{}');
    const b = JSON.parse(r.targetFactContent || '{}');
    return `<div class="rel">
      <div class="pair">
        <div class="side"><div class="doc">${escapeHtml(r.sourceDocumentTitle)}</div><div>${escapeHtml(a.text || '')}</div></div>
        <div class="side"><div class="doc">${escapeHtml(r.targetDocumentTitle)}</div><div>${escapeHtml(b.text || '')}</div></div>
      </div>
      <div class="foot"><span class="badge ${escapeHtml(r.type)}">${escapeHtml(r.type)}</span>
      <span class="explain">${escapeHtml(r.explanation || '')}</span></div>
    </div>`;
  }).join('') : '<p class="muted">No relationships.</p>';

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(heading)}</title>
<style>
  :root{--bg:#fafafa;--card:#fff;--text:#1a1a1a;--muted:#6b7280;--border:#e5e7eb;
    --green-bg:#e7f6ec;--green-fg:#1a7f42;--red-bg:#fdeaea;--red-fg:#b42318;
    --amber-bg:#fdf4e3;--amber-fg:#92600b;--gray-bg:#eef0f2;--gray-fg:#4b5563;}
  @media (prefers-color-scheme:dark){:root{--bg:#14161a;--card:#1c1f24;--text:#e8eaed;--muted:#9aa0a6;--border:#2c2f36;
    --green-bg:#12331f;--green-fg:#6ee7a0;--red-bg:#3a1b1b;--red-fg:#f5a9a0;--amber-bg:#3a2f14;--amber-fg:#f0c674;--gray-bg:#2a2d33;--gray-fg:#b8bcc2;}}
  body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
  .wrap{max-width:860px;margin:0 auto;padding:40px 20px 80px}
  a{color:inherit}
  h1{font-size:20px;margin:0 0 4px}
  .muted{color:var(--muted)}
  .rel{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:14px;margin-bottom:10px}
  .pair{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  @media (max-width:560px){.pair{grid-template-columns:1fr}}
  .doc{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin-bottom:3px}
  .foot{margin-top:10px;padding-top:10px;border-top:1px solid var(--border);display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}
  .explain{font-size:13px;color:var(--muted)}
  .badge{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.03em;padding:2px 8px;border-radius:999px}
  .badge.corroborates{background:var(--green-bg);color:var(--green-fg)}
  .badge.contradicts{background:var(--red-bg);color:var(--red-fg)}
  .badge.reconciled{background:var(--amber-bg);color:var(--amber-fg)}
  .badge.unrelated{background:var(--gray-bg);color:var(--gray-fg)}
</style></head><body><div class="wrap">
<p class="muted"><a href="/">&larr; Home</a></p>
<h1>${escapeHtml(heading)}</h1>
<p class="muted">${rels.length} relationship${rels.length === 1 ? '' : 's'}</p>
${cards}
</div></body></html>`;
}

app.get('/documents/:id/relationships', async (req, res) => {
  try {
    const documentId = req.params.id;
    const { query, sourceFact, targetFact } = selectRelationshipRows();
    const rows = await query.where(or(
      eq(sourceFact.documentId, documentId),
      eq(targetFact.documentId, documentId)
    ));
    const rels = rows.map(shapeRelationshipRow);

    if (req.query.format === 'json') return res.json(rels);

    const [doc] = await db.select().from(documents).where(eq(documents.id, documentId));
    res.send(relationshipsPage(
      doc ? `Relationships for ${doc.title}` : 'Relationships',
      rels
    ));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/relationships', async (req, res) => {
  try {
    const { type, scope } = req.query;
    const { query, sourceFact, targetFact } = selectRelationshipRows();
    const conds = [];
    if (type) conds.push(eq(relationships.type, type));
    if (scope === 'cross') conds.push(sql`${sourceFact.documentId} <> ${targetFact.documentId}`);
    if (scope === 'same') conds.push(sql`${sourceFact.documentId} = ${targetFact.documentId}`);
    const rows = conds.length ? await query.where(and(...conds)) : await query;
    res.json(rows.map(shapeRelationshipRow));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: `Upload error: ${err.message}` });
  } else if (err) {
    return res.status(500).json({ error: err.message });
  }
  next();
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
