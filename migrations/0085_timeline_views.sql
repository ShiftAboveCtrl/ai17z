-- Readings the timeline took are view counts, and are moved under that name.
--
-- 0084 gave views a column of its own and deliberately backfilled nothing,
-- because a figure recorded under the wrong name is not generally recoverable:
-- an impressions column could hold either measurement and nothing in the row
-- said which.
--
-- For one source it does say. `source = 'TIMELINE'` is written by the radar,
-- and that path reads `poll.targetCounts`, which comes from the count group's
-- own label under a post: "288 replies, 155 reposts, 696 likes, 60 bookmarks,
-- 58814 views". It has never had access to X's analytics view and cannot have
-- recorded an impression. So every impressions value carrying that source is a
-- view count, and moving it is a correction rather than a guess.
--
-- Measured before writing this: 83 such rows on the test installation and 2513
-- on the live one, every one of them with an impressions value and none from
-- any other source. Left alone, the analytics screen would label all of them
-- Impressions for ever.
--
-- Deliberately narrow. Rows from any other source are untouched: the analytics
-- reader could see either word on the page, so what it recorded is genuinely
-- ambiguous and stays where it is rather than being reinterpreted.
UPDATE post_analytics
   SET views = impressions,
       impressions = NULL
 WHERE source = 'TIMELINE'
   AND impressions IS NOT NULL
   AND views IS NULL;
