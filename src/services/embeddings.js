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

module.exports = { embedText };
