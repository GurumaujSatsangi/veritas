require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const express = require('express');
const path = require('path');
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
  dest: '/tmp',
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

    // 1. Insert a row into the documents table with status 'processing'
    const [insertedDoc] = await db.insert(documents).values({
      title: req.file.originalname,
      status: 'processing'
    }).returning({ id: documents.id });

    const documentId = insertedDoc.id;

    // 2. Respond immediately with { documentId, status: 'processing' }
    res.json({ documentId, status: 'processing' });

    // 3. Kick off async processing
    await pdfQueue.add('process-pdf', {
      documentId,
      filePath: req.file.path
    });

  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/documents/:id', async (req, res) => {
  try {
    const documentId = parseInt(req.params.id);
    const [doc] = await db.select().from(documents).where(eq(documents.id, documentId));
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    res.json(doc);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/documents/:id/facts', async (req, res) => {
  try {
    const documentId = parseInt(req.params.id);
    const docFacts = await db.select().from(facts).where(eq(facts.documentId, documentId));
    res.json(docFacts);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/documents/:id/relationships', async (req, res) => {
  try {
    const documentId = parseInt(req.params.id);
    const sourceFact = alias(facts, 'sourceFact');
    const targetFact = alias(facts, 'targetFact');
    const sourceDoc = alias(documents, 'sourceDoc');
    const targetDoc = alias(documents, 'targetDoc');

    const rels = await db.select({
      id: relationships.id,
      type: relationships.type,
      sourceFactId: relationships.sourceFactId,
      targetFactId: relationships.targetFactId,
      sourceFactContent: sourceFact.content,
      targetFactContent: targetFact.content,
      sourceDocumentId: sourceDoc.id,
      sourceDocumentTitle: sourceDoc.title,
      targetDocumentId: targetDoc.id,
      targetDocumentTitle: targetDoc.title,
    })
    .from(relationships)
    .innerJoin(sourceFact, eq(relationships.sourceFactId, sourceFact.id))
    .innerJoin(targetFact, eq(relationships.targetFactId, targetFact.id))
    .innerJoin(sourceDoc, eq(sourceFact.documentId, sourceDoc.id))
    .innerJoin(targetDoc, eq(targetFact.documentId, targetDoc.id))
    .where(or(
      eq(sourceFact.documentId, documentId),
      eq(targetFact.documentId, documentId)
    ));

    res.json(rels);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/relationships', async (req, res) => {
  try {
    const type = req.query.type;
    
    const sourceFact = alias(facts, 'sourceFact');
    const targetFact = alias(facts, 'targetFact');
    const sourceDoc = alias(documents, 'sourceDoc');
    const targetDoc = alias(documents, 'targetDoc');

    let query = db.select({
      id: relationships.id,
      type: relationships.type,
      sourceFactId: relationships.sourceFactId,
      targetFactId: relationships.targetFactId,
      sourceFactContent: sourceFact.content,
      targetFactContent: targetFact.content,
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

    if (type) {
      query = query.where(eq(relationships.type, type));
    }

    const rels = await query;
    res.json(rels);
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
