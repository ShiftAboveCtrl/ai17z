-- How long a development update post may be, per project.
--
-- 280 is what every account can post, and it stays the default so nothing
-- changes for an existing project. An owner whose account has long posts on X
-- may raise it, up to the 25,000 characters X allows those accounts. The limit
-- is the owner's statement about the account; X remains the judge, and a post
-- X refuses is reported as a failure, never cut.

ALTER TABLE dev_update_projects
  ADD COLUMN max_post_chars integer NOT NULL DEFAULT 280
    CONSTRAINT dev_update_projects_max_post_chars_check CHECK (max_post_chars BETWEEN 280 AND 25000);
