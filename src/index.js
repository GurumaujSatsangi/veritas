require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const express = require('express');
const path = require('path');
const os = require('os');
const multer = require('multer');
const { Queue } = require('bullmq');
const Redis = require('ioredis');
const { eq, or } = require('drizzle-orm');
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

app.get('/documents/:id/relationships', async (req, res) => {
  try {
    const documentId = req.params.id;
    const { query, sourceFact, targetFact } = selectRelationshipRows();
    const rows = await query.where(or(
      eq(sourceFact.documentId, documentId),
      eq(targetFact.documentId, documentId)
    ));
    res.json(rows.map(shapeRelationshipRow));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/relationships', async (req, res) => {
  try {
    const type = req.query.type;
    const { query } = selectRelationshipRows();
    const rows = type ? await query.where(eq(relationships.type, type)) : await query;
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
