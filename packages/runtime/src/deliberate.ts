import {
  accounts as accountsRepo,
  agents as agentsRepo,
  content as contentRepo,
  deliberation as mind,
  engagements as engagementsRepo,
  memories as memoriesRepo,
  relationships as relationshipsRepo,
  repoSources,
  type AttentionRow,
} from '@xbam/database';
import {
  ATTENTION_HALF_LIFE_DAYS,
  DELIBERATION_LIMITS,
  SALIENCE_FLOOR,
  autonomyAtLeast,
  type AttentionKind,
  type AttentionState,
  type AutonomyLevel,
  type EvidenceRef,
  type MemoryScope,
  type MemoryType,
} from '@xbam/shared/contracts';
import { createLogger, errorMessage } from '@xbam/shared';
import { generate, resolveTargets } from '@xbam/models';
import { pauseState } from './killSwitch';
import { worthNoticing } from './repoWatcher';
import { reticenceReason, unpromptedSubject } from './reticence';
import { worthEngaging } from './engagementWorth';
import { lookIntoSomething } from './curiosity';
import { decayed, fingerprintOf, overlap, scoreObservation, type KnownPerson, type Observation, type SalienceContext } from './salience';

const log = createLogger('deliberate');

/**
 * An agent thinking between the things it is asked.
 *
 * Everything else in the runtime begins with an inbound event: somebody said
 * something, and the pipeline decides what to do about it. This begins with
 * nothing happening. It is the loop that lets an agent accumulate a present
 * tense -- what it is interested in, unsure about, trying to find out, and has
 * recently learned -- so that when it does speak it has something to say that
 * came from somewhere.
 *
 * ## Persistent autonomous deliberation, and not a word more
 *
 * This is not a mind and AI17Z must never call it one. It is a bounded loop
 * over structured conclusions. The honest claim is narrow and still worth a
 * great deal: an agent that keeps context, researches its own uncertainty,
 * holds goals and learns from outcomes participates with continuity, and one
 * that does none of those things can only react.
 *
 * ## The shape
 *
 *   observe    read what the pipeline already wrote
 *   attend     score it deterministically, and mostly decline it
 *   reflect    connect what survived, bounded, model-assisted, optional
 *   update     decay, retire, supersede
 *   intend     turn the strongest of it into candidates the existing gates judge
 *
 * ## Four properties it must keep
 *
 * **No second scheduler.** `agent_wake` carries the due time and the claim moves
 * it in the same statement, exactly as the account poller and the feed watcher
 * do.
 *
 * **Doing nothing is a result.** Most wakes produce nothing, that is recorded as
 * what happened, and a quiet agent backs off rather than asking a paid model the
 * same question every half hour for ever.
 *
 * **No raw reasoning is stored.** Every artifact is a conclusion, its evidence
 * and its confidence.
 *
 * **Nothing here decides to act.** At most it produces a candidate and hands it
 * to the machinery that was always going to decide -- the engagement heuristic,
 * the policy gates, cadence, rate limits, idempotency and exact-target
 * verification. The autonomy ladder decides whether a candidate is offered, not
 * whether those gates run.
 */

/** How far back a wake looks when it has never run before. */
const FIRST_LOOK_HOURS = 24;

/**
 * How much a quiet agent backs off, and how far.
 *
 * Doubling with a ceiling. An agent whose world has gone quiet should not cost
 * a model call every half hour for ever, and an agent that has been quiet for
 * six hours should still notice within the hour when something happens.
 */
const QUIET_BACKOFF_MAX = 8;

/** A reflection call that takes longer than this has cost more than it is worth. */
const REFLECT_TIMEOUT_MS = 20_000;

export interface WakeOutcome {
  agentId: string;
  autonomy: AutonomyLevel;
  /** How many records the wake looked at. */
  observed: number;
  /** How many were worth attending to. */
  attended: number;
  reinforced: number;
  /** New working-set items produced by reflection. */
  produced: number;
  retired: number;
  /** What faded but was worth keeping, written into the six memory scopes. */
  kept: number;
  /** A question it went and looked into, when it did. */
  lookedInto: { question: string; findings: number } | null;
  /** Candidates handed to the existing backlog. */
  candidates: number;
  /** Likes and reposts it proposed, which ACT may later take. */
  engagements: number;
  deep: boolean;
  /** One sentence an owner can read. */
  reason: string;
  /** Present when the wake did not run at all. */
  skipped?: string;
}

function emptyOutcome(agentId: string, autonomy: AutonomyLevel, reason: string, skipped?: string): WakeOutcome {
  return {
    agentId,
    autonomy,
    observed: 0,
    attended: 0,
    reinforced: 0,
    produced: 0,
    retired: 0,
    kept: 0,
    lookedInto: null,
    candidates: 0,
    engagements: 0,
    deep: false,
    reason,
    ...(skipped ? { skipped } : {}),
  };
}

/**
 * Everything the scoring needs to know about who this agent is.
 *
 * Read from what already exists -- the persona's own topics, the goals it
 * holds, the people it knows, what it has said. Nothing here is a second copy
 * of any of it.
 */
