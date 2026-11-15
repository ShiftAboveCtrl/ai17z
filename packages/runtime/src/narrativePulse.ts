import { PipelineError, createLogger, errorMessage, sha256Hex } from '@xbam/shared';
import {
  NarrativeTermContribution, NARRATIVE_PULSE_MAX_TERMS, NARRATIVE_PULSE_WINDOW_MS, type CheckBoardRow, type PolicyConfig,
} from '@xbam/shared/contracts';
import {
  agents as agentsRepo, content as contentRepo, narrativePulseRepo, ops, relationships as relationshipsRepo,
} from '@xbam/database';
import { checkReadCapacity } from './capacity';
import { narrativeWorkFor } from './growth';
import {
  NARRATIVE_MIN_AUTHORS, NARRATIVE_MIN_RECENT_POSTS, NARRATIVE_RISING_LIFT, termsIn, type Narrative, type NarrativePost,
} from './narratives';
import { unpromptedSubject } from './reticence';
import { coordinationSignals, type SuppliedPost } from './socialSignals';
import { ADDRESS_PATTERN, ADVICE_WORDS, digestRows } from './studioCheckBoard';
import { FORWARD_LOOKING } from './studioPaperVoice';
import { readNarrativePulseChecks, sendNarrativeTerms } from './studioNarrativePulse';

const log = createLogger('narrative-pulse');

/**
 * "Talked about against checked": one daily original post about what the accounts this
 * agent reads kept repeating, set beside what people asked Studio to check.
 *
 * It spends no read of X. The only posts it looks at are rows the radar stored for its
 * own work (`narrativeWorkFor`), the subjects come from `readNarratives` and nothing
 * else, and a post is never quoted: a subject is a word the posts shared, never a
 * sentence anybody wrote. Two owner switches, both off by default:
 * `studio.postNarrativePulse` (say it) and `studio.contributeNarrativeTerms` (send Studio
 * the terms, shares and author counts, never an author).
 *
 * ## What it refuses
 *
 * - A subject below the distinct-author floor (`narratives.ts`), because one account
 *   repeating itself is not a narrative.
 * - A subject `reticence.ts` will not raise unprompted, or that looks like a person.
 * - A subject whose posts fit a coordination pattern. It is left out and the idea says
 *   that something was, without naming it, because naming it would carry it further.
 * - "Rising" without a before. A subject is called rising only when an earlier snapshot
 *   measured it. One absent from the snapshot was below the floor then, which is not a
 *   measured zero, so it is "present", never "up from nothing".
 * - Ranking by anything but share. Rows are ordered by share of posts with their sample
 *   size beside them, and nothing here says which subject, or which token, is better.
 */

/** The `content_ideas.source` and the event's `ideaSource`. */
export const NARRATIVE_PULSE_IDEA_SOURCE = 'narrative_pulse';

/** Fewer than this and a post about "what people are talking about" is about one word. */
export const PULSE_MIN_ROWS = 2;
export const PULSE_MAX_ROWS = 4;
const SNAPSHOT_TERMS = 40;
const CHECK_EVERY_MS = 3 * 3_600_000;
/** An earlier snapshot older than this is not a before worth comparing with. */
const MAX_BEFORE_HOURS = 48;

export const SAYS_NOT_ENDORSED_PULSE =
  'Talked about is not endorsed, checked is not endorsed: this counts words and requests, not what is good.';
export const CHECKS_NOT_READ = 'The checks half was not read.';

// ---------------------------------------------------------------------------
// Dropping what may not be published
// ---------------------------------------------------------------------------

export type DropReason = 'reticence' | 'person' | 'coordination';
export interface DroppedTerm { term: string; reason: DropReason; sentence: string }

const PHRASE = /(?<![\p{L}\p{N}])\p{Lu}[\p{Ll}'’-]{2,}(?:\s+\p{Lu}[\p{Ll}'’-]{2,})+/gu;

