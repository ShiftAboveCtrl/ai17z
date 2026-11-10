import { agents as agentsRepo, leagueBridge, trading } from '@xbam/database';
import type { LeagueEntryRow } from '@xbam/database';
import { NotFoundError, backoffMs, createLogger, errorMessage } from '@xbam/shared';
import {
  LEAGUE_FILLS_PER_REPORT,
  LEAGUE_PROTOCOL,
  LEAGUE_SLUG,
  LeagueAlias,
  LeagueEntryAnswer,
  LeagueFill,
  LeagueFillAnswer,
  LeagueStandingDocument,
  type LeagueEntryRequest,
  type LeagueFillReport,
  type LeagueSeasonDocument,
} from '@xbam/shared/contracts';
import { studioInstallationRequest } from './studioLink';
import {
  contentHashOf,
  fillFromIntent,
  fillKeyOf,
  isCurrent,
  judgeEntry,
  mandateFromSeason,
  parseSeason,
} from './leagueSeason';

const log = createLogger('studio-league');

/**
 * The outbound half of the paper league bridge. The account is
 * `docs/architecture/STUDIO_LEAGUE_BRIDGE.md`; this file is the part that
 * talks to Studio, over the installation's own DPoP-bound requests and nowhere
 * else.
 *
 * ## What it cannot do
 *
 * It reaches no wallet, no signer and not Studio's live trade path: the only trading
 * code it calls is `trading.setMandatePaused` (to stop a cancelled season's
 * paper mandate) and the repository functions that write a PAPER mandate.
 * `tests/unit/leagueBridge.test.ts` reads this file's imports to keep that true.
 *
 * ## What it keeps
 *
 * The season it applied (so an unreachable Studio leaves a season to keep
 * running on paper) and the fills it reported. It keeps no standing: a rank is
 * read when somebody asks and said for that answer, never replayed.
 */

const BASE = '/api/v1/installation/league/seasons';

export type Problem = { ok: false; why: string };

const seasonPath = (slug: string) => `${BASE}/${slug}`;

// ---------------------------------------------------------------------------
// Reading a season
// ---------------------------------------------------------------------------

/** One published season, strictly parsed, current and hash-checked, or a sentence. Nothing is written. */
export async function readLeagueSeason(slug: string, now: Date = new Date()): Promise<{ ok: true; season: LeagueSeasonDocument } | Problem> {
  if (!LEAGUE_SLUG.test(slug)) return { ok: false, why: 'That is not the name of a league season.' };
  const answer = await studioInstallationRequest(seasonPath(slug), { method: 'GET' });
  if (!answer.ok) return answer;
  if (answer.status === 404) return { ok: false, why: 'Studio has no published season with that name.' };
  if (answer.status !== 200) return { ok: false, why: answer.sentence };
  const read = parseSeason(answer.body, slug);
  if (!read.ok) return read;
  if (!isCurrent(read.season.generated_at, now)) return { ok: false, why: "Studio's season is not current, so it was not treated as live." };
  return read;
}

// ---------------------------------------------------------------------------
// Entering
// ---------------------------------------------------------------------------

export interface EnterLeagueInput {
  agentId: string;
  ownerId: string;
  slug: string;
  alias: string;
  /** The owner's say-so that the season may replace this agent's own paper mandate. A live mandate is never replaced. */
  replacePaperMandate?: boolean;
}

export type EnterLeagueResult =
  | { ok: true; entry: LeagueEntryRow; state: 'ACTIVE' | 'PENDING' }
  | Problem;

/**
 * An owner entering their agent in a season.
 *
 * ## The order is the safety
 *
 * 1. Read the season and refuse it, whole, before anything is written.
 * 2. Check the agent's mandate slot, so a live mandate or an unconfirmed paper
 *    one stops the entry before Studio is told anything.
 * 3. Record the intent to enter, keyed. Written first so a crash leaves a row to
 *    resume rather than an entry at Studio nothing here knows about.
 * 4. Tell Studio, under that key. A repeat is the same entry.
 * 5. Only then write the paper mandate and mark the entry active, together.
 *
 * An entry Studio refused therefore never replaced anything of the owner's.
 */