async function contextFor(agentId: string, accountId: string | null): Promise<SalienceContext> {
  const [persona, goals, mindItems, known, said, account] = await Promise.all([
    agentsRepo.getActivePersona(agentId),
    mind.listGoals(agentId, { status: 'ACTIVE' }),
    mind.onItsMind(agentId, { limit: 40 }),
    relationshipsRepo.listForAgent(agentId, { limit: 150 }),
    mind.recentlySaid(agentId, 25),
    accountId ? accountsRepo.getAccount(accountId) : Promise.resolve(null),
  ]);

  const people = new Map<string, KnownPerson>();
  for (const person of known) {
    people.set(person.handle.toLowerCase(), {
      handle: person.handle,
      inboundCount: person.inboundCount,
      outboundCount: person.outboundCount,
      familiarity: person.familiarity,
      disposition: person.disposition,
    });
  }

  return {
    topics: persona?.topics ?? [],
    goals: goals.map((goal) => goal.summary),
    onItsMind: mindItems.map((item) => item.summary),
    people,
    recentlySaid: said,
    selfHandles: account?.handle ? [account.handle] : [],
    now: new Date(),
  };
}

/** One observation row as the scorer wants to see it. */
function toObservation(row: Record<string, unknown>): Observation {
  const metrics = (row.metrics ?? {}) as Record<string, number>;
  return {
    source: String(row.source) as Observation['source'],
    id: String(row.id),
    text: String(row.text ?? ''),
    at: (row.at as string | null) ?? null,
    handle: (row.handle as string | null) ?? null,
    authorId: (row.author_id as string | null) ?? null,
    url: (row.url as string | null) ?? null,
    metrics: {
      ...(typeof metrics.replies === 'number' ? { replies: metrics.replies } : {}),
      ...(typeof metrics.likes === 'number' ? { likes: metrics.likes } : {}),
      ...(typeof metrics.views === 'number' ? { views: metrics.views } : {}),
    },
  };
}

/**
 * What a watched repository did, as observations -- once the mechanical
 * majority has been thrown away.
 *
 * `worthNoticing` is applied here rather than in the watcher because the
 * watcher's job is to record what happened, faithfully and completely. What is
 * worth an agent's attention is a different question with a different answer,
 * and an owner looking at the repository's history should see the typo fix even
 * though no agent should ever mention it.
 */
function repoObservations(
  rows: { kind: string; title: string; body: string; state: string | null; url: string; repo: string; occurredAt: string | null; id: string }[],
): Observation[] {
  const kept: Observation[] = [];
  for (const row of rows) {
    const verdict = worthNoticing({
      kind: row.kind as Parameters<typeof worthNoticing>[0]['kind'],
      title: row.title,
      body: row.body,
      state: row.state,
    });
    if (!verdict.worth) continue;
    kept.push({
      source: 'REPO_EVENT',
      id: row.id,
      // The repository is named in the text because an agent reading this needs
      // to know which project did it, and a bare commit subject does not say.
      text: `${row.repo}: ${row.title}`,
      at: row.occurredAt,
      handle: null,
      authorId: null,
      url: row.url,
      metrics: null,
    });
  }
  return kept;
}

function evidenceFor(observation: Observation): EvidenceRef {
  return {
    kind: observation.source,
    ref: observation.url ?? observation.id,
    note: observation.text.replace(/\s+/g, ' ').slice(0, 200),
    at: observation.at ?? null,
  };
}

/**
 * Score what has happened and keep what is worth keeping.
 *
 * Deterministic, and mostly declines. The declines are counted rather than
 * stored: forty rows saying "nothing to do with this agent" is not something an
 * owner needs to read, and the count is what says the wake actually looked.
 */
export async function attend(
  agentId: string,
  observations: Observation[],
  context: SalienceContext,
): Promise<{ attended: number; reinforced: number; items: AttentionRow[] }> {
  const items: AttentionRow[] = [];
  let reinforced = 0;

  for (const observation of observations) {
    const verdict = scoreObservation(observation, context);
    if (verdict.declined) continue;

    const row = await mind.remember({
      agentId,
      kind: verdict.kind,
      // The observation's own words, trimmed. Reflection writes better
      // summaries later; arriving with the raw text means an item exists to be
      // improved rather than waiting on a model call that may never happen.
      summary: observation.text.replace(/\s+/g, ' ').slice(0, DELIBERATION_LIMITS.summary),
      salience: verdict.salience,
      factors: verdict.factors,
      confidence: 0.5,
      evidence: [evidenceFor(observation)],
      origin: `OBSERVE:${observation.source}`,
      fingerprint: verdict.fingerprint,
    });
    if (row.reinforcements > 1) reinforced += 1;
    items.push(row);
  }

  return { attended: items.length, reinforced, items };
}

/**
 * Let what is no longer being reinforced fade, and keep the set small.
 *
 * Two separate bounds and both are needed. Decay is about truth -- something
 * nothing has pointed at for a fortnight is not what this agent is currently
 * thinking about, whatever it scored the day it arrived. The size cap is about
 * usefulness -- a working set of two hundred items is a list, and a list is
 * what this exists instead of.
 */