/**
 * Words that appear inside a run of capitalised words, such as "Elon Musk". A run at
 * the start of a sentence needs three words, because "Great Bitcoin day" starts with a
 * capital for no reason of its own. This leans towards dropping: a wrongly dropped
 * subject costs one line nobody misses, a person named in an unprompted post costs more.
 */
function namedPhraseWords(text: string): Set<string> {
  const cleaned = text.replace(/https?:\/\/\S+/g, ' ').replace(/@[A-Za-z0-9_]{1,15}/g, ' ');
  const words = new Set<string>();
  for (const match of cleaned.matchAll(PHRASE)) {
    const run = match[0].split(/\s+/);
    const before = cleaned.slice(0, match.index).trimEnd();
    const startsSentence = before === '' || /[.!?]$/.test(before);
    if (startsSentence && run.length < 3) continue;
    for (const raw of run) words.add(raw.toLowerCase().replace(/['’]s$/, ''));
  }
  return words;
}

function postsWith(term: string, posts: readonly NarrativePost[]): NarrativePost[] {
  return posts.filter((post) => termsIn(post.text).includes(term));
}

/** Why a subject looks like a person, or null. */
export function personReason(term: string, posts: readonly NarrativePost[], handles: ReadonlySet<string>): string | null {
  const bare = term.replace(/^[$#]/, '');
  if (handles.has(bare)) return 'it is the name of an account the agent read';
  if (/^[$#]/.test(term)) return null;
  const mine = postsWith(term, posts);
  if (mine.length < 3) return null;
  const named = mine.filter((post) => namedPhraseWords(post.text).has(term)).length;
  return named / mine.length >= 0.5 ? 'it mostly appears as part of a capitalised name' : null;
}

/** Why a subject's posts fit a coordination pattern, or null. */
export function coordinationReason(term: string, posts: readonly NarrativePost[]): string | null {
  const supplied: SuppliedPost[] = [];
  for (const post of postsWith(term, posts)) {
    const authorId = post.authorId || post.handle.replace(/^@+/, '').toLowerCase();
    if (!authorId || !post.postedAt) continue;
    supplied.push({ id: post.statusId, authorId, text: post.text, createdAt: post.postedAt });
  }
  if (supplied.length === 0) return null;
  const { signals } = coordinationSignals(supplied);
  return signals[0]?.sentence ?? null;
}

/**
 * The subjects that may be published, and the ones that may not with a sentence each.
 * `recent` is the window's posts: the same ones the narratives were read from.
 */
export function filterPulseNarratives(
  narratives: readonly Narrative[],
  input: { recent: readonly NarrativePost[]; handles: ReadonlySet<string> },
): { kept: Narrative[]; dropped: DroppedTerm[] } {
  const kept: Narrative[] = [];
  const dropped: DroppedTerm[] = [];
  for (const narrative of narratives) {
    const bare = narrative.term.replace(/^[$#]/, '');
    const reticent = unpromptedSubject(bare);
    if (reticent) {
      dropped.push({ term: narrative.term, reason: 'reticence', sentence: `Not raised unprompted: ${reticent.subject}.` });
      continue;
    }
    const person = personReason(narrative.term, input.recent, input.handles);
    if (person) {
      dropped.push({ term: narrative.term, reason: 'person', sentence: `Left out because ${person}.` });
      continue;
    }
    const coordinated = coordinationReason(narrative.term, input.recent);
    if (coordinated) {
      dropped.push({ term: narrative.term, reason: 'coordination', sentence: `Left out: ${coordinated} Signals in the posts read, not a finding about anybody.` });
      continue;
    }
    kept.push(narrative);
  }
  return { kept, dropped };
}

// ---------------------------------------------------------------------------
// Present or rising
// ---------------------------------------------------------------------------

export interface PulseBefore { windowEnd: string; terms: ReadonlyMap<string, { share: number }> }

export type PulseRow = {
  term: string;
  share: number;
  authors: number;
  rise: { kind: 'present' } | { kind: 'rising'; priorShare: number };
};

/**
 * Rising only when an earlier snapshot measured the subject and its share has moved by
 * the same factor `narratives.ts` calls rising. No snapshot, or a subject the snapshot
 * did not carry, is "present". Ordered by share and by nothing else.
 */
export function classifyRows(kept: readonly Narrative[], before: PulseBefore | null): PulseRow[] {
  const rows: PulseRow[] = kept.map((n) => {
    const prior = before?.terms.get(n.term);
    const rising = prior !== undefined && prior.share > 0 && n.share / prior.share >= NARRATIVE_RISING_LIFT;
    return {
      term: n.term,
      share: n.share,
      authors: n.authors,
      rise: rising ? { kind: 'rising' as const, priorShare: prior.share } : { kind: 'present' as const },
    };
  });
  return rows.sort((a, b) => b.share - a.share || a.term.localeCompare(b.term));
}

// ---------------------------------------------------------------------------
// The idea
// ---------------------------------------------------------------------------

export type ChecksHalf = { read: true; rows: CheckBoardRow[]; windowHours: number } | { read: false; why: string };

const pct = (share: number): string => `${(share * 100).toFixed(1)}%`;

export interface PulseIdea { key: string; summary: string; detail: string }

/**
 * The idea, or null when the narrative half is below the floor. The checks half is
 * optional: Studio unreachable gives the narrative half alone and says so.
 */
export function narrativePulseIdea(input: {
  rows: readonly PulseRow[];
  windowHours: number;
  windowEnd: Date;
  checks: ChecksHalf;
  dropped: readonly DroppedTerm[];
  hasBefore: boolean;
}): PulseIdea | null {
  const rows = input.rows.slice(0, PULSE_MAX_ROWS);
  if (rows.length < PULSE_MIN_ROWS) return null;

  const talked = rows.map((r) =>
    `${r.term} ${pct(r.share)} of posts (n = ${r.authors} authors, ${r.rise.kind === 'rising' ? `rising, was ${pct(r.rise.priorShare)}` : 'present'})`);
  const checks = input.checks.read
    ? input.checks.rows.length === 0
      ? 'No token had enough distinct askers to be listed.'
      : `Checked on AI17Z Studio in the last ${input.checks.windowHours} hours, in order of askers: ${input.checks.rows
          .map((row) => `${row.mint} (${row.chain}) ${row.askers} askers`).join('; ')}.`
    : CHECKS_NOT_READ;
  const summary = [
    `Talked about and checked, last ${input.windowHours} hours.`,
    SAYS_NOT_ENDORSED_PULSE,
    `Talked about, by share of the posts this agent read: ${talked.join('; ')}.`,
    checks,
  ].join(' ').slice(0, 500);

  const coordinated = input.dropped.filter((d) => d.reason === 'coordination').length;
  const detail = [
    'Facts, ordered by share of posts and by nothing else. The order says how much of what was read used a word, never that the word or any token is good.',
    `Sample: posts the agent read in the last ${input.windowHours} hours; every row carries the number of distinct accounts behind it.`,
    ...rows.map((r) => `${r.term}: ${pct(r.share)} of posts, n = ${r.authors} distinct authors, ${r.rise.kind === 'rising'
      ? `rising, up from ${pct(r.rise.priorShare)} in an earlier reading`
      : 'present, with no earlier reading to call it rising'}.`),
    input.hasBefore ? '' : 'No earlier reading existed, so nothing here is called rising.',
    coordinated > 0 ? `${coordinated} subject${coordinated === 1 ? ' was' : 's were'} left out because the posts about ${coordinated === 1 ? 'it' : 'them'} used near-identical wording. Say that something was left out and name nothing.` : '',
    input.checks.read ? '' : 'Studio could not be read, so say plainly that the checks half was not read and name no token.',
    'Say talked about and checked are not endorsed. No advice, no prediction, no verdict. Use only the terms and addresses above, quote no post and name no account or person.',
  ].filter(Boolean).join('\n');

  const key = `${input.windowEnd.toISOString().slice(0, 10)}:${sha256Hex(rows.map((r) => `${r.term}|${r.share}`).join(','))}`;
  return { key, summary, detail };
}

// ---------------------------------------------------------------------------
// The check on the finished text
// ---------------------------------------------------------------------------

const VALUE_WORDS = /\b(trending|hottest|viral|leaderboard|ranked|ranking|top (pick|narrative|token)s?)\b/i;
const RISE_WORDS = /\b(rising|rose|surg\w*|spik\w*|up from|exploding|taking off)\b/i;
const ORIGIN_WORDS = /\b(from zero|out of nowhere|from nothing)\b/i;
const NOT_ENDORSED = /not\s+endorsed/i;
const TAGGED = /[$#][\p{L}\p{N}]+/gu;

/** Problems with the finished text, as sentences. `facts` is the idea summary the text came from. */
export function checkNarrativePulseText(text: string, facts: string): string[] {
  const problems: string[] = [];
  if (!NOT_ENDORSED.test(text)) problems.push('It does not say what was talked about and checked is not endorsed.');
  const framing = text.replace(/not\s+endorsed/gi, '').replace(/\b(checked|talked about)\b/gi, '');
  const advice = ADVICE_WORDS.exec(framing);
  if (advice) problems.push(`It reads as advice or a verdict ("${advice[0]}").`);
  if (FORWARD_LOOKING.test(text)) problems.push('It reads as a promise, a signal or advice about what comes next.');
  if (VALUE_WORDS.test(text)) problems.push('It ranks by something other than share of posts.');
  if (ORIGIN_WORDS.test(text)) problems.push('It says something rose from nothing, which was not measured.');
  if (RISE_WORDS.test(text) && !/rising, was/.test(facts)) problems.push('It says something is rising, and nothing earlier was read to compare with.');
  const known = new Set((facts.match(ADDRESS_PATTERN) ?? []).map((a) => a.toLowerCase()));
  if ((text.match(ADDRESS_PATTERN) ?? []).some((a) => !known.has(a.toLowerCase()))) problems.push('It names an address that is not in the facts.');
  const tags = new Set((facts.toLowerCase().match(TAGGED) ?? []));
  if ((text.toLowerCase().match(TAGGED) ?? []).some((t) => !tags.has(t))) problems.push('It names a tag that is not in the facts.');
  if (/@[A-Za-z0-9_]{1,15}\b/.test(text)) problems.push('It names an account.');
  if (facts.includes(CHECKS_NOT_READ) && !/not read/i.test(text)) problems.push('It does not say the checks half was not read.');
  return problems;
}

/**
 * The last word, at the moment of sending: the owner may have switched posting off since
 * the idea was made, the text may have been edited in review, and when it names a token
 * the board it came from is read again. A narrative-only post needs no Studio.
 */
export async function checkNarrativePulseAtSend(input: { raw: unknown; text: string; policy: PolicyConfig; now?: Date }): Promise<void> {
  const raw = (input.raw ?? {}) as { ideaSource?: unknown; ideaSummary?: unknown };
  if (raw.ideaSource !== NARRATIVE_PULSE_IDEA_SOURCE) return;
  if (!input.policy.studio.postNarrativePulse) {
    throw PipelineError.permanent('narrative_pulse_posting_off', 'Posting the narrative pulse was switched off after this post was written, so it was not sent.');
  }
  const problems = checkNarrativePulseText(input.text, typeof raw.ideaSummary === 'string' ? raw.ideaSummary : '');
  if (problems.length > 0) throw PipelineError.review('narrative_pulse_text', `This narrative pulse post needs the owner: ${problems.join(' ')}`);
  const named = input.text.match(ADDRESS_PATTERN) ?? [];
  if (named.length === 0) return;
  const read = await readNarrativePulseChecks(input.now);
  if (!read.ok) throw PipelineError.retryable('narrative_pulse_studio_unreachable', `Nothing was posted: ${read.why}`, { retryAfterMs: 15 * 60_000 });
  const listed = new Set(digestRows(read.checks).map((row) => row.mint.toLowerCase()));
  if (named.some((a) => !listed.has(a.toLowerCase()))) {
    throw PipelineError.review('narrative_pulse_changed', 'Studio no longer lists a token this post names. Generate a fresh post.');
  }
}

// ---------------------------------------------------------------------------
// Proposing it
// ---------------------------------------------------------------------------

interface PulseMemo { checkedAt: string; proposedDay: string | null; contributedDay: string | null }
const memoKey = (agentId: string) => `studio.narrative_pulse.${agentId}`;

export interface PulseOutcome { proposed: boolean; contributed: boolean; why: string }

/** How many posts in the window could be placed, the sample every share is a share of. */
function postsInWindow(posts: readonly NarrativePost[], now: Date, windowHours: number): number {
  let n = 0;
  for (const post of posts) {
    if (!post.postedAt) continue;
    const age = (now.getTime() - Date.parse(post.postedAt)) / 3_600_000;
    if (Number.isFinite(age) && age >= 0 && age <= windowHours) n += 1;
  }
  return n;
}

function recentPosts(posts: readonly NarrativePost[], now: Date, windowHours: number): NarrativePost[] {
  return posts.filter((post) => {
    if (!post.postedAt) return false;
    const age = (now.getTime() - Date.parse(post.postedAt)) / 3_600_000;
    return Number.isFinite(age) && age >= 0 && age <= windowHours;
  });
}

/**
 * Called when the posting schedule comes due. Adds at most one idea per UTC day, only for
 * an opted-in agent, and only when the narrative half clears the floor. The idea backlog
 * and the posting engine still decide whether and when it is said.
 */
export async function proposeNarrativePulse(agentId: string, accountId: string, now: Date = new Date()): Promise<PulseOutcome> {
  const none = (why: string): PulseOutcome => ({ proposed: false, contributed: false, why });
  try {
    const policy = await agentsRepo.getActivePolicy(agentId);
    const wantsPost = policy?.config.studio?.postNarrativePulse === true;
    const wantsContribute = policy?.config.studio?.contributeNarrativeTerms === true;
    if (!wantsPost && !wantsContribute) return none('The narrative pulse is off.');

    const today = now.toISOString().slice(0, 10);
    const memo = await ops.getSetting<PulseMemo>(memoKey(agentId));
    const postDone = !wantsPost || memo?.proposedDay === today;
    const sendDone = !wantsContribute || memo?.contributedDay === today;
    if (postDone && sendDone) return none('Already done today.');
    if (memo && now.getTime() - Date.parse(memo.checkedAt) < CHECK_EVERY_MS) return none('The pulse was looked at recently.');
    const remember = (patch: Partial<PulseMemo>) => ops.setSetting(memoKey(agentId), {
      checkedAt: now.toISOString(), proposedDay: memo?.proposedDay ?? null, contributedDay: memo?.contributedDay ?? null, ...patch,
    } satisfies PulseMemo);

    // This reads nothing. The gate is for the account's sake: when the breaker is holding
    // reads back, the account is under pressure and a post about what it read waits.
    const capacity = await checkReadCapacity(accountId, 'BROAD', now);
    if (!capacity.allowed) { await remember({}); return none(`Nothing was made: ${capacity.message}`); }

    const work = await narrativeWorkFor(accountId, { now, limit: SNAPSHOT_TERMS });
    const recent = recentPosts(work.posts, now, work.windowHours);
    if (work.reading.narratives.length === 0) {
      await remember({});
      return none(work.reading.gaps[0] ?? 'No subject was shared by enough distinct accounts.');
    }

    const handles = new Set<string>(recent.map((p) => p.handle.replace(/^@+/, '').toLowerCase()).filter(Boolean));
    for (const person of await relationshipsRepo.listForAgent(agentId, { limit: 200 })) handles.add(person.handle.replace(/^@+/, '').toLowerCase());
    const { kept, dropped } = filterPulseNarratives(work.reading.narratives, { recent, handles });

    const snapshot = await narrativePulseRepo.latestBefore(agentId, now, work.windowHours, MAX_BEFORE_HOURS);
    const rows = classifyRows(kept, snapshot);
    // The next pulse's before: what cleared every refusal here, with its share and count.
    const sample = postsInWindow(work.posts, now, work.windowHours);
    if (sample >= NARRATIVE_MIN_RECENT_POSTS) {
      await narrativePulseRepo.saveSnapshot({
        agentId, windowEnd: now, posts: sample,
        terms: rows.filter((r) => r.share > 0 && r.authors >= NARRATIVE_MIN_AUTHORS).map((r) => ({ term: r.term, share: r.share, authors: r.authors })),
      });
    }

    let contributed = false;
    if (wantsContribute && memo?.contributedDay !== today && rows.length > 0) {
      const windowEnd = new Date(Math.floor(now.getTime() / NARRATIVE_PULSE_WINDOW_MS) * NARRATIVE_PULSE_WINDOW_MS).toISOString();
      const terms = rows.slice(0, NARRATIVE_PULSE_MAX_TERMS)
        .map((r) => NarrativeTermContribution.safeParse({ term: r.term, share: r.share, distinctAuthors: r.authors, windowEnd }))
        .flatMap((parsed) => (parsed.success ? [parsed.data] : []));
      // Consent is read again immediately before sending: an owner who just switched it off is obeyed.
      const still = (await agentsRepo.getActivePolicy(agentId))?.config.studio?.contributeNarrativeTerms === true;
      if (still && terms.length > 0) {
        const sent = await sendNarrativeTerms(terms);
        contributed = sent.ok;
        if (sent.ok) await remember({ contributedDay: today });
      }
    }

    if (!wantsPost || memo?.proposedDay === today) {
      if (!contributed) await remember({});
      return { proposed: false, contributed, why: contributed ? 'The terms were sent to Studio.' : 'Nothing was sent.' };
    }

    // Studio is asked for the checks half only after the narrative half clears the floor.
    if (rows.length < PULSE_MIN_ROWS) {
      await remember(contributed ? { contributedDay: today } : {});
      return { proposed: false, contributed, why: 'Too few subjects were shared by enough distinct accounts to make a post.' };
    }
    const read = await readNarrativePulseChecks(now);
    const checks: ChecksHalf = read.ok
      ? { read: true, rows: digestRows(read.checks), windowHours: read.checks.window_hours }
      : { read: false, why: read.why };
    const idea = narrativePulseIdea({ rows, windowHours: work.windowHours, windowEnd: now, checks, dropped, hasBefore: snapshot !== null });
    if (!idea) { await remember(contributed ? { contributedDay: today } : {}); return { proposed: false, contributed, why: 'The narrative half is below the floor.' }; }

    const reticent = unpromptedSubject(idea.summary);
    if (reticent) {
      await remember({ proposedDay: today, ...(contributed ? { contributedDay: today } : {}) });
      return { proposed: false, contributed, why: `Not raised unprompted: ${reticent.subject}.` };
    }
    if (await contentRepo.similarExists(agentId, idea.summary)) {
      await remember({ proposedDay: today, ...(contributed ? { contributedDay: today } : {}) });
      return { proposed: false, contributed, why: 'The backlog already holds this.' };
    }
    await contentRepo.addIdea({
      agentId, kind: 'observation', summary: idea.summary, detail: idea.detail,
      source: NARRATIVE_PULSE_IDEA_SOURCE, sourceHandle: null, sourceJobId: null, score: 45,
    });
    await remember({ proposedDay: today, ...(contributed ? { contributedDay: today } : {}) });
    return {
      proposed: true, contributed,
      why: read.ok ? 'The narrative pulse was added to the idea backlog.' : 'The narrative half was added to the idea backlog; the checks half was not read.',
    };
  } catch (error) {
    // Optional; a failure here must never stop the posting engine doing everything else.
    log.warn('narrative pulse failed', { agentId, message: errorMessage(error) });
    return none('The narrative pulse could not be made just now.');
  }
}
