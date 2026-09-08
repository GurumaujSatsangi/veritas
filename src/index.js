require('dotenv').config();
const express = require('express');
const multer = require('multer');
const { Queue } = require('bullmq');
const Redis = require('ioredis');
const { db } = require('./db/client');
const { documents } = require('./db/schema');

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

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
