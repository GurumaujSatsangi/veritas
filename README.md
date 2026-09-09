# Veritas — Fact Extractor & Cross-Document Analyzer

Upload PDFs. Veritas pulls out the factual claims, then compares every claim
against the claims in your **other** documents and labels how they relate:

| Label | Meaning |
|---|---|
| `corroborates` | Both claims say the same thing |
| `contradicts` | The claims genuinely conflict |
| `reconciled` | They look like a conflict, but a difference in time period / unit / scope explains it |
| `unrelated` | Different topics — not stored |

---

## Tech stack

- **Node.js + Express** — HTTP API and static frontend
- **BullMQ + Redis** — background job queue (PDF processing runs off the request)
- **Postgres (Neon) + Drizzle ORM** — stores documents, facts, relationships
- **Qdrant** — vector database for similarity search
- **OpenAI `gpt-4o-mini`** — extracts facts and classifies relationships
- **`@xenova/transformers` (`all-MiniLM-L6-v2`)** — 384-dim sentence embeddings, run locally
- **`pdf-parse`** — PDF text extraction
- Plain HTML/CSS/JS frontend (no framework)

---

## How it works

```
upload PDF ──▶ API saves a `documents` row + queues a job ──▶ returns immediately
                                   │
                          BullMQ worker picks it up
                                   │
   1. pdf-parse          → text, page by page
   2. gpt-4o-mini        → structured facts per page {text, subject, value, unit, time_scope, page}
   3. all-MiniLM-L6-v2   → embed every fact (batched, local)
   4. Postgres           → bulk-insert facts
   5. Qdrant             → bulk-upsert vectors, tagged with the document id
   6. for each fact:     → nearest facts overall + nearest facts in OTHER documents
   7. gpt-4o-mini        → judge each candidate pair (corroborates / contradicts / reconciled / unrelated)
   8. Postgres           → bulk-insert the non-unrelated pairs
```

Progress (`{pct, stage}`) is reported to the job the whole way through, so the UI
shows a live progress bar and ETA.

**Cross-document matching is incremental.** A document is only compared against
documents that were already uploaded when it ran. Upload the reference document
first, then newer ones — or run `npm run reanalyze` once to backfill
cross-document relationships across the whole corpus.

---

## Setup

```bash
npm install
```

Create `.env`:

```
OPENAI_API_KEY=sk-...
DATABASE_URL=postgresql://user:pass@host/db?sslmode=require   # Neon
QDRANT_URL=https://xxxx.cloud.qdrant.io
QDRANT_API_KEY=...
REDIS_URL=redis://default:pass@host:port
PORT=3000
```

Redis must have `maxmemory-policy noeviction` (BullMQ requirement).

The Postgres schema lives in [`src/db/schema.js`](src/db/schema.js); `npm run db:push`
syncs it to the database.

Optional tuning env vars: `JUDGE_MODEL` (default `gpt-4o-mini`), `MAX_FACTS`
(default `600`, `0` = no cap), `TOP_K` (default `3`), `FACT_CONCURRENCY` (default
`8`), `PAGE_CONCURRENCY` (default `6`), `EMBED_BATCH_SIZE` (default `64`).

---

## Running

Two processes, two terminals:

```bash
npm run dev      # API + frontend on http://localhost:3000
npm run worker   # background PDF processor
```

Open `http://localhost:3000`, upload a PDF, watch the progress bar. Upload a
second related PDF to get cross-document relationships.

```bash
npm run reanalyze   # backfill cross-document relationships for docs already uploaded
node scripts/upload.js   # batch-upload the PDFs in samples/ and poll until done
```

---

## API

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/documents/upload` | Upload a PDF → `{ documentId, jobId }` |
| `GET` | `/jobs/:id` | Job state + `{ pct, stage }` progress |
| `GET` | `/documents/:id` | Document row (incl. `status`) |
| `GET` | `/documents/:id/facts` | Facts extracted from a document |
| `GET` | `/documents/:id/relationships` | HTML page of that document's relationships (`?format=json` for JSON) |
| `GET` | `/relationships` | All relationships. `?type=contradicts` `?scope=cross\|same` |
| `GET` | `/health` | `{ status: "ok" }` |

---

## Database

| Table | Key columns |
|---|---|
| `documents` | `id`, `title`, `content`, `status`, `created_at` |
| `facts` | `id`, `document_id`, `text`, `page`, `span_start`, `span_end`, `attributes` (jsonb) |
| `relationships` | `id`, `source_fact_id`, `target_fact_id`, `type`, `explanation`, `confidence` |

---

## Known limitations

- **Context loss on extraction** — a fact is sometimes pulled without its
  surrounding qualifier (e.g. "*global* logistics cost is 14% of GDP" → "logistics
  cost is 14% of GDP"), which can make the judge see a false contradiction.
- **Incremental matching** — see above; `npm run reanalyze` is the workaround.
- **Fact cap** — `MAX_FACTS` (default 600) limits LLM calls on very large PDFs;
  raise or disable it if you need every fact.
- **Cloud dependencies** — Redis, Qdrant, Postgres, and OpenAI are all remote; a
  network blip during a run marks the document `failed` (re-upload to retry).
