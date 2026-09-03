-- Teaching an agent a body of knowledge, from a source the owner controls.
--
-- Not an AI17Z feature that happens to be reusable: a general one whose first
-- user is AI17Z's own documentation. The agent answering questions about the
-- software it runs on is a proving case, and the reason it is a good one is
-- that it forces every hard part into the open -- keeping an index current as
-- the source changes, saying which version an answer came from, and preferring
-- what the documents say now over what a conversation said last week.
--
-- Chunks are ordinary KNOWLEDGE memories. Retrieval, ranking, the trace and the
-- prompt layer already exist and work; nothing here needs its own store, its own
-- index or its own search path.

CREATE TABLE knowledge_sources (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id     uuid NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  -- What the owner calls it. Shown as the attribution on an answer.
  name         text NOT NULL,
  -- UPLOAD: files sent through the interface, stored by the API.
  -- PATH:   a directory the server itself can read.
  -- TEXT:   pasted straight in.
  kind         text NOT NULL CHECK (kind IN ('UPLOAD', 'PATH', 'TEXT')),
  -- For PATH, the directory. For UPLOAD, where the API put the files. Null for TEXT.
  location     text,
  -- Which files count. Empty means the ingester's own defaults.
  include      text[] NOT NULL DEFAULT '{}',
  -- What the source was when it was last read: a commit hash, a release, a
  -- date. This is what lets an answer say which version it describes, and what
  -- makes "current documentation beats old conversation memory" checkable
  -- rather than aspirational.
  revision     text,
  enabled      boolean NOT NULL DEFAULT true,
  indexed_at   timestamptz,
  document_count integer NOT NULL DEFAULT 0,
  chunk_count    integer NOT NULL DEFAULT 0,
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- One name per agent, so "AI17Z documentation" means one thing in an answer.
CREATE UNIQUE INDEX knowledge_sources_agent_name ON knowledge_sources (agent_id, lower(name));
CREATE INDEX knowledge_sources_agent ON knowledge_sources (agent_id, enabled);

-- Which source a chunk came from, and where in it.
--
-- ON DELETE CASCADE is the point of the column: removing a source has to remove
-- what it taught, or an agent goes on citing documents its owner has withdrawn.
ALTER TABLE memories
  ADD COLUMN knowledge_source_id uuid REFERENCES knowledge_sources (id) ON DELETE CASCADE,
  -- { path, heading, revision, modifiedAt } -- kept together because they are
  -- only ever read together, when attributing an answer to a document.
  ADD COLUMN origin jsonb;

CREATE INDEX memories_knowledge_source ON memories (knowledge_source_id) WHERE knowledge_source_id IS NOT NULL;
