-- A post may carry a picture or a video.
--
-- The file is held by AI17Z as an artifact of its own kind, so it can be served
-- back to the owner who is asked to approve it and found again by the executor
-- that sends it. A development update lists the artifacts it carries; the
-- dispatcher copies that list onto the job's event, which is where the executor
-- reads it from.
--
-- ### Why a new artifact kind and not UPLOAD
--
-- UPLOAD is what the owner typed into a form. A post attachment is what a
-- project's assistant handed over, held for a human to look at before it goes
-- public, and cleaned up on its own if it is never attached to anything.
-- Keeping them apart is what lets that cleanup be a one-line filter.
ALTER TABLE artifacts DROP CONSTRAINT IF EXISTS artifacts_kind_check;
ALTER TABLE artifacts ADD CONSTRAINT artifacts_kind_check
  CHECK (kind IN ('SCREENSHOT','PORTRAIT','UPLOAD','EXPORT','HTML_SNAPSHOT','POST_MEDIA'));

-- [{ artifactId, kind, mime, bytes, sha256 }], in the order they appear on the
-- post. Empty is a text-only update, which is every update that already exists.
ALTER TABLE dev_updates ADD COLUMN media jsonb NOT NULL DEFAULT '[]'::jsonb;
