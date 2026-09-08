# Connecting an account

**Eleven states, a watched sign-in, and a hard stop at every security challenge.**

## The rule that shapes everything here

> If the service presents a CAPTCHA, a second factor, an emailed or texted code,
> a hardware key, an unusual-login confirmation, or an account lock, AI17Z enters
> `CHALLENGE_REQUIRES_USER` and lets the owner complete it.

AI17Z never answers a security challenge. There is no setting for it and no code
path around it, and it is the same stop whether a person started the sign-in or
a stored password did.

There are two ways in. The first is the default and needs nothing set up: a
person signs in to a real browser window and AI17Z only watches. The second is
opt-in and exists for the owner who would rather not be woken up by a lapsed
session; it types a username and password the owner chose to store, and stops in
exactly the same place.

## States

| State | Means | Who acts next |
| --- | --- | --- |
| `DISCONNECTED` | nothing attempted, or deliberately closed | you |
| `STARTING_BROWSER` | a browser is launching (slow on a cold profile) | AI17Z |
| `BROWSER_READY` | browser up, page loaded, nothing known yet | AI17Z |
| `AWAITING_LOGIN` | sign-in window open, waiting for a person | you |
| `AUTHENTICATING` | credentials accepted, service finishing | AI17Z |
| `CHALLENGE_REQUIRES_USER` | the service wants something only you can give | **you** |
| `CONNECTED` | signed in and usable | nobody |
| `SESSION_EXPIRED` | was connected; the stored session stopped being accepted | you |
| `NEEDS_AUTH` | no usable session, no sign-in running | you |
| `TIMEOUT` | a sign-in was started and nobody finished it | you |
| `ERROR` | something failed; `lastError` says what | you |

`SESSION_EXPIRED` and `NEEDS_AUTH` are separated deliberately: the first means
the profile is fine and the sign-in lapsed, the second that there was never a
session. They call for different reassurance.

## The default flow: a person signs in

```
OPEN_AUTH task
   │
   ├─ status := STARTING_BROWSER      (written before the launch, because a cold
   │                                   profile takes long enough to look broken)
   ├─ launch a real, visible window on the account profile
   ├─ navigate to the sign-in page
   └─ status := AWAITING_LOGIN, auth_deadline_at := now + 15 min

SignInWatcher (every 4s, worker only)
   │
   ├─ deadline passed?  → TIMEOUT          (checked before touching the browser,
   │                                        so an unresponsive page still exits)
   └─ adapter.observeAuth(ctx)
        ├─ SIGNED_IN      → CONNECTED, deadline cleared
        ├─ CHALLENGE      → CHALLENGE_REQUIRES_USER, deadline cleared, STOP
        ├─ AUTHENTICATING → AUTHENTICATING
        ├─ AWAITING_LOGIN → AWAITING_LOGIN
        └─ UNREACHABLE    → NEEDS_AUTH
```

`OPEN_AUTH` opens a window and touches nothing in it. `observeAuthPage` only
looks: it has no branch that clicks, fills, or dismisses anything, and
`tests/unit/authObservation.test.ts` hands it a page that records every touch and
fails if one happens.

`CHALLENGE_REQUIRES_USER` is terminal for the watcher. It is deliberately not in
`ACCOUNT_STATUSES_IN_PROGRESS`, so `accountsAwaitingSignIn()` does not return it
and nothing keeps reading the page somebody is typing a code into. The deadline
is cleared so nobody is timed out while finding their phone.

`CANCEL_AUTH` closes the window and returns the account to `NEEDS_AUTH`, because
the alternative was fifteen minutes of a screen saying it is waiting for you.

## The optional flow: stored sign-in details

Off unless somebody fills them in. An account with nothing stored behaves exactly
as it did before this existed, and the button that uses them is not shown.

```
PUT /api/accounts/:id/credentials     username + password, sealed on the way in
   │
   └─ account_credentials             one row per account, or none

CREDENTIAL_SIGN_IN task
   │
   ├─ accountCredentials.getDecryptedLogin(accountId)   ← the worker, not the task
   ├─ status := STARTING_BROWSER
   ├─ launch the window, navigate to the sign-in page
   └─ loop, up to 90 seconds:
        observeAuthPage(page)
          ├─ CHALLENGE      → CHALLENGE_REQUIRES_USER, STOP, nothing typed
          ├─ SIGNED_IN      → CONNECTED
          ├─ UNREACHABLE    → NEEDS_AUTH
          ├─ AWAITING_LOGIN → type the step that is showing, submit
          │                   (the same step twice → stop, hand the window over)
          └─ AUTHENTICATING → wait
   │
   └─ ran out of time → AWAITING_LOGIN with a deadline; the watcher takes over
```