export async function enterLeagueSeason(input: EnterLeagueInput, now: Date = new Date()): Promise<EnterLeagueResult> {
  const agent = await agentsRepo.getAgent(input.agentId);
  if (!agent || agent.ownerId !== input.ownerId) throw new NotFoundError('Agent');
  const alias = LeagueAlias.safeParse(input.alias);
  if (!alias.success) return { ok: false, why: `That alias will not do: ${alias.error.issues[0]?.message ?? 'it is not valid'}` };
  const replace = input.replacePaperMandate === true;

  const read = await readLeagueSeason(input.slug, now);
  if (!read.ok) return read;
  const season = read.season;
  const allowed = judgeEntry(season, now);
  if (!allowed.ok) return allowed;
  const mandate = mandateFromSeason(season.season.rules, season.season.ends_at);
  if (!mandate.ok) return mandate;
  const slot = await leagueBridge.mandateSlot(input.agentId, replace);
  if (!slot.ok) return { ok: false, why: slot.why };

  const created = await leagueBridge.createPendingEntry({
    agentId: input.agentId,
    ownerId: input.ownerId,
    seasonSlug: input.slug,
    alias: alias.data,
    replacePaperMandate: replace,
    season,
    rulesHash: season.season.rules_hash,
    startsAt: season.season.starts_at,
    endsAt: season.season.ends_at,
    fillsAcceptedUntil: season.season.fills_accepted_until,
  });
  if (created.kind === 'OTHER_LIVE_ENTRY') {
    return { ok: false, why: `This agent is already entered in "${created.row.seasonSlug}". An agent has one paper mandate, so it is in one season at a time.` };
  }
  if (created.kind === 'ALREADY_SETTLED') {
    return { ok: false, why: `This agent's entry in this season is ${created.row.status.toLowerCase()}${created.row.statusReason ? `: ${created.row.statusReason}` : ''}. An entry is not reopened or changed.` };
  }
  if (created.row.rulesHash !== season.season.rules_hash) {
    return { ok: false, why: 'The season\'s rules are not the ones this entry was made under. Rules are frozen once published, so the answer was ignored.' };
  }
  const settled = await advanceEntry(created.row, now);
  return settled.ok ? { ok: true, entry: settled.entry, state: settled.entry.status === 'ACTIVE' ? 'ACTIVE' : 'PENDING' } : settled;
}

/** Statuses from Studio that mean "no", as opposed to "not now". */
const DEFINITIVE = new Set([400, 403, 404, 409, 410, 422]);

/**
 * Takes a PENDING entry as far as it will go: tell Studio, then write the
 * mandate. Safe to call again, from the entering call or from the sweep.
 */
async function advanceEntry(entry: LeagueEntryRow, now: Date): Promise<{ ok: true; entry: LeagueEntryRow } | Problem> {
  let current = entry;
  if (current.status !== 'PENDING') return { ok: true, entry: current };
  const season = parseSeason(current.season, current.seasonSlug);
  if (!season.ok) {
    await leagueBridge.refuseEntry(current.id, season.why);
    return season;
  }

  if (!current.remoteEntryId) {
    if (now.getTime() >= Date.parse(season.season.season.entry_closes_at)) {
      const why = 'Entry closed before Studio took this one, so it was not made.';
      await leagueBridge.refuseEntry(current.id, why);
      return { ok: false, why };
    }
    const request: LeagueEntryRequest = {
      protocol: LEAGUE_PROTOCOL,
      entry_key: current.entryKey,
      rules_hash: current.rulesHash,
      alias: current.alias,
      entrant: 'LOCAL_AGENT',
    };
    const answer = await studioInstallationRequest(`${seasonPath(current.seasonSlug)}/entry`, { method: 'POST', json: request });
    if (!answer.ok) {
      await leagueBridge.noteProblem(current.id, answer.why);
      return { ok: false, why: `${answer.why} The entry is saved and will be tried again.` };
    }
    if (DEFINITIVE.has(answer.status) && !(answer.status === 400 && answer.body?.error === 'invalid_dpop_proof')) {
      await leagueBridge.refuseEntry(current.id, answer.sentence);
      return { ok: false, why: `Studio refused the entry. ${answer.sentence}` };
    }
    const parsed = LeagueEntryAnswer.safeParse(answer.body);
    if ((answer.status !== 200 && answer.status !== 201) || !parsed.success || parsed.data.season_slug !== current.seasonSlug) {
      const why = answer.status === 200 || answer.status === 201 ? 'Studio answered the entry with something other than an entry, so none of it was used.' : answer.sentence;
      await leagueBridge.noteProblem(current.id, why);
      return { ok: false, why: `${why} The entry is saved and will be tried again.` };
    }
    const stored = await leagueBridge.setRemoteEntry(current.id, parsed.data.entry_id);
    if (!stored) {
      const again = await leagueBridge.getEntry(current.id);
      if (again?.remoteEntryId !== parsed.data.entry_id) return { ok: false, why: 'Studio answered with a different entry than the one already recorded, so it was ignored.' };
      current = again;
    } else current = stored;
  }

  const mandate = mandateFromSeason(season.season.season.rules, season.season.season.ends_at);
  if (!mandate.ok) {
    await leagueBridge.noteProblem(current.id, mandate.why);
    return mandate;
  }
  const activated = await leagueBridge.activateEntry({ entryId: current.id, mandate: mandate.mandate, replacePaperMandate: current.replacePaperMandate });
  if (!activated.ok) {
    await leagueBridge.noteProblem(current.id, activated.why);
    return { ok: false, why: activated.why };
  }
  return { ok: true, entry: activated.entry };
}