export async function decayWorkingSet(
  agentId: string,
  now: Date = new Date(),
): Promise<{ retired: number; kept: number }> {
  const live = await mind.liveItems(agentId);
  let retired = 0;
  let kept = 0;

  const scored = live.map((item) => ({
    item,
    current: decayed(item.salience, item.lastReinforcedAt, ATTENTION_HALF_LIFE_DAYS[item.kind], now),
  }));

  for (const { item, current } of scored) {
    if (current === item.salience) continue;
    if (current < SALIENCE_FLOOR) {
      if (await consolidate(item, 'RETIRED')) kept += 1;
      await mind.settle(item.id, 'RETIRED', 'Nothing has pointed at this in a while.');
      retired += 1;
    } else {
      await mind.reprice(item.id, current, [
        ...item.factors.filter((factor) => factor.name !== 'decay'),
        {
          name: 'decay',
          detail: `Faded from ${item.salience} with nothing reinforcing it.`,
          points: current - item.salience,
        },
      ]);
    }
  }

  // Whatever is left over the cap, weakest first. Retired rather than deleted:
  // the row is how an agent can later say it used to be interested in this.
  const surviving = scored
    .filter(({ item, current }) => current >= SALIENCE_FLOOR && item.state === 'ACTIVE')
    .sort((a, b) => b.current - a.current);
  for (const { item } of surviving.slice(DELIBERATION_LIMITS.workingSet)) {
    if (await consolidate(item, 'RETIRED')) kept += 1;
    await mind.settle(item.id, 'RETIRED', 'Crowded out by things that mattered more.');
    retired += 1;
  }

  return { retired, kept };
}

/**
 * What a faded thought leaves behind.
 *
 * The working set is small and forgetful on purpose -- that is what makes it a
 * present tense rather than a log. But an agent that works something out, holds
 * it for a fortnight and then loses it is a machine that learns and then
 * forgets, so two kinds of item are kept after they stop being current:
 *
 *   - a **lesson**, which is what it concluded about how to act. That is about
 *     itself, so it goes to `PERSONA`.
 *   - a **question or hypothesis that got answered**, which is something it now
 *     knows. That is about the world, so it goes to `KNOWLEDGE`.
 *
 * Everything else leaves the retired row and nothing more. An interest that
 * faded is not a fact, and "it used to care about this" is already answerable
 * from `agent_attention` without putting it somewhere retrieval will find it
 * and quote back as though it were still true.
 *
 * It writes through `memories` -- the same six scopes everything else uses.
 * **There is no separate store for what deliberation learned**, because a
 * second memory is a second answer to "what does this agent know", and the
 * first thing anybody asks of the second one is why it disagrees with the
 * first.
 *
 * **Nothing stored here is a transcript.** The summary is the durable artifact
 * reflection already produced; no model reasoning is kept, shown or carried.
 * The evidence travels with it, because a memory whose grounds are gone is an
 * assertion.
 */
async function consolidate(item: AttentionRow, becoming: AttentionState): Promise<boolean> {
  // An unevidenced claim is not a memory, whatever it scored.
  if (item.evidence.length === 0) return false;
  // Still being worked out. The working set is where that belongs.
  if (item.confidence < 0.5) return false;

  const durable = durableMemoryFor(item, becoming);
  if (!durable) return false;

  const written = await memoriesRepo.writeMemory({
    agentId: item.agentId,
    scope: durable.scope,
    memoryType: durable.memoryType,
    content: item.summary,
    importance: Math.min(1, Math.max(0.3, item.salience / 100)),
    confidence: item.confidence,
    /*
      Where it came from, so a screen showing the memory can show why the agent
      believes it and a person can follow it back to the post it came off.
      Capped at the working set's own limit: a memory carrying forty references
      is a memory nobody will check.
    */
    origin: {
      from: 'deliberation',
      attentionId: item.id,
      kind: item.kind,
      reinforcements: item.reinforcements,
      firstObservedAt: item.firstObservedAt,
      evidence: item.evidence.slice(0, DELIBERATION_LIMITS.evidencePerItem),
    },
  });
  return written.created;
}

/** Which scope a settling item belongs in, and nothing when it belongs in none. */
function durableMemoryFor(
  item: AttentionRow,
  becoming: AttentionState,
): { scope: MemoryScope; memoryType: MemoryType } | null {
  if (item.kind === 'LESSON') return { scope: 'PERSONA', memoryType: 'SUMMARY' };
  if (becoming === 'RESOLVED' && (item.kind === 'QUESTION' || item.kind === 'HYPOTHESIS')) {
    return { scope: 'KNOWLEDGE', memoryType: 'FACT' };
  }
  return null;
}

/** Whether this agent has a model cheap enough to reflect with. */
async function hasReflector(agentId: string): Promise<boolean> {
  const targets = await resolveTargets(agentId, 'classifier');
  return targets.length > 0;
}

