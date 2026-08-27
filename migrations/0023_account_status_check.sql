-- The eleven account states, actually permitted by the database.
--
-- Migration 0020 introduced the new states and taught the application to write
-- them, but left the CHECK constraint listing the old five. Every write of
-- STARTING_BROWSER, AWAITING_LOGIN, CHALLENGE_REQUIRES_USER, SESSION_EXPIRED or
-- TIMEOUT therefore failed at the database, which surfaced as an OPEN_AUTH task
-- dying with a constraint error and no sign-in window ever appearing.
--
-- The unit tests covered the state machine and the integration tests only ever
-- wrote the old statuses, so nothing caught it until a real sign-in was run.

ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_status_check;
ALTER TABLE accounts
  ADD CONSTRAINT accounts_status_check
    CHECK (status IN (
      'DISCONNECTED',
      'STARTING_BROWSER',
      'BROWSER_READY',
      'AWAITING_LOGIN',
      'AUTHENTICATING',
      'CHALLENGE_REQUIRES_USER',
      'CONNECTED',
      'SESSION_EXPIRED',
      'NEEDS_AUTH',
      'TIMEOUT',
      'ERROR'
    ));
