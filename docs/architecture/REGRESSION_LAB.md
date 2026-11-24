# Agent regression lab

Save a finished Lab rehearsal as a fixed case. The case retains the subject as
read, its source job, deterministic checks and a decision digest. At most 40
active cases belong to an agent. Archive one to make room.

Runs snapshot the baseline and checks so accepting a later baseline does not
rewrite history. Twelve cases run by default; an owner may explicitly choose
up to 40. One case is queued at a time. The worker sweep advances persisted
runs, and reading a run refreshes its completed results. Each case uses a fresh
tester identity and conversation. A case that times out after the Response
Lab patience interval is cancelled and reported as an error. Paused agents
report agent_paused for each selected case.

Digests come from the job explanation and its pinned configuration ids. Model
roles are captured when the rehearsal is queued. A word diff shows rewrites;
text changes alone are CHANGED. Worsening deterministic verdicts, broken
required silence and validator failures are REGRESSION. The view explains
that a model rewrites differently each time.

Preview sends an unsaved persona or policy through rehearse and ingest to
resolved_context.meta.candidate. Ingest requires an explicit dry run. loadJob
refuses a candidate on a live job permanently before reading configuration,
validates drafts, and overlays them on pinned versions without saving rows.
Context resolution preserves the candidate for every subsequent node. Version
ids on a preview identify its saved starting configuration; the run stores the
candidate separately. Model changes cannot be previewed.

Rehearse alone sets dryRun and reads the stored row back. Regression code calls
that path and checks every job again. Saved real posts replay on the local mock
channel from their retained snapshot, including parent text and reader gaps.
No browser is needed for a rerun. No run can publish.

Explicit persona, policy, model and Foundry saves leave a pending change notice.
Persona autosaves wait for an explicit save so unfinished typing does not spend
the daily automatic run. Unchanged policy and model saves leave no new notice. Runs are
manual by default. The versioned regression.autoRunOnChange setting explicitly
enables the existing worker sweep to run pending changes. Its daily cap is one
by default, at most three, counted in UTC and including manual runs. Preview
does not clear a pending notice. A later save is not cleared by an earlier run.

Cases contain third-party text and stay local. SHARE and MOVE packages exclude
cases, runs, results and change notices. Deleting an agent cascades through them.

Preview scope: the candidate persona and policy replace the job bundle in memory.
Ingest gates still use the saved active policy before that bundle exists. Evidence
card and evidence image gates, and the growth gate, also read the saved active
policy directly. A preview cannot predict the effect of changing those gates;
save the configuration and run the cases again to check them. The digest's policy
version id identifies the saved starting version, not a newly saved candidate.
