-- A source that spends a cycle on something else has to remember that it tried.
--
-- The own-threads source gives an occasional cycle to reading the account
-- itself, and decided whether it was due by asking when the last reading was
-- *stored*. A reading that fails stores nothing, so a source whose reading has
-- started failing finds itself due on every poll, for ever, and never checks a
-- thread again.
--
-- Measured on a live installation: the last stored reading was 2026-09-15
-- 17:47 and the last thread checked was 2026-09-15 23:44. For the eight days
-- between then and this migration the source polled every three minutes,
-- reported HEALTHY every time, and looked at nothing at all. Roughly three
-- thousand eight hundred polls, no errors, no replies found.
--
-- Recording the attempt rather than the outcome is what breaks the loop: a
-- reading that fails still costs its cycle and still waits its interval before
-- asking for another one.
ALTER TABLE radar_sources
  ADD COLUMN IF NOT EXISTS last_side_work_at timestamptz,
  -- Why this source has nothing to show, when it has nothing to show and that
  -- is not a failure. "Checked and found nothing" and "there was nothing to
  -- check" are different facts and a poll count cannot tell them apart.
  ADD COLUMN IF NOT EXISTS idle_reason text;
