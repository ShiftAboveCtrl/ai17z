-- XBAM 0011: which browser build an account drives.
--
-- Managed mode previously always used the Chromium that Playwright ships. That
-- is right for a container, and wrong for an account that has to act with a
-- session a person signed into on their own machine, where the real installed
-- Chrome (and its profile) is the whole point.

ALTER TABLE browser_sessions
  ADD COLUMN channel text NOT NULL DEFAULT 'chromium'
    CHECK (channel IN ('chrome', 'msedge', 'chromium'));

COMMENT ON COLUMN browser_sessions.channel IS
  'chrome/msedge drive the real installed browser; chromium uses the Playwright build.';
