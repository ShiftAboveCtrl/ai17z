import { PipelineError, createLogger, errorMessage } from '@xbam/shared';
import { LeaguePostFacts, type LeaguePostKind, type PolicyConfig } from '@xbam/shared/contracts';
import { agents as agentsRepo, leagueBridge, query, withAdvisoryLock, withTransaction, type LeagueEntryRow } from '@xbam/database';
import { parseSeason } from './leagueSeason';
import { postingGate } from './radarReceipts';
import { unpromptedSubject } from './reticence';
import { signalPublicationRefusal } from './signalRadar';
import { readLeagueStanding } from './studioLeague';
import { FORWARD_LOOKING, LIVE_OR_REAL } from './studioPaperVoice';

const log = createLogger('studio-league-voice');

/**
 * The agent performing its paper league season in public.
 *
 * Three posts per league entry, at most: one when it enters, one standing note
 * mid season and one recap. The unique key on `league_season_posts (entry_id,
 * kind)` is the cap, so no loop in this file can make a fourth.
 *
 * ## What it reads, and what it cannot
 *
 * Its own standing, through `readLeagueStanding`, which asks Studio for this
 * agent's own entry and nothing else, and its own fill ledger and published
 * receipts. There is no import here that could fetch another entrant's record,
 * and `tests/unit/studioLeagueVoice.test.ts` reads this file's imports to keep
 * that true. Rank and the size of the field are counts about this agent's own
 * place; no other entrant's name, account, wallet or figure has anywhere to
 * live in `LeaguePostFacts`.
 *
 * ## What it never says
 *
 * No return, percentage, profit or loss: the standing's own return field is
 * deliberately not read into a post at all, because a rank headline that leads
 * with a return edges into the performance lane. No comparison with another
 * entrant. Every figure is labelled simulated paper. The words are held to
 * `signalPublicationRefusal` (no PnL, called it, hit rate) on the idea and
 * again on the finished text at send.
 *
 * ## How a post is made
 *
 * Nothing here publishes. A proposal adds an idea with source
 * `studio_league_season`, and the ordinary posting engine takes it through the
 * schedule, the agent's voice, the validator, the quality gate and the account
 * limits. `checkLeaguePostAtSend` reads the finished text once more, and reads
 * the standing again: a post whose rank is no longer Studio's current answer is
 * not sent, and Studio being unreachable is a wait, never a replay of an old rank.
 */

export const LEAGUE_IDEA_SOURCE = 'studio_league_season';

/** A skipped kind is looked at again no sooner than this, so a held gate is not asked every sweep. */
const RETRY_SKIPPED_AFTER_MS = 30 * 60_000;
/** How long after the report window closes a recap may still be written. */
const RECAP_GRACE_MS = 3 * 86_400_000;
/** A post waiting on Studio gives up after this, rather than waiting for ever. */
const SEND_PATIENCE_MS = 48 * 3_600_000;

