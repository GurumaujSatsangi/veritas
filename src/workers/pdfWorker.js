require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { Worker } = require('bullmq');
const Redis = require('ioredis');
const { processDocument } = require('../services/processDocument');

const connection = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

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
