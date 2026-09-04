-- A page on the web as a knowledge source.
--
-- The boundary is narrow on purpose: one page, the one the owner named, and no
-- links followed ever. "Index a website" is four decisions disguised as one --
-- what counts as the same page, how deep to follow, how often to return, and
-- whether the site wanted to be read -- and each has a wrong answer that turns a
-- documentation feature into a crawler somebody pointed at the internet by
-- accident. Somebody who wants five pages adds five sources and can see all five.
--
-- Refresh is a schedule the owner sets and is off by default. `revision` already
-- holds what the source was when last read, so a URL source stores a content
-- hash there and an unchanged page writes nothing.

ALTER TABLE knowledge_sources
  DROP CONSTRAINT IF EXISTS knowledge_sources_kind_check;

ALTER TABLE knowledge_sources
  ADD CONSTRAINT knowledge_sources_kind_check
  CHECK (kind IN ('UPLOAD', 'PATH', 'TEXT', 'URL'));

ALTER TABLE knowledge_sources
  -- Null means "only when somebody asks". Never automatic by default: a source
  -- that re-reads on its own is one nobody remembers agreeing to.
  ADD COLUMN IF NOT EXISTS refresh_interval_minutes integer
    CHECK (refresh_interval_minutes IS NULL OR refresh_interval_minutes >= 15),
  ADD COLUMN IF NOT EXISTS next_refresh_at timestamptz;

-- Which sources are due, asked the same way the poller asks about accounts.
CREATE INDEX IF NOT EXISTS knowledge_sources_due
  ON knowledge_sources (next_refresh_at)
  WHERE enabled AND refresh_interval_minutes IS NOT NULL;
