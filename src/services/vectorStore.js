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
      vectors: {
        size: 384,
        distance: 'Cosine',
      },
    });
    console.log(`Created collection: ${COLLECTION_NAME}`);
  } else {
    console.log(`Collection ${COLLECTION_NAME} already exists.`);
  }
}

async function upsertFactVector(factId, vector) {
  await client.upsert(COLLECTION_NAME, {
    wait: true,
    points: [
      {
        id: factId,
        vector: vector,
      },
    ],
  });
}

// Bulk upsert, chunked to keep request bodies reasonable.
async function upsertFactVectors(points, chunkSize = 256) {
  for (let i = 0; i < points.length; i += chunkSize) {
    const chunk = points.slice(i, i + chunkSize).map(p => ({ id: p.id, vector: p.vector }));
    await client.upsert(COLLECTION_NAME, { wait: true, points: chunk });
  }
}

async function searchSimilarFacts(vector, topK, excludeId) {
  let filter;
  if (excludeId !== undefined) {
    filter = {
      must_not: [
        {
          has_id: [excludeId],
        },
      ],
    };
  }

  // @qdrant/js-client-rest v1.19 removed `search` in favour of `query`.
  const results = await client.query(COLLECTION_NAME, {
    query: vector,
    limit: topK,
    filter: filter,
    with_payload: false, // just need id and score
  });

  return (results.points || []).map(r => ({
    id: r.id,
    score: r.score,
  }));
}

module.exports = {
  ensureCollection,
  upsertFactVector,
  upsertFactVectors,
  searchSimilarFacts,
};