const REFLECT_INSTRUCTION = `You are helping an autonomous agent keep track of what it is currently thinking about.

You will be given things the agent recently noticed, and what is already on its mind.

Answer with JSON only, in this shape:
{"items":[{"kind":"INTEREST|CURIOSITY|CONCERN|HYPOTHESIS|QUESTION|LESSON|NARRATIVE|IDEA","summary":"one sentence","detail":"why it matters, one sentence","confidence":0.0-1.0,"from":[0,2]}],"resolved":[{"index":0,"because":"one sentence"}]}

Rules:
- At most 4 items. Usually 0 or 1. Producing nothing is the correct answer when nothing connects.
- "from" lists the indexes of the observations an item rests on. An item with no source is not allowed.
- Never restate an observation. An item must say something the observations do not say individually.
- A QUESTION or CURIOSITY is something the agent cannot answer from what it was given.
- A LESSON is something that turned out to be true about how things went.
- "resolved" names items already on its mind that the new observations answer or settle.
- No reasoning, no preamble, no markdown. JSON only.`;

interface ReflectedItem {
  kind: AttentionKind;
  summary: string;
  detail: string;
  confidence: number;
  from: number[];
}

function parseReflection(text: string): { items: ReflectedItem[]; resolved: { index: number; because: string }[] } | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    const rawItems = Array.isArray(parsed.items) ? parsed.items : [];
    const items: ReflectedItem[] = [];
    for (const raw of rawItems.slice(0, 4)) {
      const entry = raw as Record<string, unknown>;
      const kind = String(entry.kind ?? '') as AttentionKind;
      const summary = String(entry.summary ?? '').trim();
      const from = Array.isArray(entry.from) ? entry.from.map((n) => Number(n)).filter(Number.isInteger) : [];
      // An item with no source is an assertion, and this codebase does not
      // keep assertions. Dropped rather than stored with empty evidence.
      if (!summary || from.length === 0) continue;
      if (!(kind in ATTENTION_HALF_LIFE_DAYS)) continue;
      items.push({
        kind,
        summary: summary.slice(0, DELIBERATION_LIMITS.summary),
        detail: String(entry.detail ?? '').slice(0, 600),
        confidence: Math.max(0, Math.min(1, Number(entry.confidence ?? 0.5))),
        from,
      });
    }
    const rawResolved = Array.isArray(parsed.resolved) ? parsed.resolved : [];
    const resolved = rawResolved
      .map((raw) => raw as Record<string, unknown>)
      .filter((entry) => Number.isInteger(Number(entry.index)))
      .map((entry) => ({ index: Number(entry.index), because: String(entry.because ?? '').slice(0, 400) }));
    return { items, resolved };
  } catch {
    return null;
  }
}

/**
 * Connect what was just noticed to what was already known.
 *
 * The one place a model is asked to do the thinking, and it is fenced in four
 * ways: a `classifier` role only, one call, a timeout, and a schema that
 * refuses an item with no evidence. Everything that goes wrong -- no model, a
 * timeout, malformed JSON, an item that cites nothing -- means the wake keeps
 * what attention already produced and records that reflection did not run. The
 * working set is never worse for having tried.
 *
 * `docs/ENGINEERING.md`'s rule about planning applies exactly: never route this
 * to the primary model. An expensive reasoning call to decide whether anything
 * interesting happened is the opposite of the point.
 */
