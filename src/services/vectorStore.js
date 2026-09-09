const { QdrantClient } = require('@qdrant/js-client-rest');

const client = new QdrantClient({
  url: process.env.QDRANT_URL,
  apiKey: process.env.QDRANT_API_KEY,
});

const COLLECTION_NAME = 'facts';

async function ensureCollection() {
  const response = await client.getCollections();
  const exists = response.collections.some(c => c.name === COLLECTION_NAME);

  if (!exists) {
    await client.createCollection(COLLECTION_NAME, {
      vectors: { size: 384, distance: 'Cosine' },
    });
    console.log(`Created collection: ${COLLECTION_NAME}`);
  } else {
    console.log(`Collection ${COLLECTION_NAME} already exists.`);
  }
  // Index the documentId payload so we can filter searches by document.
  try {
    await client.createPayloadIndex(COLLECTION_NAME, {
      field_name: 'documentId',
      field_schema: 'keyword',
      wait: true,
    });
  } catch (_) { /* already exists */ }
}

async function upsertFactVector(factId, vector, documentId) {
  await client.upsert(COLLECTION_NAME, {
    wait: true,
    points: [{ id: factId, vector, payload: documentId ? { documentId } : undefined }],
  });
}

// Bulk upsert, chunked to keep request bodies reasonable.
// points: [{ id, vector, documentId }]
async function upsertFactVectors(points, chunkSize = 256) {
  for (let i = 0; i < points.length; i += chunkSize) {
    const chunk = points.slice(i, i + chunkSize).map(p => ({
      id: p.id,
      vector: p.vector,
      payload: p.documentId ? { documentId: p.documentId } : undefined,
    }));
    await client.upsert(COLLECTION_NAME, { wait: true, points: chunk });
  }
}

/**
 * Nearest facts to `vector`.
 * opts.excludeId          - drop this exact fact
 * opts.sameDocumentId     - drop every fact from this document (cross-document search)
 */
async function searchSimilarFacts(vector, topK, opts = {}) {
  // Back-compat: a bare string/number means excludeId.
  if (typeof opts === 'string' || typeof opts === 'number') opts = { excludeId: opts };

  const mustNot = [];
  if (opts.excludeId !== undefined && opts.excludeId !== null) {
    mustNot.push({ has_id: [opts.excludeId] });
  }
  if (opts.sameDocumentId) {
    mustNot.push({ key: 'documentId', match: { value: opts.sameDocumentId } });
  }

  const results = await client.query(COLLECTION_NAME, {
    query: vector,
    limit: topK,
    filter: mustNot.length ? { must_not: mustNot } : undefined,
    with_payload: false,
  });

  return (results.points || []).map(r => ({ id: r.id, score: r.score }));
}

module.exports = {
  client,
  COLLECTION_NAME,
  ensureCollection,
  upsertFactVector,
  upsertFactVectors,
  searchSimilarFacts,
};
