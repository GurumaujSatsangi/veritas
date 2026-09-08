const { eq } = require('drizzle-orm');
const { db } = require('../db/client');
const { documents, facts, relationships } = require('../db/schema');
const { extractTextByPage } = require('./pdfParser');
const { extractFacts } = require('./factExtractor');
const { embedText } = require('./embeddings');
const { ensureCollection, upsertFactVector, searchSimilarFacts } = require('./vectorStore');
const { judgeRelationship } = require('./relationshipJudge');

async function processDocument(documentId, filePath) {
  try {
    console.log(`[processDocument] Starting pipeline for documentId=${documentId}`);
    
    // Ensure the Qdrant collection exists before writing vectors
    await ensureCollection();
    
    console.log(`[processDocument] Step 1: Extracting text by page from PDF...`);
    // 1. extractTextByPage(filePath)
    const pages = await extractTextByPage(filePath);
    console.log(`[processDocument] Extracted ${pages.length} pages.`);

    // 2. for each page: extractFacts(text, page)
    for (const page of pages) {
      console.log(`[processDocument] Step 2: Extracting facts from page ${page.page}...`);
      const extractedFacts = await extractFacts(page.text, page.page);
      console.log(`[processDocument] Found ${extractedFacts.length} facts on page ${page.page}.`);

      // 3. for each extracted fact:
      for (const newFact of extractedFacts) {
        console.log(`[processDocument] Step 3: Processing new fact: "${newFact.text.substring(0, 50)}..."`);
        
        // a. insert into facts table, get its id
        const [insertedRow] = await db.insert(facts).values({
          documentId,
          content: JSON.stringify(newFact)
        }).returning({ id: facts.id });
        const newFactId = insertedRow.id;
        newFact.id = newFactId;

        // b. embed the fact text
        console.log(`[processDocument] Embedding fact ${newFactId}...`);
        const vector = await embedText(newFact.text);

        // c. searchSimilarFacts(vector, topK=5, excludeId=newFactId)
        console.log(`[processDocument] Searching similar facts in vector store...`);
        const candidates = await searchSimilarFacts(vector, 5, newFactId);
        console.log(`[processDocument] Found ${candidates.length} similar candidates for fact ${newFactId}.`);

        // d. for each candidate: fetch full fact row from Postgres by id
        for (const candidate of candidates) {
          console.log(`[processDocument] Evaluating candidate fact ${candidate.id} (score: ${candidate.score.toFixed(3)})`);
          const [candidateRow] = await db.select().from(facts).where(eq(facts.id, candidate.id));
          
          if (!candidateRow) continue;
          
          const candidateFact = JSON.parse(candidateRow.content);
          candidateFact.id = candidateRow.id;

          // e. judgeRelationship(newFact, candidateFact)
          const judgment = await judgeRelationship(newFact, candidateFact);
          
          console.log(`[processDocument] Judgment: ${judgment.type} (Confidence: ${judgment.confidence}) -> ${judgment.explanation}`);

          // f. if type != 'unrelated', insert a row into relationships
          if (judgment.type !== 'unrelated') {
            await db.insert(relationships).values({
              sourceFactId: newFactId,
              targetFactId: candidateFact.id,
              type: judgment.type
            });
            console.log(`[processDocument] Inserted relationship: ${newFactId} -> ${candidateFact.id} [${judgment.type}]`);
          }
        }

        // g. upsertFactVector(newFact.id, vector)
        await upsertFactVector(newFactId, vector);
        console.log(`[processDocument] Upserted vector for fact ${newFactId}.`);
      }
    }

    // 4. update documents.status to 'done'
    console.log(`[processDocument] Marking document ${documentId} as 'done'.`);
    await db.update(documents)
      .set({ status: 'done' })
      .where(eq(documents.id, documentId));

    console.log(`[processDocument] Finished processing document ${documentId} successfully.`);
  } catch (error) {
    console.error(`[processDocument] Error processing document ${documentId}:`, error);
    await db.update(documents)
      .set({ status: 'failed' })
      .where(eq(documents.id, documentId));
  }
}

module.exports = { processDocument };