export async function reflect(input: {
  agentId: string;
  fresh: AttentionRow[];
  existing: AttentionRow[];
}): Promise<{ produced: number; resolved: number; kept: number; model: string | null; why: string }> {
  /*
    Nothing to reflect on is not a reason, it is the ordinary case.

    Returned as no reason at all, because the wake's own sentence already says
    "looked at N things and found nothing new" -- and a screen that adds "did
    not get that far" to every quiet wake is a screen that cries wolf until
    nobody reads it. What `why` is for is the wake that had something to think
    about and could not.
  */
  if (input.fresh.length === 0) return { produced: 0, resolved: 0, kept: 0, model: null, why: '' };
  if (!(await hasReflector(input.agentId))) {
    return { produced: 0, resolved: 0, kept: 0, model: null, why: 'no classifier model is configured' };
  }

  const observations = input.fresh.slice(0, 12);
  const described = [
    'Recently noticed:',
    ...observations.map((item, index) => `[${index}] (${item.kind}) ${item.summary}`),
    '',
    'Already on its mind:',
    ...input.existing.slice(0, 10).map((item, index) => `[m${index}] (${item.kind}) ${item.summary}`),
  ].join('\n');

  try {
    const result = await Promise.race([
      generate({
        agentId: input.agentId,
        jobId: null,
        purpose: 'deliberation.reflect',
        role: 'classifier',
        maxCalls: 1,
        messages: [{ role: 'user', content: `${REFLECT_INSTRUCTION}\n\n${described}` }],
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`reflection took longer than ${REFLECT_TIMEOUT_MS}ms`)), REFLECT_TIMEOUT_MS),
      ),
    ]);

    const parsed = parseReflection(result.text);
    if (!parsed) return { produced: 0, resolved: 0, kept: 0, model: result.model ?? null, why: 'the model did not answer in the agreed shape' };

    let produced = 0;
    for (const item of parsed.items) {
      const cited = item.from.map((index) => observations[index]).filter((row): row is AttentionRow => Boolean(row));
      if (cited.length === 0) continue;

      // A conclusion that merely restates one of its own sources is not a
      // conclusion. This is the guard against a reflection loop that turns
      // every observation into an "insight" about that observation.
      if (cited.some((source) => overlap(item.summary, source.summary) > 0.7)) continue;

      await mind.remember({
        agentId: input.agentId,
        kind: item.kind,
        summary: item.summary,
        detail: item.detail,
        // Reflection's own items start below what an observation scores: they
        // are a claim about the observations rather than a thing that happened,
        // and they earn their place by being reinforced.
        salience: Math.round(Math.max(...cited.map((source) => source.salience)) * 0.8),
        confidence: item.confidence,
        evidence: cited.flatMap((source) => source.evidence).slice(0, DELIBERATION_LIMITS.evidencePerItem),
        factors: [
          {
            name: 'connected',
            detail: `Drawn from ${cited.length} thing${cited.length === 1 ? '' : 's'} the agent noticed.`,
            points: 0,
          },
        ],
        origin: 'REFLECT',
        fingerprint: fingerprintOf('REFLECT', item.summary),
      });
      produced += 1;
    }

    let resolved = 0;
    let kept = 0;
    for (const entry of parsed.resolved) {
      const target = input.existing[entry.index];
      if (!target) continue;
      // A question that got answered is the one thing on this set that is
      // knowledge rather than weather, so it is kept before the row settles.
      if (await consolidate(target, 'RESOLVED')) kept += 1;
      await mind.settle(target.id, 'RESOLVED', entry.because || 'Answered by something that happened since.');
      resolved += 1;
    }

    return { produced, resolved, kept, model: result.model ?? null, why: '' };
  } catch (error) {
    const why = errorMessage(error);
    log.debug('reflection fell back to what attention produced', { agentId: input.agentId, message: why });
    return { produced: 0, resolved: 0, kept: 0, model: null, why };
  }
}

/**
 * Turn the strongest of what is on its mind into something it might say.
 *
 * Into `content_ideas`, which is the backlog the posting engine already reads
 * and already decides about. That is the whole integration: deliberation does
 * not post, does not schedule and does not bypass anything. It puts a
 * well-sourced idea where the existing machinery will find it, and that
 * machinery goes on refusing to post when there is nothing worth posting.
 *
 * Deliberately narrow about what qualifies. An agent whose every passing
 * interest becomes a draft is the content generator this codebase keeps saying
 * it does not want.
 */
export async function formIntentions(agentId: string, now: Date = new Date()): Promise<number> {
  const items = await mind.onItsMind(agentId, { limit: 20 });
  let made = 0;

  for (const item of items) {
    // Three bars, and all three have to clear. Strong enough to be worth
    // somebody's timeline; reinforced, so it is a thing this agent keeps
    // returning to rather than a single sighting; and of a kind that is
    // actually about something it could say.
    if (item.salience < 55) continue;
    if (item.reinforcements < 2 && item.kind !== 'LESSON') continue;
    if (!['IDEA', 'LESSON', 'INTEREST', 'HYPOTHESIS'].includes(item.kind)) continue;
    // Anything still being investigated is not ready to be said out loud.
    if (item.confidence < 0.5) continue;

    const summary = item.summary.trim();
    if (summary.length < 30) continue;
    if (await contentRepo.similarExists(agentId, summary)) continue;

    /*
      The one gate on the agent choosing its own subject.

      Answering about an election when somebody asks is the engagement
      heuristic's decision and the policy's; *raising* one is this agent
      deciding, by itself, to publish a political opinion on somebody's real
      account. See `reticence.ts` for why the two are different promises.

      The item is not settled and does not disappear -- it stays on the working
      set, where the agent can still use it if somebody brings the subject up.
      The refusal is recorded as a factor worth no points, so it appears in the
      same list that explains every other score on the screen and costs the item
      nothing.
    */
    const reticent = unpromptedSubject(`${summary} ${item.detail}`);
    if (reticent) {
      if (!item.factors.some((factor) => factor.name === 'not-raised-unprompted')) {
        await mind.reprice(item.id, item.salience, [
          ...item.factors,
          { name: 'not-raised-unprompted', detail: reticenceReason(reticent), points: 0 },
        ]);
      }
      continue;
    }

    await contentRepo.addIdea({
      agentId,
      kind: item.kind === 'LESSON' ? 'observation' : 'opinion',
      summary,
      source: 'deliberation',
      sourceHandle: null,
      sourceJobId: null,
      // What it scored, carried across so the backlog ranks by the same
      // judgement that put it there.
      score: Math.min(100, item.salience),
    });
    // Marked so the same item does not produce a second idea next wake.
    await mind.noteReviewed(item.id, new Date(now.getTime() + 7 * 24 * 3600_000).toISOString());
    made += 1;
  }

  return made;
}

