-- Multimodal context: what a post actually contains.
--
-- Events carried text and nothing else. A mention whose entire substance is in
-- an attached chart, or in the post it quotes, arrived as "what do you think?"
-- and the agent answered as though that were the whole message.
--
-- Media is stored per event rather than flattened into one string, so the model
-- can be told which image the question is about and the trace can show what was
-- looked at.

CREATE TABLE event_media (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id     uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  -- image | gif | video | link | poll
  kind         text NOT NULL,
  -- Order within the post, because "the second chart" is a real thing to mean.
  position     integer NOT NULL DEFAULT 0,
  -- Where it lives remotely. Not downloaded unless policy says to.
  source_url   text,
  -- Set only when the bytes were actually retained.
  artifact_id  uuid REFERENCES artifacts(id) ON DELETE SET NULL,
  alt_text     text,

  -- What was understood, and how. Null until something looks at it.
  description  text,
  extracted_text text,
  analysis     jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Which model produced the description, so a bad reading can be traced to it.
  analyzed_by  text,
  analyzed_at  timestamptz,
  -- How much to trust the reading. OCR especially is not to be taken as fact.
  confidence   numeric(4,3),
  -- pending | analyzed | skipped | failed | unsupported
  status       text NOT NULL DEFAULT 'pending',
  error        text,

  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, kind, position)
);

CREATE INDEX event_media_event_idx ON event_media (event_id, position);
CREATE INDEX event_media_pending_idx ON event_media (status) WHERE status = 'pending';

-- A quoted post is not media and not the parent. It is a whole other post that
-- often carries the substance of the one quoting it.
CREATE TABLE event_quotes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      uuid NOT NULL UNIQUE REFERENCES events(id) ON DELETE CASCADE,
  remote_id     text,
  remote_url    text,
  author_handle text,
  text          text NOT NULL DEFAULT '',
  -- Media on the quoted post, described the same way as media on the post.
  media_summary text,
  resolved_at   timestamptz,
  status        text NOT NULL DEFAULT 'pending',
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Resolved links, kept separately so a policy that forbids fetching leaves an
-- explicit record of the decision rather than a silent absence.
CREATE TABLE event_links (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  url         text NOT NULL,
  title       text,
  description text,
  summary     text,
  -- ignored | metadata_only | fetched | refused | failed
  resolution  text NOT NULL DEFAULT 'ignored',
  reason      text,
  fetched_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, url)
);
