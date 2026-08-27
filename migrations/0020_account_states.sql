-- Account connection states.
--
-- CONNECTING covered every way a sign-in can be in progress: launching a
-- browser, waiting for a person, waiting on a challenge, or quietly stuck. None
-- of those are the same thing to whoever is looking at the screen.
--
-- CONNECTING was transient, so any row still holding it belongs to a sign-in
-- that was interrupted. Those become NEEDS_AUTH rather than a step that is not
-- actually running any more.

UPDATE accounts SET status = 'NEEDS_AUTH' WHERE status = 'CONNECTING';
UPDATE browser_sessions SET status = 'NEEDS_AUTH' WHERE status = 'CONNECTING';

-- When a sign-in window was opened, so the wait can be given a deadline and the
-- UI can say how long is left rather than spinning indefinitely.
ALTER TABLE accounts
  ADD COLUMN auth_started_at timestamptz,
  ADD COLUMN auth_deadline_at timestamptz,
  -- What the remote service asked for, when it asked for something only the
  -- owner can give. Never the challenge content itself.
  ADD COLUMN challenge_kind text;
