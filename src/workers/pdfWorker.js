require('dotenv').config();
const { Worker } = require('bullmq');
const Redis = require('ioredis');
const { db } = require('../db/client');
const { documents } = require('../db/schema');
const { eq } = require('drizzle-orm');
const { extractTextByPage } = require('../services/pdfParser');

const connection = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

async function processDocument(documentId, filePath) {
  try {
    console.log(`Starting extraction for document ${documentId} from ${filePath}`);
    const pages = await extractTextByPage(filePath);
    
    // Combine page texts
    const fullText = pages.map(p => p.text).join('\n');
    
    // Update document status and content
    await db.update(documents)
      .set({ 
        status: 'completed',
        content: fullText 
      })
      .where(eq(documents.id, documentId));
      
    console.log(`Document ${documentId} processed successfully.`);
  } catch (error) {
    console.error(`Error processing document ${documentId}:`, error);
    await db.update(documents)
      .set({ status: 'failed' })
      .where(eq(documents.id, documentId));
  }
}

const worker = new Worker('pdf-processing', async job => {
  const { documentId, filePath } = job.data;
  console.log(`Processing job ${job.id} for document ${documentId}`);
  await processDocument(documentId, filePath);
}, { connection });

worker.on('completed', job => {
  console.log(`Job ${job.id} has completed!`);
});

worker.on('failed', (job, err) => {
  console.log(`Job ${job.id} has failed with ${err.message}`);
});
