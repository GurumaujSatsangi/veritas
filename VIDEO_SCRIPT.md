# Veritas — 2-minute video script

Target: ~2:00 at a normal speaking pace (~300 words of narration).
Each section has a rough timestamp, a visual cue, and the words to say.

---

### 0:00 – 0:15 — The problem

**Visual:** Two report PDFs side by side (e.g. a company prospectus and its later annual report), scrolling.

> When you compare two reports about the same thing, the claims rarely line up — and checking every number by hand takes hours. Veritas does that cross-checking for you.

---

### 0:15 – 0:50 — What it does (demo)

**Visual:** The home page. Drag in a PDF, click **Analyze**. Progress bar fills with a stage label and an ETA. Then the facts table appears, then the relationship cards.

> I upload a PDF. The app hands it to a background worker straight away and shows a live progress bar with a time estimate.
>
> Behind the scenes it reads the PDF page by page, and an AI model pulls out every factual claim — the wording, the subject, any number, unit and time period, and the page it came from.
>
> Every fact becomes a vector — a numeric fingerprint of its meaning — stored in a vector database. Then, for each fact, the app finds the most similar facts in the **other** documents, and a second AI pass decides how they relate: do they agree, do they contradict, or do they only *look* like a contradiction because one is a yearly average and the other is a quarter-end number?
>
> Each result card shows both facts, both documents and page numbers, the label, and a one-line explanation.

---

### 0:50 – 1:35 — How it works / tech stack

**Visual:** Simple architecture diagram: Browser → Express API → Redis queue → Worker → (pdf-parse, OpenAI, local embeddings, Qdrant, Postgres).

> The whole stack is Node. Express serves the API and the page. Uploads go onto a Redis-backed BullMQ queue, so the web request returns instantly and the heavy work runs in a separate worker process.
>
> Text extraction is `pdf-parse`. Fact extraction and relationship judging both use OpenAI's `gpt-4o-mini` with structured function calling, so the output is always clean JSON.
>
> Embeddings run locally with a small sentence-transformer model, so there's no per-embedding cost. Similarity search is Qdrant — and every vector is tagged with its document, which lets us run a dedicated "other documents only" search. That's what surfaces the cross-document matches.
>
> Facts and relationships live in Postgres through Drizzle ORM. Inserts and embeddings are batched, and the judging runs several facts in parallel, so a large document finishes in a couple of minutes.

---

### 1:35 – 2:00 — Upload order + close

**Visual:** The "how to upload" steps on the home page; then the "Between two documents" filter showing cross-doc contradictions.

> One thing to know: matching is incremental. Each document is compared against the ones already uploaded, so upload the older document first, then the newer one. If you add them out of order, one command — `npm run reanalyze` — re-checks the whole set.
>
> That's Veritas: upload your PDFs, get a checked list of where they agree and disagree — with the receipts.
