# Development updates

A coding assistant working on a project knows what was just finished and why it
matters. The agent that talks about that project usually does not. Development
updates are the narrow door between them: the assistant hands over explicit,
public facts through an MCP tool, the owner decides whether they become a post
(or lets them through on their own, within a ceiling), and the post goes out
through the same action boundary as everything else the agent publishes.

An owner runs it from the **Development updates** screen (`/dev-updates`, or
search for "dev updates", "Claude Code" or "build in public"): create a
project, issue the sender token and copy a ready `claude mcp add` command,
set the rules, review drafts and read the log. The screen is a view over the
owner routes below and decides nothing itself. The CLI does the same things
from a terminal.

The token is shown once and kept only in the page's memory until the owner
hides it: never in local storage, a URL or a log. The command uses the API
address the browser reached and the MCP server path the installation reports
(`GET /api/dev-updates/connection`); inside a container that path is not
offered, because it would mean nothing on the owner's machine. Refusals in
the log come from the audit log and carry the reason and the field, never the
words.

## What it will not do

- **It never reads a repository.** What is shared is exactly what the sender
  puts in the call. There is no field for a diff, a file or a path.
- **Nothing refused for safety is stored.** A submission carrying something
  shaped like a credential, a private address, a local path, an email address,
  code or a diff is refused before anything is written. The audit row for a
  refusal holds reason codes and field names, never the words.
- **A rejected update loses its words.** Its fingerprints stay, so the same
  update offered again is recognised and refused rather than asked about twice.
- **A post never says who wrote it.** Naming Claude, crediting an assistant,
  agent or automation, "AI-generated", "auto-posted", a robot emoji: all
  refused. So are more than one hashtag, any @mention, more than one link,
  promotional filler and anything over 280 characters.
- **Security and unreleased work are never shared.** Vulnerabilities,
  exploits, auth bypasses, CVEs, security fixes, incidents and leaks, and
  anything the facts call unreleased, unannounced, embargoed, under NDA,
  confidential or internal, are refused whatever `disclosure` says. The
  sender's assertion that something is public cannot override this.