### Where the boundary is enforced

**The acting path does not re-implement the challenge check.** Every iteration
asks `observeAuthPage` what the page is, and that function ranks
`CHALLENGE_SIGNALS` above the login form. So on a challenge screen the only
verdict the loop can receive is `CHALLENGE`, and it returns having typed nothing.

That ordering is the whole guarantee, and it exists because **several challenge
screens also carry an input box** — X's two-factor step is a text field with a
heading above it. Read as a login form, a stored password goes into a security
prompt.

`tests/unit/credentialSignIn.test.ts` pins two things that a passing
implementation could otherwise lose:

- a challenge screen with a visible input field is answered with `CHALLENGE` and
  nothing is typed
- the page is read **exactly once** before the loop returns, because continuing
  to poll a window somebody is entering a code into is the same defect that
  keeping `CHALLENGE_REQUIRES_USER` out of `ACCOUNT_STATUSES_IN_PROGRESS` exists
  to prevent

Reordering the check in `observeAuthPage` fails the first. Removing the early
return fails the second.

### Where the details are kept

`account_credentials` holds one optional row per account: a sealed username and a
sealed password, AES-256-GCM under `AI17Z_MASTER_KEY`, the same treatment as a
provider API key. The username is sealed too, because on X the login name is
usually an email address or a phone number rather than the public handle.

They are readable only through `accountCredentials.getDecryptedLogin`, which the
worker calls. They never appear in an API response, a log line, an audit row, a
trace, or `browser_tasks.params` — that column is persisted in the clear and
shown in the session panel's task history, which is why the task carries no
parameters and the worker reads the row itself.

The API's entire vocabulary is presence:

| Route | Does |
| --- | --- |
| `GET /api/accounts/:id/credentials` | says whether there is a row, and when it was written |
| `PUT /api/accounts/:id/credentials` | replaces both values; returns presence only |
| `DELETE /api/accounts/:id/credentials` | deletes the row |

They are deleted by `CLEAR` (which the panel labels "Clear session" and warns
about), by `DISCONNECT`, and by deleting the account — the last through
`ON DELETE CASCADE` rather than through anybody remembering to write it.

### What this buys, and what it does not

It shortens the gap between a session lapsing and an agent working again, on the
sign-ins where X presents a plain password form.

It does **not** remove the owner from the loop:

- **Two-factor authentication still stops it every time.** An account with 2FA on
  — which it should have — reaches the code step on every fresh sign-in.
- **Filling a form programmatically is itself a signal.** A scripted sign-in is
  more likely to be challenged than a person typing, so switching this on can
  produce the challenge that stops it.
- **A password is a larger thing to keep than a session.** A session cookie can
  be revoked from X and is scoped to a browser profile. A password is the
  credential that can change the account's email address and turn its protections
  off, and it lives on the machine AI17Z runs on, behind a master key that lives
  in a file beside the database.

Details X does not accept are never retried: the same step reappearing ends the
attempt and hands the window over. A retry loop against a login form is how an
account gets locked.

## Where the platform knowledge lives

All of it is behind the channel adapter. `observeAuth` and `signInWithCredentials`
both return normalised shapes; the worker never learns what a challenge, or a
login form, looks like.

- `packages/channels/src/x/selectors.ts` — `CHALLENGE_SIGNALS` and `SEL_AUTH`,
  the only place that knows how X phrases and renders these things
- `packages/channels/src/x/auth.ts` — `observeAuthPage`, which only looks
- `packages/channels/src/x/credentialSignIn.ts` — the one path that types,
  which decides what it is looking at by calling the observer
- `apps/worker/src/signIn.ts` — the watcher, which only writes state
- `apps/worker/src/browserTasks.ts` — the tasks, which own no selectors

### Ordering matters

A challenge is checked **before** the login form. Several challenge screens also
carry an input box, and mistaking one for a login form is exactly how an
automated flow ends up typing into a security prompt.

An unrecognisable page mid-flow is `AUTHENTICATING`, not a failure — X shows
nothing recognisable for a second or two between steps.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `AI17Z_SIGNIN_WINDOW_MS` | 900000 | how long an open sign-in is watched |
| `AI17Z_SIGNIN_POLL_MS` | 4000 | how often the window is read |
| `AI17Z_CREDENTIAL_SIGNIN_MS` | 90000 | how long a credential sign-in tries before handing over |
| `AI17Z_CREDENTIAL_SIGNIN_POLL_MS` | 1500 | how often that loop reads the page |

The watcher's poll is deliberately slow: each check drives a real browser page,
and a person typing a password does not need watching more often than that. The
credential loop is faster because it is driving the form rather than waiting on
somebody, and it stops on its own.
