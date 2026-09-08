# Superjoin Fact Extractor & Analyzer

Superjoin is an intelligent document processing pipeline that extracts factual claims from PDFs, generates vector embeddings, and cross-references facts across documents to discover relationships (Corroborates, Contradicts, Reconciled, Unrelated).

## Architecture

1. **Upload**: PDFs are uploaded to an Express API and stored temporarily.
2. **Background Processing**: A BullMQ worker picks up the job.
3. **Extraction**: Text is extracted using `pdf-parse`.
4. **Fact Identification**: `gpt-4o-mini` extracts structured JSON facts (text, subject, value, unit, time_scope).
5. **Vector Search**: Facts are embedded using `all-MiniLM-L6-v2` and searched against a Qdrant vector database.
6. **Relationship Judging**: `gpt-4o` evaluates candidate pairs to classify their logical relationship.
7. **Persistence**: Facts and Relationships are stored in a Postgres database via Drizzle ORM.
8. **Visualization**: A responsive, glassmorphism-styled UI allows users to view the global knowledge graph and filter contradictions.

## Sample Relationships

Here are examples of relationships discovered by the pipeline (based on the provided sample documents):

### 1. Corroborates (Clear Evidence)
* **Fact A** (Delhivery Prospectus 2022): "Delhivery is India's largest fully integrated logistics services player by revenue."
* **Fact B** (Delhivery Annual Report FY24): "We have maintained our position as the leading logistics provider in the country."
* **Relationship**: Corroborates
* **Explanation**: Both facts support the claim that Delhivery holds the leading market position in Indian logistics.

### 2. Contradicts (Direct Opposition)
* **Fact A** (Delhivery Prospectus 2022): "The company operates 20 automated sortation centers."
* **Fact B** (Delhivery Q4 FY24 Earnings): "We currently operate 24 automated sortation centers."
* **Relationship**: Contradicts
* **Explanation**: The number of sortation centers directly conflicts (20 vs 24). *(Note: A naive judge flags this as a contradiction if it misses the temporal context).*

### 3. Reconciled (Contextual Resolution)
* **Fact A** (India Economic Survey 2024-25): "Retail inflation averaged 5.4%."
* **Fact B** (RBI Annual Report 2024-25): "CPI inflation was recorded at 4.8% by Q4."
* **Relationship**: Reconciled
* **Explanation**: The difference is reconciled by the time scope; the Economic Survey provides an annual average, while the RBI report specifies the Q4 end-of-period rate.

### 4. Failure Example & Known Limitations
* **Fact A**: "Logistics costs are 14% of GDP."
* **Fact B**: "Logistics costs have reduced to 8% of GDP."
* **Failure Type**: Misjudged as "Contradicts"
* **Explanation**: The model extracted the facts but failed to extract the geographical scope (e.g., India vs. Global average) from the surrounding text. The relationship judge then incorrectly flagged it as a contradiction. 

### Current System Limitations
1. **Context Loss During Extraction**: The fact extractor (gpt-4o-mini) sometimes isolates a fact but loses the broader paragraph context (e.g., "According to competitor X, our revenue is Y").
2. **Network Resilience**: The pipeline heavily relies on external cloud services (Redis Cloud for BullMQ, Qdrant Cloud for vectors). During testing, network drops resulted in `ENOTFOUND` and `ETIMEDOUT` errors to Redis Cloud, which can crash the worker and leave documents stuck in a 'processing' state. A production deployment should implement robust retry logic or use a local Redis instance.
3. **Database Schema Syncing**: Manual schema updates were required because Drizzle ORM `push` fails in non-TTY environments when columns are renamed (e.g., migrating `filename` to `title`).
