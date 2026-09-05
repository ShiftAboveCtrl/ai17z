# Connecting an account

**Eleven states, a watched sign-in, and a hard stop at every security challenge.**

## The rule that shapes everything here

> If the service presents a CAPTCHA, a second factor, an emailed or texted code,
> a hardware key, an unusual-login confirmation, or an account lock, AI17Z enters
> `CHALLENGE_REQUIRES_USER` and lets the owner complete it.

AI17Z never types a password and never answers a security challenge. There is no
setting for it and no code path around it. `observeAuthPage` has no branch that
clicks, fills, or dismisses anything, and `tests/unit/authObservation.test.ts`
fails if any of those are ever called.

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

## The flow

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
        └─ UNREACHABLE    → ERROR
```

`CHALLENGE_REQUIRES_USER` is terminal for the watcher. It is deliberately not in
`ACCOUNT_STATUSES_IN_PROGRESS`, so `accountsAwaitingSignIn()` does not return it
and nothing keeps reading the page somebody is typing a code into. The deadline
is cleared so nobody is timed out while finding their phone.

`CANCEL_AUTH` closes the window and returns the account to `NEEDS_AUTH`, because
the alternative was fifteen minutes of a screen saying it is waiting for you.

## Where the platform knowledge lives

All of it is behind the channel adapter. `observeAuth` returns a normalised
`AuthObservation`; the worker never learns what a challenge looks like.

- `packages/channels/src/x/selectors.ts` — `CHALLENGE_SIGNALS`, the only place
  that knows how X phrases these things
- `packages/channels/src/x/auth.ts` — `observeAuthPage`, which only looks
- `apps/worker/src/signIn.ts` — the watcher, which only writes state

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

The poll is deliberately slow: each check drives a real browser page, and a
person typing a password does not need watching more often than that.
