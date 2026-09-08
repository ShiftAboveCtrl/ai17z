-- Optional stored sign-in details for an account.
--
-- The default is unchanged and stays the default: a person signs in to the real
-- browser window themselves and the session lives in the profile. This is for
-- the owner who would rather AI17Z re-typed a username and password after a
-- session lapsed at three in the morning than have the agent sit idle until
-- they wake up.
--
-- Its own table rather than columns on `accounts`, for three reasons. Clearing
-- has to actually delete, and DELETE of a row is unambiguous where a nulled
-- column is a claim somebody has to check. `accounts` is selected through an
-- explicit column list in a dozen places and one forgetful `SELECT *` would put
-- a sealed password in an API response. And the presence of a row is the whole
-- of what the API is allowed to report, which is easier to keep true when
-- presence is a row.
--
-- Sealed exactly like a provider API key: AES-256-GCM under AI17Z_MASTER_KEY,
-- readable only through `accountCredentials.getDecryptedLogin`. The username is
-- sealed as well as the password, because on X it is usually an email address
-- or a phone number rather than the public handle.
--
-- ON DELETE CASCADE is what makes "deleting the account forgets the password"
-- a property of the schema rather than of somebody remembering to write it.

CREATE TABLE account_credentials (
  account_id            uuid PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
  sealed_login_username text NOT NULL,
  sealed_login_password text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- CREDENTIAL_SIGN_IN: type the stored details into the sign-in form.
--
-- Deliberately a separate kind from OPEN_AUTH rather than a flag on it, so that
-- observing a sign-in and acting on one are different operations with different
-- names. OPEN_AUTH still opens a window and touches nothing.
--
-- The task carries no parameters. The worker reads the sealed row itself, so a
-- password never reaches `browser_tasks.params`, which is persisted in the
-- clear and shown in the session panel's task history.

ALTER TABLE browser_tasks DROP CONSTRAINT browser_tasks_kind_check;
ALTER TABLE browser_tasks ADD CONSTRAINT browser_tasks_kind_check
  CHECK (kind IN ('CONNECT','HEALTH_CHECK','OPEN_AUTH','SCREENSHOT','CLEAR','DISCONNECT','INGEST','PREFLIGHT','CANCEL_AUTH','SHUTDOWN_BROWSER','CREDENTIAL_SIGN_IN'));