/**
 * Posts this agent decided were worth acknowledging.
 *
 * The other half of `formIntentions`. That one turns a thought into something
 * to *say*; this turns an observation into something to *acknowledge*, which is
 * a different decision about a different object. An idea has no target and a
 * like is nothing but a target.
 *
 * Only what was actually seen on X, and only where there is a real post id to
 * act on: a like anchored to anything else is a like that cannot be verified
 * and cannot be deduplicated. `worthEngaging` does the judging and declines
 * most of it, which is the point.
 *
 * Proposing is all that happens here. Whether a proposal is ever taken is the
 * autonomy ladder's business and `runDueEngagements`'s, and below ACT the
 * answer is never.
 */
export async function formEngagements(agentId: string, observations: Observation[]): Promise<number> {
  const links = await accountsRepo.listAgentAccounts(agentId);
  const accountId = links[0]?.accountId;
  if (!accountId) return 0;

  const [persona, account, known, already] = await Promise.all([
    agentsRepo.getActivePersona(agentId),
    accountsRepo.getAccount(accountId),
    relationshipsRepo.listForAgent(agentId, { limit: 150 }),
    engagementsRepo.actedOn(agentId),
  ]);

  const people = new Map<string, { inboundCount: number; disposition: string }>();
  for (const person of known) {
    people.set(person.handle.toLowerCase(), {
      inboundCount: person.inboundCount,
      disposition: person.disposition,
    });
  }

  const context = {
    topics: persona?.topics ?? [],
    selfHandles: account?.handle ? [account.handle] : [],
    people,
    alreadyEngaged: already,
  };

  let proposed = 0;
  for (const observation of observations) {
    // Only what somebody else posted on X. The agent's own actions, its
    // stances, its commitments and a repository's commits are all observations
    // and none of them is a post anybody can like.
    if (observation.source !== 'DISCOVERY' && observation.source !== 'MENTION' && observation.source !== 'REPLY') {
      continue;
    }
    const remoteId = remoteIdFrom(observation.url);
    if (!remoteId) continue;

    const ageHours = observation.at
      ? (Date.now() - new Date(observation.at).getTime()) / 3600_000
      : null;

    const worth = worthEngaging(
      {
        remoteId,
        url: observation.url ?? '',
        authorHandle: observation.handle ?? '',
        text: observation.text,
        metrics: observation.metrics ?? null,
        ageHours,
      },
      context,
    );
    if (!worth.kind) continue;

    const row = await engagementsRepo.propose({
      agentId,
      accountId,
      kind: worth.kind,
      remoteId,
      remoteUrl: observation.url ?? '',
      authorHandle: observation.handle ?? '',
      excerpt: observation.text.replace(/\s+/g, ' ').slice(0, 280),
      score: worth.score,
      factors: worth.factors,
      confidence: worth.confidence,
    });
    if (row) proposed += 1;
  }

  return proposed;
}

/**
 * The post id out of an X permalink.
 *
 * The action is anchored to the id and never to the URL, because one post can
 * be written several ways -- with or without the handle's original casing, with
 * or without a query string -- and an idempotency key built on the spelling
 * would let the same like through twice.
 */
function remoteIdFrom(url: string | null | undefined): string | null {
  if (!url) return null;
  const match = /\/status(?:es)?\/(\d{5,25})/.exec(url);
  return match?.[1] ?? null;
}

/**
 * One wake.
 *
 * Idempotent and restart-safe by construction: everything it reads is a query
 * over committed rows, everything it writes is an upsert on a fingerprint, and
 * the claim that selected this agent already moved its due time. A worker that
 * dies mid-wake loses the rest of this wake and nothing else.
 */