// ---------------------------------------------------------------------------
// Reporting fills
// ---------------------------------------------------------------------------

export interface ReportOutcome {
  recorded: number;
  accepted: number;
  rejected: number;
  deferred: number;
}

/**
 * Copies this entry's paper fills into the report ledger, then sends what is
 * due. Idempotent at every step: a fill is recorded once (a primary key), sent
 * under a key derived from the entry and the fill, and settled once.
 *
 * A fill outside the season window is kept as LOCAL_ONLY with the reason and is
 * never sent. Past the report deadline, whatever is still unsent becomes
 * LOCAL_ONLY too, and the entry ends. Nothing is ever edited: a stored report
 * is frozen by the database, so a retry sends the same bytes.
 */
export async function reportLeagueFills(entry: LeagueEntryRow, now: Date = new Date()): Promise<ReportOutcome> {
  const out: ReportOutcome = { recorded: 0, accepted: 0, rejected: 0, deferred: 0 };
  if (entry.status !== 'ACTIVE' || !entry.mandateId || !entry.remoteEntryId) return out;
  const season = parseSeason(entry.season, entry.seasonSlug);
  if (!season.ok) return out;

  const known = new Set((await leagueBridge.fillsOf(entry.id)).map((f) => f.intentId));
  const fresh = (await leagueBridge.paperFillsUnderMandate(entry.mandateId)).filter((f) => !known.has(f.intentId));
  if (fresh.length > 0) {
    const quoteAddress = season.season.season.rules.quote.address;
    out.recorded = await leagueBridge.recordFills(
      entry.id,
      fresh.map((intent) => {
        const verdict = fillFromIntent(entry.entryKey, intent, { quoteAddress, startsAt: entry.startsAt, endsAt: entry.endsAt });
        const fillKey = fillKeyOf(entry.entryKey, intent.intentId);
        return verdict.ok
          ? { intentId: intent.intentId, fillKey, filledAt: verdict.fill.filled_at, payload: verdict.fill, contentHash: contentHashOf(verdict.fill), state: 'PENDING' as const, reason: null }
          : {
              intentId: intent.intentId,
              fillKey,
              filledAt: intent.filledAt,
              // Nothing of the fill is stored beyond the fact it was not counted.
              payload: { simulated: true, counted: false },
              contentHash: contentHashOf({ fillKey, why: verdict.why }),
              state: 'LOCAL_ONLY' as const,
              reason: verdict.why,
            };
      }),
    );
  }

  if (now.getTime() > Date.parse(entry.fillsAcceptedUntil)) {
    for (const f of await leagueBridge.dueFills(entry.id, new Date('9999-12-31T00:00:00Z'), 10_000)) {
      await leagueBridge.settleFill(entry.id, f.fillKey, 'LOCAL_ONLY', 'Studio no longer takes fills for this season, so this one was not counted.');
    }
    await leagueBridge.endEntry(entry.id, 'The season is over and its report window has closed.');
    return out;
  }

  // A stored payload is read back through the contract's own schema, never cast:
  // a row that no longer fits (hand edited past the trigger, or written by a
  // build with another schema) is rejected for good rather than sent.
  const dueRows = await leagueBridge.dueFills(entry.id, now, LEAGUE_FILLS_PER_REPORT);
  const due: typeof dueRows = [];
  const fills: LeagueFill[] = [];
  for (const row of dueRows) {
    const stored = LeagueFill.safeParse(row.payload);
    if (stored.success && stored.data.fill_key === row.fillKey) {
      due.push(row);
      fills.push(stored.data);
    } else {
      await leagueBridge.settleFill(entry.id, row.fillKey, 'REJECTED', 'The stored report no longer fits the contract, so it was not sent.');
      out.rejected += 1;
    }
  }
  if (due.length === 0) return out;
  const report: LeagueFillReport = { protocol: LEAGUE_PROTOCOL, entry_id: entry.remoteEntryId, fills };
  const keys = due.map((f) => f.fillKey);
  const retryAt = () => new Date(now.getTime() + backoffMs(Math.max(...due.map((f) => f.attempts)), 60_000, 60 * 60_000));

  const answer = await studioInstallationRequest(`${seasonPath(entry.seasonSlug)}/entry/fills`, { method: 'POST', json: report });
  if (!answer.ok) {
    await leagueBridge.deferFills(entry.id, keys, retryAt());
    await leagueBridge.noteProblem(entry.id, answer.why);
    out.deferred = keys.length;
    return out;
  }
  if (DEFINITIVE.has(answer.status)) {
    for (const key of keys) await leagueBridge.settleFill(entry.id, key, 'REJECTED', answer.sentence);
    await leagueBridge.noteProblem(entry.id, answer.sentence);
    out.rejected += keys.length;
    return out;
  }
  const parsed = LeagueFillAnswer.safeParse(answer.body);
  if (answer.status !== 200 || !parsed.success) {
    await leagueBridge.deferFills(entry.id, keys, retryAt());
    await leagueBridge.noteProblem(entry.id, answer.status === 200 ? 'Studio answered a fill report with something other than an answer to it.' : answer.sentence);
    out.deferred = keys.length;
    return out;
  }

  // Every key in the answer must be one that was sent, and counted once. A key
  // Studio did not account for stays pending and is sent again, under the same
  // key and the same bytes.
  const sent = new Set(keys);
  const seen = new Set<string>();
  const outcome = new Map<string, { state: 'ACCEPTED' | 'REJECTED'; reason: string | null }>();
  const note = (key: string, state: 'ACCEPTED' | 'REJECTED', reason: string | null): void => {
    if (!sent.has(key) || seen.has(key)) return;
    seen.add(key);
    outcome.set(key, { state, reason });
  };
  for (const key of parsed.data.accepted) note(key, 'ACCEPTED', null);
  for (const key of parsed.data.duplicates) note(key, 'ACCEPTED', null);
  for (const r of parsed.data.rejected) note(r.fill_key, 'REJECTED', `Studio did not count it: ${r.reason.toLowerCase().replace(/_/g, ' ')}.`);
  for (const [key, o] of outcome) {
    await leagueBridge.settleFill(entry.id, key, o.state, o.reason);
    if (o.state === 'ACCEPTED') out.accepted += 1;
    else out.rejected += 1;
  }
  const unaccounted = keys.filter((k) => !outcome.has(k));
  if (unaccounted.length > 0) {
    await leagueBridge.deferFills(entry.id, unaccounted, retryAt());
    out.deferred = unaccounted.length;
  }
  if (out.rejected === 0 && unaccounted.length === 0) await leagueBridge.noteProblem(entry.id, null);
  return out;
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

const SEASON_CHECK_EVERY_MS = 30 * 60_000;

/**
 * How long a pending entry waits between tries: a tenth of the time it has been
 * waiting, between a minute and a quarter of an hour. Elapsed time sets the pace
 * and never the outcome: an entry is dropped only when the season's entry lock
 * passes (see `advanceEntry`) or Studio says no, because a Studio outage of any
 * length is not a refusal and the owner must not lose the season to one.
 */
export function pendingRetryDelayMs(elapsedMs: number): number {
  return Math.min(15 * 60_000, Math.max(60_000, Math.floor(elapsedMs / 10)));
}

/**
 * One pass over every open entry, on the worker's ordinary sweep rather than a
 * timer of its own. With no entries it is one indexed query and sends nothing:
 * the switch is the owner's act of entering.
 *
 * It keeps reporting fills while PAUSE ALL is set, deliberately. Reporting is a
 * record of paper fills already made, not a new action, and a pause that
 * silently dropped the record would leave a season with gaps nobody chose.
 */
export async function sweepLeagueBridge(now: Date = new Date()): Promise<{ entries: number; recorded: number; accepted: number; deferred: number }> {
  const tally = { entries: 0, recorded: 0, accepted: 0, deferred: 0 };
  for (const entry of await leagueBridge.openEntries()) {
    tally.entries += 1;
    try {
      if (entry.status === 'PENDING') {
        if (entry.remoteEntryId && now.getTime() > Date.parse(entry.endsAt)) {
          // Studio holds the entry but the mandate could never be written (a live
          // mandate in the way, say) and the season is over: nothing left to do.
          await leagueBridge.endEntry(entry.id, 'The season ended before this entry could be activated here.');
          continue;
        }
        // Every failed try stamps `updated_at`, so the wait runs from the last try.
        const waited = now.getTime() - Date.parse(entry.updatedAt);
        if (waited < pendingRetryDelayMs(now.getTime() - Date.parse(entry.createdAt))) continue;
        await advanceEntry(entry, now);
        continue;
      }
      const reported = await reportLeagueFills(entry, now);
      tally.recorded += reported.recorded;
      tally.accepted += reported.accepted;
      tally.deferred += reported.deferred;
      const latest = await leagueBridge.getEntry(entry.id);
      if (latest?.status === 'ACTIVE' && (!latest.lastSeasonCheckAt || now.getTime() - Date.parse(latest.lastSeasonCheckAt) >= SEASON_CHECK_EVERY_MS)) {
        await checkSeason(latest, now);
      }
    } catch (error) {
      log.warn('league entry sweep failed', { entry: entry.id, message: errorMessage(error) });
    }
  }
  return tally;
}

/**
 * Asks Studio whether the season is still the one that was applied.
 *
 * Unreachable, malformed or not current: the applied season keeps running on
 * paper and the problem is recorded; nothing is changed on a guess. A different
 * hash is ignored (rules are frozen, so it is Studio's mistake or worse), and a
 * cancelled season ends the entry and pauses its mandate.
 */
async function checkSeason(entry: LeagueEntryRow, now: Date): Promise<void> {
  await leagueBridge.noteSeasonChecked(entry.id);
  const read = await readLeagueSeason(entry.seasonSlug, now);
  if (!read.ok) {
    await leagueBridge.noteProblem(entry.id, read.why);
    return;
  }
  if (read.season.season.rules_hash !== entry.rulesHash) {
    await leagueBridge.noteProblem(entry.id, 'Studio now publishes different rules for this season. Rules are frozen, so the answer was ignored and the applied season keeps running.');
    return;
  }
  if (read.season.season.status === 'CANCELLED') {
    await leagueBridge.endEntry(entry.id, 'Studio cancelled the season.');
    if (entry.mandateId) await trading.setMandatePaused(entry.mandateId, true);
  }
}

// ---------------------------------------------------------------------------
// Standing
// ---------------------------------------------------------------------------

export type StandingRead =
  | { ok: true; standing: LeagueStandingDocument; entry: LeagueEntryRow; seasonTitle: string }
  | { ok: false; why: string; code: 'NOT_ENTERED' | 'UNAVAILABLE'; entry: LeagueEntryRow | null };

/**
 * This agent's own standing, read from Studio now. Nothing is kept: an
 * unreachable Studio is UNAVAILABLE, never the last rank said again.
 */
export async function readLeagueStanding(agentId: string, now: Date = new Date()): Promise<StandingRead> {
  const entry = (await leagueBridge.liveEntryOf(agentId)) ?? (await leagueBridge.latestEntryOf(agentId));
  if (!entry || entry.status === 'REFUSED') return { ok: false, code: 'NOT_ENTERED', why: 'This agent is not entered in a league season.', entry: null };
  if (!entry.remoteEntryId) {
    return { ok: false, code: 'NOT_ENTERED', why: 'This agent\'s entry has not been taken by Studio yet.', entry };
  }
  const answer = await studioInstallationRequest(`${seasonPath(entry.seasonSlug)}/entry`, { method: 'GET' });
  if (!answer.ok) return { ok: false, code: 'UNAVAILABLE', why: answer.why, entry };
  if (answer.status !== 200) return { ok: false, code: 'UNAVAILABLE', why: answer.status === 404 ? 'Studio has no record of this entry.' : answer.sentence, entry };
  const parsed = LeagueStandingDocument.safeParse(answer.body);
  if (!parsed.success) return { ok: false, code: 'UNAVAILABLE', why: 'Studio answered with something other than a standing this installation reads, so none of it was used.', entry };
  const doc = parsed.data;
  if (doc.season_slug !== entry.seasonSlug || doc.entry_id !== entry.remoteEntryId) {
    return { ok: false, code: 'UNAVAILABLE', why: 'Studio answered for a different entry than this agent\'s, so none of it was used.', entry };
  }
  if (!isCurrent(doc.generated_at, now)) return { ok: false, code: 'UNAVAILABLE', why: "Studio's standing is not current, so it was not treated as live.", entry };
  const title = parseSeason(entry.season, entry.seasonSlug);
  return { ok: true, standing: doc, entry, seasonTitle: title.ok ? title.season.season.title : entry.seasonSlug };
}