- **Nothing is posted without a meaningful fact.** A generic title ("bug
  fixes"), a summary under a sentence, no reason why it matters, housekeeping
  (`chore:`, `ci:`, `docs:`, refactors, dependency bumps) or evidence that is
  only a note are all refused.
- **Mapping an account is not posting.** New projects are in DRAFT mode and
  rehearse: every update waits for the owner, and even an approved one is
  checked end to end without being published until the owner turns rehearsal
  off.

## The pieces

| Piece | Where |
| --- | --- |
| Tables | `migrations/0113_dev_updates.sql` |
| Queries | `packages/database/src/repositories/devUpdates.ts` |
| Safety rules and the post composer (pure) | `packages/runtime/src/devUpdateSafety.ts` |
| Lifecycle: projects, tokens, submit, decide, dispatch, reconcile | `packages/runtime/src/devUpdates.ts` |
| HTTP | `apps/api/src/routes/devUpdates.ts` |
| Worker tick | `apps/worker/src/posting.ts` (same tick as scheduled posts) |
| MCP server (plain Node, no dependencies) | `tools/dev-updates-mcp.mjs` |
| Owner CLI | `tools/dev-updates.mts` (`npm run dev-updates -- help`) |

## Two credentials

| | Sender token | Owner session |
| --- | --- | --- |
| Who holds it | The coding assistant, through the MCP server | The owner |
| Scope | One project | Everything the owner owns |
| Can | Submit; read that project's updates and rules | Create and change projects, issue and revoke tokens, approve, reject |
| Cannot | Approve, reject, change mode, cap, spacing, rehearsal or mapping; see any other project | |
| Stored as | SHA-256 hash only, shown once at issue | Ordinary session |

Each is looked up in a different table, so neither can stand in for the other.
A sender token on an owner route is a 401, and so is an owner session on a
sender route. Rotating a token invalidates the old one immediately.

## Lifecycle

```
submit ──► PENDING_REVIEW ──approve──► APPROVED ──dispatch──► DISPATCHED ──► PUBLISHED  (with the link)
   │             │                        ▲                       │      ├─► REHEARSED  (checked, not published)
   │ AUTO mode ──┼────────────────────────┘                       │      ├─► SKIPPED    (identical text already sent)
   │             └──reject──► REJECTED (words removed)            │      ├─► FAILED     (with the pipeline's reason)
   └─ refused: nothing stored                                     │      └─► CANCELLED / REJECTED at the agent gate
                                                                  └─ waiting at the agent gate, or in its queue, with why
```

Every transition is appended to the update's `history` with who caused it
(`sender`, `owner`, `system`) and a sentence saying why. `status_reason` is the
latest of those, and for an approved update that is still waiting, the
project's `last_dispatch_reason` says what it is waiting for: the daily ceiling,
the spacing, a paused project, an agent that is switched off, a revoked grant.

### Dispatch

The worker's posting tick reads back what finished, then hands on what is due,
per project:

1. The project row is locked (`FOR UPDATE SKIP LOCKED`), so two workers never
   dispatch for one project at once.
2. The mapping is checked again: agent active and owned, account enabled and
   owned, link enabled, POST granted, automation not off or monitor only.
3. One update in flight per project: nothing else is handed over until the
   previous one settles. Then at most `daily_cap` hand-overs in any 24 hours,
   at least `min_spacing_minutes` apart. The projects considered are rotated
   (`last_considered_at`), so blocked projects cannot starve the rest.
4. The approved text is checked against every safety rule and the agent's own
   validator again, because the rules may have changed since it was approved.
   A validator finding that would send an ordinary post to review sends an
   automatically approved update back to PENDING_REVIEW: auto mode never
   decides those for the owner.
5. A `SCHEDULED_TRIGGER` event and a POST job are created in one transaction
   with the update moving to DISPATCHED. The event and job keys are anchored to
   the update id, so a replay finds the same job rather than making a second.
6. The job starts at the agent's approval gate with the reviewed text already
   in place. Nothing regenerates it. An owner approval counts as the approval
   the gate asks for; auto mode counts only when the agent's own automation mode
   is AUTONOMOUS, otherwise the job waits at the gate like any other.

### At the moment of sending

`packages/runtime/src/devUpdateGuard.ts` runs inside the executor, under the
account lease, on the exact text about to go out, for every job whose event
came from a development update. Every outcome is durable, so nothing asks
twice:

| Found at send | Outcome |
| --- | --- |
| Text breaks a rule, or the validator rejects it (including edits made through the ordinary review queue) | Stopped for good |
| Update no longer DISPATCHED (rejected, withdrawn) | Stopped for good |
| Project now maps a different agent or account | Stopped for good |
| Project switched to rehearsal after the hand-over | Stopped for good, not published |
| Project paused | Waits, then sends once resumed |
| Validator REVIEW finding, or project moved back to DRAFT, with no owner decision | Sent to the owner; one approval (the update's own or the job's) is enough |
| `daily_cap` real posts in the last 24 hours, or the last real post less than `min_spacing_minutes` ago | Waits until the window clears |

The ceiling and spacing here are measured on executed actions, not on
hand-overs, so a job that waited at a gate cannot bunch up behind the last post.

A development update that was attempted before (a FAILED action taken back, or
one left EXECUTING by a dead worker) is sent again only if the channel's
read-back says, conclusively, that it never arrived (`conclusive: true` on a
`done: false` answer). No read-back, one that throws, or an absence the channel
cannot prove stops the update as FAILED with a reason saying it may or may not
have posted. A send that timed out after the remote accepted it therefore
cannot post twice. X never claims conclusive absence: a profile timeline lags,
and a scan whose count or reload failed reads as empty.

The read-back looks for the text of the attempt that was actually made, which
is the action row's payload, not the job's current text: if the owner edited
the post after a failed attempt, the earlier wording is what might be on the
account. Found, the original attempt is recorded as what was published.
Conclusively absent, the action row is rewritten to the reviewed text
immediately before the new attempt, so the record matches what goes out.

From there the executor applies the capability re-check, account cadence and
quiet hours, the agent's rate policy, the global pause, duplicate suppression,
the action idempotency key and the recovery read-back, exactly as for any post.
A retryable failure is retried inside the job; an ambiguous send is never
blindly retried, because the action row and `wasAlreadyDone` decide.

The job is a rehearsal when the project rehearses or the agent's policy says
rehearse by default.

### Duplicates

Refused by unique indexes, not by a read before the write: the same client
request id (only its hash is stored, and it must be an identifier, not prose), the same kind and title, or the same post text, in one project. An
update whose every keyed evidence reference (commit, pull request, issue,
release) was already used by an earlier update is also a duplicate. A duplicate
is an answer (HTTP 200, `outcome: "DUPLICATE"`) that says what became of the
first one.

## Setting it up

1. **The agent must be allowed to post.** Connect the agent to the account and
   grant POST on it (the account's capabilities in the app, or link it with
   action type POST).
2. **Create the project** as the owner:

   ```bash
   export AI17Z_API_URL=http://localhost:8787
   export AI17Z_OWNER_EMAIL=you@example.com AI17Z_OWNER_PASSWORD=...
   npm run dev-updates -- create --key my-project --name "My Project" --agent <agentId> --account <accountId>
   ```

   The sender token is printed once. Defaults: DRAFT, 2 a day, 240 minutes
   apart, rehearsing.
3. **Give the token to Claude Code** on the machine where the project is
   being worked on:

   ```bash
   claude mcp add ai17z-dev-updates \
     --env AI17Z_API_URL=http://localhost:8787 \
     --env AI17Z_DEV_UPDATES_TOKEN=ai17z_dus_... \
     --env AI17Z_DEV_UPDATES_PROJECT=my-project \
     -- node /path/to/ai17z/tools/dev-updates-mcp.mjs
   ```

   The server is one file with no dependencies and needs Node 18 or later, so
   it can be copied anywhere. Or in a project `.mcp.json`:

   ```json
   {
     "mcpServers": {
       "ai17z-dev-updates": {
         "command": "node",
         "args": ["/path/to/ai17z/tools/dev-updates-mcp.mjs"],
         "env": {
           "AI17Z_API_URL": "http://localhost:8787",
           "AI17Z_DEV_UPDATES_TOKEN": "ai17z_dus_...",
           "AI17Z_DEV_UPDATES_PROJECT": "my-project"
         }
       }
     }
   }
   ```

   Keep the token out of version control; `.mcp.json` with a real token belongs
   in `.gitignore` or in the user scope (`claude mcp add --scope user`).

4. **Review.** `npm run dev-updates -- list --status PENDING_REVIEW`, then
   `approve <id>` (optionally `--text "edited post"`) or `reject <id> --note why`.
5. **When the rehearsals look right**, publish for real:
   `npm run dev-updates -- set <projectId> --rehearse false`. To let updates go
   out without review: `--mode AUTO`. Both are owner only.

   Two switches can hold a post, and both have to be off. A new agent's own
   policy runs everything as a dry run by default (Automation, "dry run by
   default"), so a fresh mapping keeps rehearsing after `--rehearse false`.
   The update says which switch held it: "because this project rehearses" or
   "because the agent's own policy runs everything as a dry run by default".

## MCP tools

| Tool | What it does |
| --- | --- |
| `share_dev_update` | Submits kind, title, summary, why, evidence and optionally the post text. `publicConfirmed: true` is required, and the server sends nothing at all without it. A stable request id derived from the facts makes a retried call the same request. |
| `dev_update_status` | Where one update is, why, and the link once published. |
| `list_dev_updates` | Recent updates for the project, to check before sharing. |
| `dev_update_rules` | Mode, ceiling, spacing, rehearsal and what the dispatcher last said. |

A refusal comes back as a tool error listing each rule broken and the field it
was in, so the assistant can rewrite rather than retry.

## A dry run, end to end, with no X

Against a development installation (`npm run dev`), with a `mock` channel
account connected to an agent and granted POST:

```bash
npm run dev-updates -- create --key demo --name Demo --agent <agentId> --account <mockAccountId>
# give the printed token to the MCP server, then from Claude Code ask it to share a finished fix
npm run dev-updates -- list
npm run dev-updates -- approve <updateId>
# within a minute the worker dispatches it; the project rehearses, so:
npm run dev-updates -- show <updateId>     # status REHEARSED, nothing published
```

Turning rehearsal off on a mock account (and the agent's dry run by default, see
Setting it up) then shows `PUBLISHED` with a `mock://message/...` link. Nothing
in this flow, and no test, touches X.
`tests/integration/devUpdates.test.ts` drives the same path through the HTTP
API on the mock channel.

## Verified end to end

Run against a scratch stack (API and worker from this repository, its own
database, a `mock` account), with the MCP server driven over stdio exactly as
Claude Code drives it. The commands that worked, in order:

```bash
# 1. owner: sign in, create the agent, a mock account, link it with POST
POST /api/bootstrap/owner, POST /api/auth/login, POST /api/agents,
POST /api/accounts {"channel":"mock","handle":"..."},
POST /api/agents/<agentId>/accounts {"accountId":"...","actionType":"POST"}
PATCH /api/agents/<agentId> {"state":"ACTIVE"}        # a draft agent posts nothing

# 2. map the project and get the sender token
npm run dev-updates -- create --key demo --name Demo --agent <agentId> --account <accountId>

# 3. the assistant shares work (MCP: initialize, tools/list, tools/call share_dev_update)
#    -> PENDING_REVIEW; dev_update_rules, list_dev_updates, dev_update_status all answer

# 4. owner reviews; the worker rehearses within a posting tick
npm run dev-updates -- list --status PENDING_REVIEW
npm run dev-updates -- approve <updateId>          # REHEARSED, one DRY_RUN action
npm run dev-updates -- reject <updateId> --note "not now"

# 5. publish for real (both switches, see Setting it up)
npm run dev-updates -- set <projectId> --rehearse false --cap 6
PUT /api/agents/<agentId>/policy                    # automation.dryRunDefault = false
npm run dev-updates -- approve <updateId>          # PUBLISHED, mock://message/...
```

Observed: a sender token gets a 401 on every owner route and an owner session
gets a 401 on every sender route; a secret-shaped string, a private address,
code, an assistant credit and a security fix were each refused with a reason
code and stored nowhere (the audit rows hold codes and field names only);
spacing held an approved update ("the next may go in 4 hours"), and with spacing
clear the daily ceiling still held it; a rejected update lost its words and was
recognised as a duplicate when offered again; a published update reached the
mock adapter once, and a job resumed after a simulated crash did not reach it
again (a send that died mid-flight ended FAILED with an explanation instead of
being retried).

## HTTP

Sender, with `Authorization: Bearer <sender token>`:

- `GET /api/dev-updates/sender/project`
- `POST /api/dev-updates/sender/updates` (201 accepted, 200 duplicate, 422 refused, 409 too many waiting)
- `GET /api/dev-updates/sender/updates?limit=`
- `GET /api/dev-updates/sender/updates/:id`

Owner, with a session:

- `GET /api/dev-updates/connection` (where this installation keeps the MCP server)
- `GET|POST /api/dev-updates/projects`, `GET|PATCH /api/dev-updates/projects/:id`
- `POST|DELETE /api/dev-updates/projects/:id/sender-token`
- `GET /api/dev-updates/updates?projectId=&status=&limit=`, `GET /api/dev-updates/updates/:id`
- `POST /api/dev-updates/updates/:id/approve` (`editedText`, `note`), `POST /api/dev-updates/updates/:id/reject` (`note`)

## Limits worth knowing

- There are two ceilings and both apply. The dispatcher counts hand-overs in
  the last 24 hours, including rehearsals and sends that later failed, so it
  errs towards handing over less. The send-time guard counts real executed
  posts, which is the number people actually see.
- A FAILED or CANCELLED update is final. The fingerprints stay, so the same
  title will be refused as a duplicate; resubmit with a new title if it should
  go again.
- An owner rejection at the agent gate scrubs the update's words, but the job's
  own record of the draft stays where the review queue keeps every rejected
  draft.
- A rejection is decided under the project lock before hand-over and under the
  account lease after it. Once any real send was attempted it is refused, so an
  update is never reported REJECTED after it may have gone out.
- Channels without a conclusive read-back (the mock and X today) never retry
  a development update after an attempted send; it ends FAILED and says why.
- The safety rules are pattern based. They refuse generously, and they are a
  floor, not a substitute for the sender only sharing what is public.