export async function wakeAgent(
  agentId: string,
  options: {
    now?: Date;
    /**
     * Whether this wake may go and look something up.
     *
     * Passed in rather than worked out, because the answer is "am I the worker",
     * and a module that guesses that is a module that will be wrong in a test.
     * The API owns no browsers, so its "think now" leaves this false and the
     * outcome says nothing was looked up rather than quietly failing to.
     */
    mayResearch?: boolean;
  } = {},
): Promise<WakeOutcome> {
  const now = options.now ?? new Date();
  const wake = await mind.getWake(agentId);
  if (!wake || !wake.enabled) {
    return emptyOutcome(agentId, wake?.autonomy ?? 'OBSERVE', 'Deliberation is switched off.', 'disabled');
  }

  const agent = await agentsRepo.getAgent(agentId);
  if (!agent || agent.state !== 'ACTIVE') {
    return emptyOutcome(agentId, wake.autonomy, 'The agent is not active.', 'inactive');
  }

  /*
    PAUSE ALL is supreme, and it stops thinking as well as acting.

    Reading continues while paused elsewhere in AI17Z -- a paused agent still
    ingests, because stopping that would mean losing what happened rather than
    declining to act on it. Deliberation is different: it costs model calls and
    changes the agent's own state, and an owner who pressed pause did not mean
    "keep developing opinions".
  */
  const paused = await pauseState();
  if (paused.paused) {
    await mind.noteWake(agentId, { reason: 'Everything is paused.', quiet: true });
    return emptyOutcome(agentId, wake.autonomy, 'Everything is paused.', 'paused');
  }

  const links = await accountsRepo.listAgentAccounts(agentId);
  const accountId = links[0]?.accountId ?? null;
  const since = wake.lastWakeAt ?? new Date(now.getTime() - FIRST_LOOK_HOURS * 3600_000).toISOString();

  const context = await contextFor(agentId, accountId);
  const [rows, repoRows] = await Promise.all([
    mind.recentObservations({
      agentId,
      accountId,
      sinceIso: since,
      limit: DELIBERATION_LIMITS.observationsPerWake,
    }),
    // What the projects it watches actually did. Read separately from the rest
    // because most of it has to be thrown away first: a repository's day is
    // mostly mechanical, and an agent that treats every commit as news is the
    // changelog bot everybody predicts.
    agent.ownerId
      ? repoSources.recentRepoEvents({ ownerUserId: agent.ownerId, agentId, sinceIso: since, limit: 40 })
      : Promise.resolve([]),
  ]);

  const observations = [...rows.map(toObservation), ...repoObservations(repoRows)];

  const { attended, reinforced, items } = await attend(agentId, observations, context);

  let produced = 0;
  let resolvedCount = 0;
  let kept = 0;
  let model: string | null = null;
  let whyNotReflected: string | null = null;
  let retired = 0;
  let candidates = 0;
  const deep = autonomyAtLeast(wake.autonomy, 'THINK') && (await mind.deepIsDue(agentId));

  if (autonomyAtLeast(wake.autonomy, 'THINK')) {
    const existing = await mind.onItsMind(agentId, { limit: 10 });
    const outcome = await reflect({ agentId, fresh: items, existing });
    produced = outcome.produced;
    resolvedCount = outcome.resolved;
    kept = outcome.kept;
    model = outcome.model;
    /*
      Kept rather than discarded.

      `reflect` has always known why it produced nothing -- no classifier
      configured, a timeout, an answer in the wrong shape, an exception -- and
      this is where that was thrown away. The only trace was a `log.debug`,
      which is below the default level, so a reflection that failed and one
      that correctly found nothing showed an owner the same two zeros. That is
      the same shape of defect as a bare catch, and this codebase has paid for
      it twice.
    */
    whyNotReflected = outcome.produced === 0 && outcome.why ? outcome.why : null;
    // Decay runs on every thinking wake rather than only on the deep pass:
    // a working set that only fades once a day is a working set that is wrong
    // for most of the day.
    const faded = await decayWorkingSet(agentId, now);
    retired = faded.retired;
    kept += faded.kept;
  }

  /*
    Going and finding out, once per wake at most.

    After reflection rather than before it, because reflection is what turns
    "somebody said a thing I do not understand" into a question worth asking --
    looking first would mean looking up last wake's questions with this wake's
    budget.

    Thinking rather than acting, so THINK is the rung: an owner who asked for an
    agent that develops its own interests and never resolves any of them has an
    agent that only accumulates doubt. It still costs a browser lease, so it
    happens only where a browser exists and only when the owner's own research
    sources are on.
  */
  let lookedInto: WakeOutcome['lookedInto'] = null;
  if (options.mayResearch && autonomyAtLeast(wake.autonomy, 'THINK')) {
    const found = await lookIntoSomething(agentId, { now });
    if (found) lookedInto = { question: found.question, findings: found.findings };
  }

  let engagements = 0;
  if (autonomyAtLeast(wake.autonomy, 'SUGGEST')) {
    candidates = await formIntentions(agentId, now);
    /*
      Proposed at the same rung that offers something to say, because they are
      the same kind of decision: the agent putting a candidate where somebody
      can look at it. Whether either is ever taken is ACT's business.
    */
    engagements = await formEngagements(agentId, observations);
  }

  const somethingHappened =
    attended > 0 || produced > 0 || candidates > 0 || resolvedCount > 0 || lookedInto !== null || engagements > 0;
  const reason = somethingHappened
    ? [
        attended > 0 ? `${attended} worth noticing` : '',
        produced > 0 ? `${produced} new` : '',
        resolvedCount > 0 ? `${resolvedCount} settled` : '',
        candidates > 0 ? `${candidates} worth saying` : '',
        engagements > 0 ? `${engagements} worth acknowledging` : '',
        retired > 0 ? `${retired} faded` : '',
        kept > 0 ? `${kept} kept` : '',
        lookedInto
          ? lookedInto.findings > 0
            ? `looked one up and found ${lookedInto.findings}`
            : 'looked one up and found nothing'
          : '',
      ]
        .filter(Boolean)
        .join(', ')
    : `Looked at ${observations.length} thing${observations.length === 1 ? '' : 's'} and found nothing new.`;

  /*
    Back off when nothing is happening.

    Doubling from the configured interval to a ceiling of eight times it. An
    agent whose world has gone quiet should not cost a model call every half
    hour for ever; one that has been quiet all afternoon should still notice
    within the hour. Any activity at all resets it, which `noteWake` does.
  */
  const backoff = somethingHappened ? 1 : Math.min(QUIET_BACKOFF_MAX, Math.pow(2, wake.quietWakes));
  const nextWakeAt = new Date(now.getTime() + wake.intervalSeconds * backoff * 1000).toISOString();

  await mind.noteWake(agentId, { reason, quiet: !somethingHappened, nextWakeAt, didDeep: deep });
  await mind.recordReflection({
    agentId,
    kind: deep ? 'DEEP' : autonomyAtLeast(wake.autonomy, 'THINK') ? 'PERIODIC' : 'LIGHT',
    considered: observations.length,
    produced,
    reinforced,
    retired,
    summary: reason,
    model,
    durationMs: Date.now() - now.getTime(),
    why: whyNotReflected,
  });

  // Said out loud, not only stored. A reflection that threw is a thing
  // somebody reading a log should find out about without turning on debug.
  if (whyNotReflected && model === null) {
    log.warn('reflection did not run', { agentId, why: whyNotReflected });
  }

  if (somethingHappened) {
    log.info('an agent thought about something', { agentId, attended, produced, candidates, retired });
  }

  return {
    agentId,
    autonomy: wake.autonomy,
    observed: observations.length,
    attended,
    reinforced,
    produced,
    retired,
    kept,
    lookedInto,
    candidates,
    engagements,
    deep,
    reason,
  };
}

