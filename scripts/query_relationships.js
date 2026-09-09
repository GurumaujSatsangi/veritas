require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { eq } = require('drizzle-orm');
const { db } = require('../src/db/client');
const { relationships, facts, documents } = require('../src/db/schema');
const fs = require('fs');

async function run() {
  // Fetch all relationships
  const rels = await db.select().from(relationships);
  // Actually, simpler to just fetch all relationships and then lookup facts
  const factsList = await db.select().from(facts);
  const docsList = await db.select().from(documents);
  
  const factMap = new Map();
  factsList.forEach(f => factMap.set(f.id, { text: f.text, ...(f.attributes || {}) }));

  const docMap = new Map();
  docsList.forEach(d => docMap.set(d.id, d.title));

  const output = rels.map(r => {
    const srcFact = factMap.get(r.sourceFactId);
    const tgtFact = factMap.get(r.targetFactId);
    return {
      type: r.type,
      source: srcFact?.text,
      target: tgtFact?.text,
    };
  });
  
  fs.writeFileSync('relationships_dump.json', JSON.stringify(output, null, 2));
  
  console.log(`Dumped ${output.length} relationships.`);
  
  // Group by type
  const counts = output.reduce((acc, curr) => {
    acc[curr.type] = (acc[curr.type] || 0) + 1;
    return acc;
  }, {});
  console.log('Counts:', counts);
  process.exit(0);
}

run().catch(console.error);
