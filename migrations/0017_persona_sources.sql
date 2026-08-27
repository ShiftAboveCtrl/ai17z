-- AI17Z 0017: persona sources.
--
-- Learning an identity from a public corpus is a different thing from an agent
-- remembering a conversation, and mixing them was the mistake the legacy system
-- made: it dumped every scraped post into memory and the results were noisy.
--
-- Raw evidence is kept forever with its provenance. What gets *derived* from it
-- is separate, versioned, and always traceable back to the items that produced it.

CREATE TABLE persona_sources (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id       uuid NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('x_public', 'manual')),
  -- Remote identity this corpus came from, e.g. an X handle.
  handle         text,
  label          text NOT NULL DEFAULT '',
  config         jsonb NOT NULL DEFAULT '{}'::jsonb,
  status         text NOT NULL DEFAULT 'IDLE'
                 CHECK (status IN ('IDLE','SYNCING','READY','ERROR','UNAVAILABLE')),
  last_error     text,
  last_synced_at timestamptz,
  -- Cursor for incremental sync: the newest remote id already ingested.
  sync_cursor    text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, kind, handle)
);

CREATE TABLE persona_source_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id        uuid NOT NULL REFERENCES persona_sources (id) ON DELETE CASCADE,
  -- Provenance, kept so a derived trait can always be traced to its evidence.
  remote_id        text NOT NULL,
  url              text,
  item_kind        text NOT NULL DEFAULT 'post' CHECK (item_kind IN ('post','reply','quote','unknown')),
  raw_text         text NOT NULL,
  normalized_text  text NOT NULL,
  content_hash     text NOT NULL,
  remote_created_at timestamptz,
  raw              jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Scores drive selection; they are stored so the owner can see why.
  style_score      real NOT NULL DEFAULT 0,
  persona_score    real NOT NULL DEFAULT 0,
  belief_score     real NOT NULL DEFAULT 0,
  knowledge_score  real NOT NULL DEFAULT 0,
  noise_score      real NOT NULL DEFAULT 0,
  classification   text NOT NULL DEFAULT 'unclassified',
  excluded         boolean NOT NULL DEFAULT false,
  exclusion_reason text,
  -- The owner overrides the machine. Null means no override.
  owner_override   boolean,
  ingested_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, remote_id)
);

-- Near-duplicate suppression: identical normalised content collapses per source.
CREATE UNIQUE INDEX persona_source_items_content_key ON persona_source_items (source_id, content_hash);
CREATE INDEX persona_source_items_selection_idx ON persona_source_items (source_id, excluded, style_score DESC);

CREATE TABLE persona_traits (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id    uuid NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  source_id   uuid REFERENCES persona_sources (id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('style','belief','topic','example','language')),
  content     text NOT NULL,
  confidence  real NOT NULL DEFAULT 0.5,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, kind, content)
);

-- Which items produced a trait. Without this a derived trait is an assertion.
CREATE TABLE persona_trait_evidence (
  trait_id uuid NOT NULL REFERENCES persona_traits (id) ON DELETE CASCADE,
  item_id  uuid NOT NULL REFERENCES persona_source_items (id) ON DELETE CASCADE,
  PRIMARY KEY (trait_id, item_id)
);
