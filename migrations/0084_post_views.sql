-- Views are their own measurement, so they get their own column.
--
-- `impressions` was carrying both. The analytics reader mapped X's word "views"
-- onto the impressions metric, on the strength of a label table rather than of
-- anything establishing the two are the same figure, and the value was then
-- stored under a name X had not used.
--
-- Measured on a live signed-in session: X writes "288 replies, 155 reposts, 696
-- likes, 60 bookmarks, 58814 views" in the count group under a post, and
-- "Views" beside the figure. It never says impressions there. Its detailed
-- analytics view, where an account has one, does say impressions, and that is a
-- different number arrived at a different way.
--
-- Nothing is backfilled. Rows written before this were recorded under the name
-- the reader used at the time, and inventing a view count for them from an
-- impressions column would be the same mistake in the other direction.
ALTER TABLE post_analytics ADD COLUMN IF NOT EXISTS views integer;

COMMENT ON COLUMN post_analytics.views IS
  'What X calls Views on the post itself. Null when it was not measured. Never a copy of impressions.';

COMMENT ON COLUMN post_analytics.impressions IS
  'What X calls Impressions in its own analytics view. Null when it was not measured, which is the ordinary case for an account without that view.';
