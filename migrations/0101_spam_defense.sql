-- Spam defense: what came in that was not worth anybody's attention, why,
-- and what the owner said about it.
--
-- Three things kept apart, because they are different claims:
--   an ITEM is spam (this post),
--   a TEMPLATE is a campaign (this text, from many posts or many people),
--   an ACTOR has a record (this account keeps sending it).
-- One post marked spam says nothing about anybody it mentioned, and one
-- spammy post does not make its author a spammer for ever.

-- A campaign: posts that say the same thing once mentions, links, casing and
-- numbers are taken away. Fifty accounts pasting one text are one row here,
-- with how many and who, rather than fifty things competing for attention.
CREATE TABLE spam_templates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  fingerprint     text NOT NULL,
  sample          text NOT NULL,
  items           integer NOT NULL DEFAULT 0,
  -- Distinct authors seen, capped for storage; `actors` is the true count.
  actors          integer NOT NULL DEFAULT 0,
  actor_handles   text[] NOT NULL DEFAULT '{}',
  -- Owner verdicts on items with this template, counted rather than trusted
  -- from one: a single "spam" on one post does not condemn the template.
  owner_spam      integer NOT NULL DEFAULT 0,
  owner_not_spam  integer NOT NULL DEFAULT 0,
  first_seen      timestamptz NOT NULL DEFAULT now(),
  last_seen       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, fingerprint)
);

CREATE TABLE spam_actors (
  account_id      uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  handle_key      text NOT NULL,
  spam_items      integer NOT NULL DEFAULT 0,
  clean_items     integer NOT NULL DEFAULT 0,
  owner_spam      integer NOT NULL DEFAULT 0,
  owner_not_spam  integer NOT NULL DEFAULT 0,
  -- The owner's explicit "keep this account out of the agent's attention".
  muted           boolean NOT NULL DEFAULT false,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, handle_key)
);

-- The verdict on one inbound post. Kept for audit, correction and learning;
-- a SPAM item is recorded and given no work, never deleted.
CREATE TABLE inbound_spam (
  event_id     uuid PRIMARY KEY REFERENCES events (id) ON DELETE CASCADE,
  account_id   uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  verdict      text NOT NULL CHECK (verdict IN ('SPAM', 'SUSPECT', 'CLEAN')),
  score        integer NOT NULL,
  reasons      jsonb NOT NULL DEFAULT '[]'::jsonb,
  template_id  uuid REFERENCES spam_templates (id) ON DELETE SET NULL,
  decided_by   text NOT NULL CHECK (decided_by IN ('CLASSIFIER', 'OWNER')),
  -- What the classifier said before any owner correction, so a "not spam" on
  -- something it filtered is counted as the false positive it was.
  classifier_verdict text NOT NULL CHECK (classifier_verdict IN ('SPAM', 'SUSPECT', 'CLEAN')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inbound_spam_account_idx ON inbound_spam (account_id, created_at DESC);
CREATE INDEX inbound_spam_template_idx ON inbound_spam (template_id);
