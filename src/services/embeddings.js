let pipeline;

async function getPipeline() {
  if (!pipeline) {
    // Dynamically import @xenova/transformers (ESM module)
    const transformers = await import('@xenova/transformers');
    pipeline = await transformers.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  }
  return pipeline;
}

async function embedText(text) {
  const extractor = await getPipeline();
  // Mean pooling and normalization
  const output = await extractor(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

// Embed many texts, batched in chunks. Returns an array of number[] vectors
// aligned with the input order. Non-string / empty entries are embedded as a
// single space so the output stays index-aligned with the input.
async function embedTexts(texts, batchSize = Number(process.env.EMBED_BATCH_SIZE) || 64) {
  if (!texts.length) return [];
  const extractor = await getPipeline();
  const safe = texts.map(t => (typeof t === 'string' && t.trim() ? t : ' '));
  const vectors = [];
  for (let i = 0; i < safe.length; i += batchSize) {
    const batch = safe.slice(i, i + batchSize);
    const output = await extractor(batch, { pooling: 'mean', normalize: true });
    vectors.push(...output.tolist());
  }
  return vectors;
}

module.exports = { embedText, embedTexts };