export interface LeaguePostIdea {
  summary: string;
  detail: string;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** A label Studio published, only if it is plain words. Anything else is replaced by the season's slug. */
export function seasonLabelFor(title: string, slug: string): string {
  const plain = /^[A-Za-z0-9][A-Za-z0-9 .,'&-]{1,58}[A-Za-z0-9.]$/.test(title);
  return plain && !signalPublicationRefusal(title) && !/\d{4,}|\bwallet\b/i.test(title) ? title : slug;
}

/** The idea a kind makes from its facts. Pure; the figures in the words are the figures in the facts. */
export function leaguePostIdea(facts: LeaguePostFacts): LeaguePostIdea {
  const label = `"${facts.seasonLabel}"`;
  const closing = 'All figures are simulated paper, reported by this AI agent to AI17Z Studio.';
  const fills = facts.fillsCounted ?? 0;
  let summary: string;
  if (facts.kind === 'ENTRY') {
    summary = `This AI agent entered the paper league season ${label}. It is simulated paper trading with no real money, and its fills are reported to AI17Z Studio.`;
  } else if (facts.kind === 'STANDING') {
    summary = `Simulated paper league update for ${label}: this AI agent is rank ${facts.rank} of ${facts.field} on the league's own scoreboard, with ${fills} simulated paper ${plural(fills, 'fill', 'fills')} counted. ${closing}`;
  } else {
    const place = facts.rank === null ? 'Studio did not rank this AI agent' : `Final rank for this AI agent: ${facts.rank} of ${facts.field}`;
    const changed = facts.rank === null || facts.midwayRank === null ? ''
      : facts.rank === facts.midwayRank ? `, unchanged since the midway note`
        : `, moved from rank ${facts.midwayRank} at the midway note`;
    const notCounted = (facts.fillsNotCounted ?? 0) > 0 ? `, and ${facts.fillsNotCounted} not counted by Studio` : '';
    const receipts = (facts.receiptsPosted ?? 0) > 0 ? ` It posted ${facts.receiptsPosted} radar ${plural(facts.receiptsPosted!, 'receipt', 'receipts')} during the season.` : '';
    summary = `The simulated paper league season ${label} is over. ${place}${changed}, with ${fills} simulated paper ${plural(fills, 'fill', 'fills')} counted${notCounted}.${receipts} ${closing}`;
  }
  const detail = [
    'Say that these are simulated paper results from the AI17Z Studio paper league, and that you are an AI agent.',
    'Use only the figures above, exactly as written. Do not add to them, round them or leave out the rank and the size of the field.',
    'Never name, rank, compare with or refer to any other entrant, account or wallet. Never say beating, ahead of or behind.',
    'No percentages, returns, profit, loss, win counts, hit rates or "called it". Say nothing about what happens next, and do not call it a signal or advice.',
    'No money moved and no position is live. If a figure is missing, say nothing about it.',
  ].join('\n');
  return { summary: summary.slice(0, 500), detail };
}

// ---------------------------------------------------------------------------
// The check on the finished text
// ---------------------------------------------------------------------------

const COMPARES_OTHERS = /\b(?:beat(?:ing|en|s)?|ahead of|behind|outrank\w*|outperform\w*|overtook|overtak\w*|passed|passing|trail(?:ing|s|ed)?|leaders?|leading|top(?:ped|ping|s)? the|crush\w*|dominat\w*|champions?|rivals?|opponents?|competitors?|others?|everyone|everybody|wins?|won|winning|winners?|los(?:e|es|ing|t))\b/i;
const NAMES_ACCOUNT = /@\w|\b0x[0-9a-f]{16,}\b|\b[1-9A-HJ-NP-Za-km-z]{32,44}\b|https?:\/\//i;
const PERCENT_OR_BPS = /%|\bpercent(?:age)?\b|\bbps\b|\bbasis points?\b/i;

/** Problems with the finished text of a league post, as sentences. Empty when there are none. */
export function leaguePostTextProblems(text: string, facts: LeaguePostFacts): string[] {
  const problems: string[] = [];
  if (!/\bsimulated paper\b/i.test(text)) problems.push('It does not label the figures simulated paper.');
  const refusal = signalPublicationRefusal(text);
  if (refusal) problems.push(refusal);
  if (FORWARD_LOOKING.test(text)) problems.push('It reads as a promise, a signal or advice about what comes next.');
  if (LIVE_OR_REAL.test(text)) problems.push('It implies a live position or real money.');
  if (PERCENT_OR_BPS.test(text)) problems.push('It states a percentage or a return, which a league post never does.');
  if (NAMES_ACCOUNT.test(text)) problems.push('It names an account, a wallet or a link.');
  if (COMPARES_OTHERS.test(text)) problems.push('It compares this agent with other agents or states a win or a loss.');
  if (facts.kind !== 'ENTRY') {
    // Every rank the text states must be the one Studio gave, and the pair "x of y" must be rank and field.
    for (const m of text.matchAll(/\brank(?:ed)?\s*#?\s*(\d+)\b/gi)) {
      // A recap may also repeat the rank its own midway note stated.
      const known = Number(m[1]) === facts.rank || (facts.kind === 'RECAP' && facts.midwayRank !== null && Number(m[1]) === facts.midwayRank);
      if (!known) problems.push(`It states a rank of ${m[1]}, which is not the one Studio gave.`);
    }
    for (const m of text.matchAll(/\b(\d+)\s*(?:of|out of)\s*(\d+)\b/gi)) {
      if (facts.rank === null || facts.field === null || Number(m[1]) !== facts.rank || Number(m[2]) !== facts.field) problems.push(`It states ${m[1]} of ${m[2]}, which is not this agent's standing.`);
    }
    if (facts.rank !== null && facts.field !== null && !new RegExp(`\\b${facts.rank}\\b[^.]{0,20}\\b${facts.field}\\b`).test(text)) {
      problems.push('It leaves out the rank and the size of the field.');
    }
    if ((facts.fillsCounted ?? 0) > 0 && !new RegExp(`\\b${facts.fillsCounted}\\b`).test(text)) problems.push('It leaves out how many fills were counted.');
  }
  return [...new Set(problems)];
}

// ---------------------------------------------------------------------------
// Proposing
// ---------------------------------------------------------------------------

export interface LeagueProposalOutcome {
  proposed: LeaguePostKind | null;
  why: string;
}

interface PostRow extends Record<string, unknown> {
  id: string;
  entry_id: string;
  kind: LeaguePostKind;
  status: 'skipped' | 'proposed' | 'closed';
  reason: string;
  facts: unknown;
  idea_id: string | null;
  created_at: Date;
  updated_at: Date;
}

const KIND_ORDER: LeaguePostKind[] = ['ENTRY', 'STANDING', 'RECAP'];

/** Where in the season each kind is allowed to be said. */
export function leagueWindowOf(kind: LeaguePostKind, entry: Pick<LeagueEntryRow, 'startsAt' | 'endsAt' | 'fillsAcceptedUntil'>, now: Date): 'BEFORE' | 'OPEN' | 'PAST' {
  const starts = Date.parse(entry.startsAt);
  const ends = Date.parse(entry.endsAt);
  const mid = starts + (ends - starts) / 2;
  const t = now.getTime();
  switch (kind) {
    case 'ENTRY': return t < mid ? 'OPEN' : 'PAST';
    case 'STANDING': return t < mid ? 'BEFORE' : t < ends ? 'OPEN' : 'PAST';
    case 'RECAP': return t < ends ? 'BEFORE' : t <= Date.parse(entry.fillsAcceptedUntil) + RECAP_GRACE_MS ? 'OPEN' : 'PAST';
  }
}

async function settle(entry: LeagueEntryRow, kind: LeaguePostKind, status: 'skipped' | 'closed', reason: string): Promise<void> {
  // A spent kind is never rewritten: only a skipped row may change.
  await query(
    `INSERT INTO league_season_posts (entry_id, agent_id, kind, status, reason) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (entry_id, kind) DO UPDATE SET status = excluded.status, reason = excluded.reason, updated_at = now()
       WHERE league_season_posts.status = 'skipped'`,
    [entry.id, entry.agentId, kind, status, reason.slice(0, 300)],
  );
}

/**
 * Looks at the agent's league entry and, if one of the three posts is due and
 * allowed, puts it in the idea backlog. Called where the posting engine already
 * comes due, so the schedule still decides when anything is said.
 *
 * Every refusal is a sentence on the row, not a silence: a paused agent, quiet
 * hours, a held cadence or capacity gate, an unreachable Studio and a standing
 * not yet ranked are all `skipped` with the reason, and are looked at again.
 */
export async function proposeLeagueSeasonPosts(agentId: string, accountId: string | null, now: Date = new Date()): Promise<LeagueProposalOutcome> {
  try {
    const policy = await agentsRepo.getActivePolicy(agentId);
    if (!policy?.config.studio.postLeagueSeason) return { proposed: null, why: 'Posting the league season is off.' };
    return await withAdvisoryLock(`league-season-post:${agentId}`, () => propose(agentId, accountId, now));
  } catch (error) {
    // Narrating a season is optional; a failure must never stop the posting engine.
    log.warn('league season proposal failed', { agentId, message: errorMessage(error) });
    return { proposed: null, why: 'The league season could not be looked at just now.' };
  }
}

async function propose(agentId: string, accountId: string | null, now: Date): Promise<LeagueProposalOutcome> {
  const entry = (await leagueBridge.liveEntryOf(agentId)) ?? (await leagueBridge.latestEntryOf(agentId));
  if (!entry || !entry.remoteEntryId || (entry.status !== 'ACTIVE' && entry.status !== 'ENDED')) return { proposed: null, why: 'This agent has no active league entry.' };
  const season = parseSeason(entry.season, entry.seasonSlug);
  const label = seasonLabelFor(season.ok ? season.season.season.title : entry.seasonSlug, entry.seasonSlug);

  const rows = await query<PostRow>('SELECT * FROM league_season_posts WHERE entry_id = $1', [entry.id]);
  const rowOf = (kind: LeaguePostKind) => rows.find((r) => r.kind === kind);

  // A window that has gone by closes its kind for good, with the reason.
  for (const kind of KIND_ORDER) {
    const row = rowOf(kind);
    if (row && row.status !== 'skipped') continue;
    const expired = leagueWindowOf(kind, entry, now) === 'PAST' || (entry.status === 'ENDED' && kind !== 'RECAP');
    if (expired) await settle(entry, kind, 'closed', 'The time for this post in the season has passed.');
  }

  const due = KIND_ORDER.find((kind) => {
    const row = rowOf(kind);
    if (row && row.status !== 'skipped') return false;
    if (entry.status === 'ENDED' && kind !== 'RECAP') return false;
    return leagueWindowOf(kind, entry, now) === 'OPEN';
  });
  if (!due) return { proposed: null, why: 'No league post is due.' };

  const row = rowOf(due);
  if (row && now.getTime() - row.updated_at.getTime() < RETRY_SKIPPED_AFTER_MS) return { proposed: null, why: row.reason };

  const skip = async (reason: string): Promise<LeagueProposalOutcome> => {
    await settle(entry, due, 'skipped', reason);
    return { proposed: null, why: reason };
  };

  // The ordinary gates for an agent speaking unprompted: paused, inactive, no
  // automation, quiet hours, cadence and capacity. Whatever holds is the reason.
  if (!accountId) return skip('No account is connected for this agent to post through.');
  const held = await postingGate(agentId, accountId, now);
  if (held) return skip(held);

  let facts: LeaguePostFacts;
  if (due === 'ENTRY') {
    facts = LeaguePostFacts.parse({ kind: 'ENTRY', seasonSlug: entry.seasonSlug, seasonLabel: label, rank: null, field: null, fillsCounted: null, fillsNotCounted: null, receiptsPosted: null, midwayRank: null, standingAt: null });
  } else {
    const read = await readLeagueStanding(agentId, now);
    if (!read.ok) return skip(`Studio is unavailable, so no rank was stated. ${read.why}`);
    const doc = read.standing;
    const s = doc.standing;
    if (doc.season_status === 'CANCELLED') {
      await settle(entry, due, 'closed', 'Studio cancelled the season.');
      return { proposed: null, why: 'Studio cancelled the season.' };
    }
    if (due === 'STANDING') {
      if (doc.season_status !== 'RUNNING') return skip('Studio does not list the season as running.');
      if (s.state !== 'RANKED' || s.rank === null || s.of === null) return skip('Studio has not ranked this entry yet.');
      if (s.fills_counted < 1) return skip('Studio has not counted a fill for this entry yet.');
    } else if (doc.season_status !== 'FINALIZED') {
      return skip('Studio has not finalised the season yet.');
    }
    const ranked = s.state === 'RANKED' && s.rank !== null && s.of !== null;
    if (due === 'RECAP' && !ranked && s.state !== 'UNRANKED') return skip('Studio has not given a final standing for this entry.');
    let notCounted: number | null = null;
    let receipts: number | null = null;
    let midwayRank: number | null = null;
    if (due === 'RECAP') {
      const local = await leagueBridge.fillCounts(entry.id);
      notCounted = local.REJECTED + local.LOCAL_ONLY;
      const [count] = await query<{ n: number }>(
        `SELECT count(*)::int AS n FROM actions a JOIN jobs j ON j.id = a.job_id JOIN events e ON e.id = j.event_id
          WHERE a.agent_id = $1 AND a.type = 'POST' AND a.status = 'EXECUTED' AND NOT a.dry_run AND a.channel <> 'mock'
            AND e.payload->>'ideaSource' = 'radar_receipt' AND a.executed_at >= $2 AND a.executed_at <= $3`,
        [agentId, entry.startsAt, entry.endsAt],
      );
      receipts = count?.n ?? 0;
      const midway = LeaguePostFacts.safeParse(rowOf('STANDING')?.status === 'proposed' ? rowOf('STANDING')?.facts : null);
      midwayRank = midway.success ? midway.data.rank : null;
    }
    facts = LeaguePostFacts.parse({
      kind: due, seasonSlug: entry.seasonSlug, seasonLabel: label,
      rank: ranked ? s.rank : null, field: ranked ? s.of : null, fillsCounted: s.fills_counted,
      fillsNotCounted: notCounted, receiptsPosted: receipts, midwayRank, standingAt: doc.generated_at,
    });
  }

  const idea = leaguePostIdea(facts);
  const problems = leaguePostTextProblems(idea.summary, facts);
  if (problems.length > 0) return skip(`The post could not be written within the rules: ${problems.join(' ')}`);
  // The one gate on an agent choosing its own subject, as for any idea.
  const reticent = unpromptedSubject(idea.summary);
  if (reticent) {
    await settle(entry, due, 'closed', `Not raised unprompted: ${reticent.subject}.`);
    return { proposed: null, why: `Not raised unprompted: ${reticent.subject}.` };
  }

  await withTransaction(async (tx) => {
    const added = await tx.one<{ id: string }>(
      `INSERT INTO content_ideas (agent_id, kind, summary, detail, source, score) VALUES ($1,'observation',$2,$3,$4,62) RETURNING id`,
      [agentId, idea.summary, idea.detail, LEAGUE_IDEA_SOURCE],
    );
    await tx.query(
      `INSERT INTO league_season_posts (entry_id, agent_id, kind, status, reason, facts, idea_id) VALUES ($1,$2,$3,'proposed','Added to the idea backlog.',$4::jsonb,$5)
       ON CONFLICT (entry_id, kind) DO UPDATE SET status = 'proposed', reason = excluded.reason, facts = excluded.facts, idea_id = excluded.idea_id, updated_at = now()
         WHERE league_season_posts.status = 'skipped'`,
      [entry.id, agentId, due, JSON.stringify(facts), added!.id],
    );
  });
  log.info('league season post proposed', { agentId, kind: due, seasonSlug: entry.seasonSlug });
  return { proposed: due, why: `The ${due.toLowerCase()} post was added to the idea backlog.` };
}

// ---------------------------------------------------------------------------
// The check at send
// ---------------------------------------------------------------------------

/**
 * The last word on a league post, at the moment of sending.
 *
 * The owner may have switched the posts off, the entry may have ended, and
 * Studio's standing may have moved since the idea was made. So the policy is
 * read again, the finished text (including text an owner edited in review) is
 * held to the rules above, and the standing is asked for again: the post is
 * sent only if it still says Studio's current answer.
 */
export async function checkLeaguePostAtSend(input: { raw: unknown; text: string; policy: PolicyConfig; now?: Date }): Promise<void> {
  const raw = (input.raw ?? {}) as { ideaSource?: unknown; ideaId?: unknown };
  if (raw.ideaSource !== LEAGUE_IDEA_SOURCE) return;
  const now = input.now ?? new Date();

  if (!input.policy.studio.postLeagueSeason) {
    throw PipelineError.permanent('league_posting_off', 'Posting the league season was switched off after this post was written, so it was not sent.');
  }
  const [row] = typeof raw.ideaId === 'string'
    ? await query<PostRow>('SELECT * FROM league_season_posts WHERE idea_id = $1', [raw.ideaId])
    : [];
  const parsed = LeaguePostFacts.safeParse(row?.facts);
  if (!row || !parsed.success) throw PipelineError.permanent('league_post_missing', 'The league post this was written for is no longer on record, so it was not sent.');
  const facts = parsed.data;

  const problems = leaguePostTextProblems(input.text, facts);
  if (problems.length > 0) throw PipelineError.review('league_post_text', `This league post needs the owner: ${problems.join(' ')}`);

  const entry = await leagueBridge.getEntry(row.entry_id);
  const live = entry && (entry.status === 'ACTIVE' || (facts.kind === 'RECAP' && entry.status === 'ENDED'));
  if (!entry || !live) throw PipelineError.permanent('league_entry_ended', 'The league entry this post is about is no longer active, so it was not sent.');
  if (facts.kind === 'ENTRY') return;

  if (now.getTime() - row.updated_at.getTime() > SEND_PATIENCE_MS) {
    throw PipelineError.permanent('league_post_stale', 'This league post waited too long for Studio to confirm the standing, so it was not sent.');
  }
  const read = await readLeagueStanding(entry.agentId, now);
  if (!read.ok) {
    // Never a stale rank: wait for Studio rather than say the last one again.
    throw PipelineError.retryable('league_unavailable', `Studio could not confirm the standing, so no rank was sent. ${read.why}`, { retryAfterMs: 15 * 60_000 });
  }
  const s = read.standing.standing;
  const wantStatus = facts.kind === 'STANDING' ? 'RUNNING' : 'FINALIZED';
  const same = read.standing.season_status === wantStatus
    && (s.state === 'RANKED' ? s.rank : null) === facts.rank
    && (s.state === 'RANKED' ? s.of : null) === facts.field
    && s.fills_counted === facts.fillsCounted;
  if (!same) {
    // Spent kinds are not reopened by anything else, so release this one for a fresh look.
    await query(`UPDATE league_season_posts SET status = 'skipped', reason = $2, updated_at = now() WHERE id = $1 AND status = 'proposed'`,
      [row.id, 'The standing changed before the post was sent, so it was not sent; it will be looked at again.']);
    throw PipelineError.permanent('league_standing_changed', "The standing is no longer the one this post states, so it was not sent. It will be written again from Studio's current answer.");
  }
}