/**
 * Wake whichever agents are due.
 *
 * The claim inside `claimDueWakes` moves each agent's due time forward in the
 * statement that selects it, so two workers cannot wake one agent and a restart
 * cannot stampede every agent at once. The tick is not the interval: each agent
 * carries its own, and this is usually one indexed query returning nothing.
 */
export async function wakeDueAgents(limit = 3): Promise<WakeOutcome[]> {
  const due = await mind.claimDueWakes(limit, 300);
  const outcomes: WakeOutcome[] = [];
  for (const row of due) {
    try {
      // This loop runs in the worker, which is the only process that owns a
      // browser -- so this is the one path a lookup can happen on.
      outcomes.push(await wakeAgent(row.agentId, { mayResearch: true }));
    } catch (error) {
      // One agent's bad wake is not the loop's problem. The claim already moved
      // its due time, so a failing agent backs off on its own rather than being
      // retried every tick.
      log.warn('a wake failed', { agentId: row.agentId, message: errorMessage(error) });
      await mind
        .noteWake(row.agentId, { reason: `Thinking failed: ${errorMessage(error)}`, quiet: true })
        .catch(() => undefined);
    }
  }
  return outcomes;
}

/**
 * What the agent has been thinking about, where it bears on the message in hand.
 *
 * The rule this implements is the one that keeps a working set from becoming a
 * liability: **internal state reaches a reply only when it is relevant.** An
 * agent may be uneasy about something all week without every answer mentioning
 * it, and one that mentions it anyway reads as an agent that cannot tell what
 * it is talking about -- which is worse than an agent with no internal state,
 * because it is actively distracting.
 *
 * A post is the deliberate exception. There is no incoming message for anything
 * to be relevant *to*, and "what has this agent been thinking about" is exactly
 * the question an original post answers -- so the strongest items travel
 * whatever they are about, and the generation step decides which one it
 * actually wants.
 *
 * Bounded either way. `DELIBERATION_LIMITS.inPrompt` is a ceiling on how much
 * of its own head an agent brings to a conversation, and past it a prompt stops
 * being context and becomes a journal dump.
 */
export async function mindForMessage(
  agentId: string,
  text: string,
  isPost: boolean,
): Promise<{ kind: AttentionKind; summary: string; confidence: number }[]> {
  const items = await mind.onItsMind(agentId, { limit: 30 });
  if (items.length === 0) return [];

  const chosen = isPost
    ? items
        /*
          A post is the agent choosing its own subject, which is the one place
          reticence applies. Filtered here as well as in `formIntentions`,
          because a post can also be written from an idea a person put in the
          backlog, and this is the last point before any text exists.
        */
        .filter((item) => !unpromptedSubject(`${item.summary} ${item.detail}`))
        .slice(0, DELIBERATION_LIMITS.inPrompt)
    : items
        .map((item) => ({ item, relevance: overlap(text, `${item.summary} ${item.detail}`) }))
        // A quarter of the distinctive words in common. Lower and an agent
        // brings up its concerns because somebody used the word "the".
        .filter((scored) => scored.relevance >= 0.25)
        .sort((a, b) => b.relevance - a.relevance || b.item.salience - a.item.salience)
        .slice(0, DELIBERATION_LIMITS.inPrompt)
        .map((scored) => scored.item);

  return chosen.map((item) => ({
    kind: item.kind,
    summary: item.summary,
    confidence: Number(item.confidence),
  }));
}
