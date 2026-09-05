# AI17Z — release handoff

2026-09-05. The development and refinement phase is complete. The golden runtime
has been promoted and is running the release candidate.

---

## Where everything is

| | |
|---|---|
| **Final XBAM commit** | `891e96b` — working tree clean |
| **Final golden commit** | `891e96b` — identical |
| **Version** | `0.1.0` |
| **Commits this session** | 68 |
| **Unpushed vs `origin/main`** | 84 |

Golden runs at 55532 / 8887 / 8090. Open it at http://localhost:8090.
XBAM runs at 55432 / 8787 / 5173.

## The promotion

| Question | Answer |
|---|---|
| Did golden Chrome restart? | **No.** pid 4568 on port 10335, untouched throughout |
| Did `@ai17zOS` survive? | **Yes.** Read from the live DOM after promotion, composer present, no login form |
| Golden health now | healthy on all seven components |
| Tabs | ACTION, MENTIONS, NOTIFICATIONS, RESEARCH — all healthy |
| Radar | all four monitors healthy and polling |
| Data | 1 agent, 156 events, 152 jobs, 94 actions, 185 memories, 42 relationships, 29 ideas, 1 sealed credential — every count identical |
| Migrations | 5 applied (0051–0055), 50 skipped, no drift |
| Ava | ACTIVE, AUTONOMOUS, replies only — exactly as found |

**Why Chrome was never restarted.** The worker-restart test showed a worker
reattaches to the Chrome already open, so promotion rebuilt and restarted
everything *around* the browser and left the session alone. That is the route to
use again.

Backups: `~/ai17z-test-backups/`, the pre-promotion one restored into a scratch
database and compared row for row before anything changed. Golden's three
uncommitted hotfixes are at `stash@{0}` there, superseded by this build.

## The XBAM restart tests

Run on `@ShiftAboveCtrl`, which is what it is for.

- **Worker restart, Chrome left up.** Chrome untouched: same pid, same 13
  processes, same tabs. The worker attached rather than launched and reconciled
  roles exactly — adopted three, opened one, orphaned none.
- **Actual Chrome restart.** Graceful shutdown took all 13 processes down; the
  worker reopened on the same profile and **the session survived**, with no
  restore obstruction and no login wall.
- **Cold start.** Everything stopped, nothing listening, started from nothing.
  It all came back and the session survived that too.
- **Real remote action.** One post through the whole pipeline on the restarted
  browser, held at approval and released deliberately:
  `x.com/ShiftAboveCtrl/status/2096044484601479496`, read back off X
  byte-identical. The agent was restored to DRAFT and unlinked afterwards.

## The controlled Ava action

Ava refused to post — **correctly**: she is a reply agent and is not permitted
to post through `@ai17zos`. Asked again, idempotency refused a duplicate and the
reconciler released the claimed idea.

Three real behaviours confirmed on the promoted build with real data. What it is
not is a published post from Ava. Getting one would have meant granting a
permission you deliberately withheld or editing her backlog, and a forced
demonstration proves nothing.

**Ava's own send is the one thing left.** Ten replies are waiting for a person
in her queue — approving one is a decision about answering a real person, so it
is yours.

## What promotion found

Two defects, same shape, both invisible until real data was in front of them.

1. **Every working tab reported degraded.** The worker publishes `READY`,
   `BUSY`, `MISSING`, `FAILED`; the grader compared against `HEALTHY`, which the
   worker has never produced. A browser doing exactly the right thing showed
   four faults.
2. **"Never read, never wrote, never sent" was always a lie.** The query asked
   for a column that does not exist and a status nothing writes, threw, and a
   catch turned it into three nulls — the three most prominent numbers on the
   health page.

Both fixed, both with regression tests, both promoted. The rule both broke is
already written down in this codebase: compare against the vocabulary the writer
actually produces, and never let a catch turn a broken query into a plausible
answer.

## Test results

| | Result |
|---|---|
| **Full suite at `b149342`** | 149 files, **1556 tests, 0 failures**, 653s, zero browsers leaked |
| **Three frozen runs at `0e2bfc2`** | 1543 / 1537 / 1543 tests, 0 failures each, zero browsers leaked each |
| **End to end** | **22 passed**, against a scratch stack with its own database, API, web and worker |
| **Release check** | Clean — 580 tracked files, nothing found |
| **Typecheck** | Clean |
| **Working tree** | Clean |

## Still not proven

**One row: vision.** Golden has a vision model configured
(`deepseek-v4-flash-vision-exp`) — an earlier claim that none existed anywhere
was wrong. What has not happened is a real image going through it, which needs a
mention carrying one.

**Five partial**, each saying which half is missing: real sign-in through to a
challenge (by design AI17Z stops there), a soak under load (the 45-minute run
was idle), trace accuracy in the UI, empty-versus-large data, and the composer's
defended edge cases.

## Publishing

Nothing has been pushed. The release check is clean, so this is safe to publish
when you choose.

```bash
git push origin main
```

```bash
git tag -a v0.1.0 -m "AI17Z 0.1.0" && git push origin v0.1.0
```

Then a GitHub Release from the tag: point it at `docs/RELEASE_VALIDATION_REPORT.md`
for what was tested and `docs/final-validation-matrix.md` for the row-by-row
evidence. There is no build artefact to attach — installation is a clone — so
there is nothing to checksum.

## Still user-blocked

**Code signing.** Superseded. This said an EV certificate carries SmartScreen
reputation immediately; Microsoft removed that behaviour in 2024, so it was
wrong. Signing is now free through SignPath Foundation for open-source projects.
See `docs/CODE_SIGNING_POLICY.md`.
