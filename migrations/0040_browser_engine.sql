-- An explicit browser engine, and evidence of what actually ran.
--
-- "Managed profile" plus a "channel" hid the thing that matters: which binary
-- is running. A new account defaulted to channel 'chromium', so choosing
-- nothing got Playwright's bundled Chromium while the UI called it a managed
-- browser. That is exactly the ambiguity this replaces.
--
-- The mapping preserves what each account already had. Nothing changes engine.

ALTER TABLE browser_sessions
  ADD COLUMN engine text,
  -- What was actually launched, recorded at launch and shown in diagnostics so
  -- nobody has to take "real Chrome" on trust.
  ADD COLUMN executable_path text,
  ADD COLUMN browser_product text,
  ADD COLUMN browser_version text,
  ADD COLUMN browser_pid integer,
  -- What the running browser reported over CDP. The second, independent signal.
  ADD COLUMN cdp_product text,
  ADD COLUMN verified_at timestamptz;

UPDATE browser_sessions
   SET engine = CASE
     WHEN mode = 'CDP' THEN 'CUSTOM_CDP'
     WHEN channel = 'chrome' THEN 'GOOGLE_CHROME'
     WHEN channel = 'msedge' THEN 'MICROSOFT_EDGE'
     ELSE 'PLAYWRIGHT_CHROMIUM'
   END;

ALTER TABLE browser_sessions
  ALTER COLUMN engine SET DEFAULT 'GOOGLE_CHROME',
  ALTER COLUMN engine SET NOT NULL;

ALTER TABLE browser_sessions
  ADD CONSTRAINT browser_sessions_engine_check
    CHECK (engine IN ('GOOGLE_CHROME','MICROSOFT_EDGE','PLAYWRIGHT_CHROMIUM','CUSTOM_CDP'));
