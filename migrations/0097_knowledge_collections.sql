-- Knowledge collections: a documentation site or a repository as one source,
-- kept current a document at a time.
--
-- A collection is still a knowledge source. Its chunks are still KNOWLEDGE
-- memories with a knowledge_source_id, retrieved, ranked and cited exactly as
-- before; nothing here adds a second store or a second search path. What is
-- new is that one source can hold many documents, so the source learns which
-- documents it holds (knowledge_documents) and a refresh rewrites only the
-- documents that changed, drops the ones that went, and says which.
--
-- DOCUMENTATION_SITE follows links, which a URL source deliberately never did.
-- It is bounded by construction: one host, one path prefix, robots.txt
-- honoured, and a page, byte and time budget in `config` that the crawler
-- enforces whatever the config says above its own hard ceilings.
--
-- GITHUB_REPOSITORY reads a repository at a commit, through its tree rather
-- than its web pages, so every chunk carries a path and a commit.

ALTER TABLE knowledge_sources DROP CONSTRAINT IF EXISTS knowledge_sources_kind_check;
ALTER TABLE knowledge_sources
  ADD CONSTRAINT knowledge_sources_kind_check
  CHECK (kind IN ('UPLOAD', 'PATH', 'TEXT', 'URL', 'DOCUMENTATION_SITE', 'GITHUB_REPOSITORY'));

ALTER TABLE knowledge_sources
  -- Crawl bounds, repository ref and path filters. Validated by the contract.
  ADD COLUMN IF NOT EXISTS config jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- What this source is, for answers that must not mix generations:
  -- { version, generation, effectiveDate, authority }. Pons V1 and Pons V2 are
  -- two collections with two labels, never one blob.
  ADD COLUMN IF NOT EXISTS labels jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Freshness, as facts rather than a verdict. The screen derives Healthy,
  -- Refresh due, Refreshing, Changed, Failed and Unavailable from these.
  ADD COLUMN IF NOT EXISTS refreshing_since timestamptz,
  ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_success_at timestamptz,
  -- UNAVAILABLE: the source itself is gone or refuses (404, robots, private).
  -- FAILED: this attempt went wrong in a way the next one may not.
  -- A plain IN admits NULL already (a CHECK fails only on false), and is the
  -- shape the constrained-enum registry can read.
  ADD COLUMN IF NOT EXISTS error_kind text CHECK (error_kind IN ('FAILED', 'UNAVAILABLE')),
  -- { added, changed, removed, unchanged, at }: what the last refresh did.
  ADD COLUMN IF NOT EXISTS last_change jsonb;

CREATE TABLE knowledge_documents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id    uuid NOT NULL REFERENCES knowledge_sources (id) ON DELETE CASCADE,
  -- The page URL or repository path. What a chunk's origin.path holds.
  doc_key      text NOT NULL,
  title        text,
  -- DOC: documentation prose. SOURCE: code, read only when the owner chose a
  -- source path. README: a repository's front page. PAGE: a site page.
  doc_kind     text NOT NULL CHECK (doc_kind IN ('DOC', 'SOURCE', 'README', 'PAGE')),
  -- The blob sha for a repository file, the content hash for a page. Equal
  -- revision, nothing to rewrite.
  revision     text NOT NULL,
  content_hash text NOT NULL,
  chunk_count  integer NOT NULL DEFAULT 0,
  fetched_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, doc_key)
);
CREATE INDEX knowledge_documents_source ON knowledge_documents (source_id);
