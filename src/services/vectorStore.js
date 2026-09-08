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

  const results = await client.search(COLLECTION_NAME, {
    vector: vector,
    limit: topK,
    filter: filter,
    with_payload: false, // Don't need payload for now, just id and score
  });
  
  return results.map(r => ({
    id: r.id,
    score: r.score,
  }));
}

module.exports = {
  ensureCollection,
  upsertFactVector,
  searchSimilarFacts,
};
