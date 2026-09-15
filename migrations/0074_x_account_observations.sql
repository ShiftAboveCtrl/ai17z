-- What AI17Z has read about somebody on X, kept so a screen does not re-read it.
--
-- The X intelligence layer already answers "who is @somebody and what have they
-- been writing", and its cache already stops two questions in a minute becoming
-- two requests. But that cache lives in the worker's memory, and everything
-- that wants to *show* somebody -- the People screen, a bridge score, a
-- relationship card -- runs in the API, which owns no browser and cannot ask.
--
-- So the read is recorded. Without this, a People screen has exactly two
-- options: read X on every render, which is a browser request per card and a
-- session the agent needs for its actual work; or show nothing.
--
-- ### Why this is not a parallel store of anything
--
-- It holds one thing nothing else holds: what X said about a person at a moment
-- AI17Z asked. `relationships` holds what has passed between the agent and
-- them, which is a different fact and stays where it is -- an observation here
-- never becomes an interaction there, because reading somebody's profile is not
-- talking to them. `events` holds posts that were discovered. `persona_sources`
-- holds writing being learned from. None of them can answer "how many people
-- follow them and what do they post about", and inferring it from the others
-- would be a guess dressed as a measurement.
--
-- ### Identity is the numeric id, and the constraints say so
--
-- Handles change. Two unique indexes rather than one, because a read can arrive
-- either way: X's own JSON gives the immutable id, and a rendered profile does
-- not carry one at all. The partial index on the id is what makes a rename one
-- person -- the row is found by id and its handle updated -- instead of two
-- rows that slowly disagree about somebody.
--
-- ### Scoped to the owner who looked
--
-- Not because a public profile is private, but because *who somebody looked up*
-- is. A second owner on the same installation gets their own reads, and
-- deleting an account takes its observations with it rather than leaving a list
-- of the people it was interested in.
CREATE TABLE x_account_observations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,

  -- X's immutable numeric id, as text: nineteen digits is past what a JS number
  -- holds, and parsed as one it silently becomes a different id. Empty string
  -- rather than null when the reader could not see one, so the partial unique
  -- index below has something unambiguous to exclude.
  user_id       text NOT NULL DEFAULT '',
  handle        text NOT NULL,
  display_name  text,
  bio           text,
  avatar_url    text,
  banner_url    text,
  location      text,
  website       text,

  -- Null is "the reader could not see this", never zero and never false. A
  -- follower count nobody could read and an account with no followers are
  -- different things to put on a screen.
  followers     integer,
  following     integer,
  posts         integer,
  joined_at     timestamptz,
  verified      boolean,
  protected     boolean,

  -- How they stand with the account that did the reading. X answers a profile
  -- query as somebody, so the reply says this without opening a follower list
  -- -- which for a large account is effectively infinite and a request per
  -- screen.
  --
  -- Null is "X did not say", never "no". The bridge score reports an unknown
  -- follow relationship as a gap and treats a known absence as a measured fact
  -- worth no points, and collapsing the two would turn every unread profile
  -- into a pair of strangers.
  we_follow     boolean,
  follows_us    boolean,

  -- What their recent writing looks like: recurring topics, how often they
  -- post, how much of it is replies, and a few posts as evidence. Derived, and
  -- every number in it carries how many posts it rests on -- a voice summary
  -- from four posts is a guess and has to say so.
  observations  jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- How the last read ended, in the layer's own vocabulary. A protected account
  -- and one nobody has looked at yet are different states, and a screen that
  -- cannot tell them apart says "no data" to somebody whose answer is "they
  -- made their account private".
  outcome       text NOT NULL DEFAULT 'OK'
                CHECK (outcome IN ('OK','NOT_FOUND','PROTECTED','EMPTY','NEEDS_SIGN_IN',
                                   'CHALLENGE','RATE_LIMITED','SCHEMA_CHANGED','UNAVAILABLE')),
  detail        text NOT NULL DEFAULT '',

  -- Which reader answered, what it could not see, and when it looked. Carried
  -- rather than logged: a profile read from X's own JSON and one scraped off a
  -- drawn page are different evidence, and the difference has to reach whoever
  -- is deciding how much to claim from it.
  backend       text NOT NULL DEFAULT '',
  gaps          jsonb NOT NULL DEFAULT '[]'::jsonb,
  observed_at   timestamptz NOT NULL DEFAULT now(),

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- One row per handle per owner. The ordinary key, and the only one available
-- when a rendered page was the reader.
CREATE UNIQUE INDEX x_account_observations_handle_key
  ON x_account_observations (owner_user_id, lower(handle));

-- One row per person per owner, where the person could be identified. This is
-- the index that makes a rename an update rather than a second record.
CREATE UNIQUE INDEX x_account_observations_user_key
  ON x_account_observations (owner_user_id, user_id) WHERE user_id <> '';

-- "What has been read lately", which is how the People screen is ordered.
CREATE INDEX x_account_observations_recent_idx
  ON x_account_observations (owner_user_id, observed_at DESC);

-- Reading somebody's account is browser work, so it is a browser task.
--
-- The API records the intent and the worker executes it, exactly as CONNECT,
-- COLLECT_PERSONA and the rest already do. The API owns no browsers and this is
-- not the place to give it one.
ALTER TABLE browser_tasks DROP CONSTRAINT browser_tasks_kind_check;
ALTER TABLE browser_tasks ADD CONSTRAINT browser_tasks_kind_check
  CHECK (kind IN (
    'CONNECT','HEALTH_CHECK','OPEN_AUTH','SCREENSHOT','CLEAR','DISCONNECT','INGEST',
    'PREFLIGHT','CANCEL_AUTH','SHUTDOWN_BROWSER','CREDENTIAL_SIGN_IN','COLLECT_PERSONA',
    'READ_X_ACCOUNT'
  ));
