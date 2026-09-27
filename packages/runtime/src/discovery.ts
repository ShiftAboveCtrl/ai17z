import type { RadarCandidate } from '@xbam/shared/contracts';
import { PolicyConfig } from '@xbam/shared/contracts';
import {
  accounts as accountsRepo,
  agents as agentsRepo,
  events as eventsRepo,
  query,
  targets as targetsRepo,
  type RadarSourceRow,
} from '@xbam/database';
import { growthGateFor } from './growthGate';
import { unpromptedSubject } from './reticence';
import { readPromo } from './promo';
import { activePreferences, variantFor } from './learning';

/**
 * An agent going looking on its own.
 *
 * Before this, every candidate an agent ever had arrived because somebody
 * mentioned it, replied to it, posted from an account the owner had typed in,
 * or matched a search the owner had written. Measured on a live agent over two
 * days: every public reply it made traced back to one of those, and its growth
 * sessions opened, found nothing, and closed. Growth was a function of how
 * often it was mentioned, which is the opposite of growth.
 *
 * So the agent now searches for itself, from what it is actually about: its
 * persona's topics, or terms its owner pinned. The discipline is
 * the whole design, because a keyword firehose is how the same agent spent an
 * afternoon replying to posts that matched a word and meant nothing:
 *
 * - X's own `min_faves` filter, so only posts people are already responding to
 *   are returned at all. The engagement floor is applied by X, for free.
 * - English, original posts only: no replies, no reposts.
 * - One search per growth session, rotating through the terms, so a session
 *   costs one read of broad capacity rather than one per interest.
 * - Ranked by the author's audience and the post's engagement before anything
 *   is ingested, and only the best few are kept. Observe many, think about few.
 * - Never a subject the reticence gate forbids the agent to raise unasked.
 *
 * Everything after that is the ordinary path: the cheap triage, the outreach
 * budget, the account's X capacity, the engagement decision, the voice.
 */

/**
 * Parts of a persona that are about the agent's own life, not places to find
 * strangers.
 *
 * A persona that mentions faith, family or health is describing who it is.
 * Searching X for other people's posts about those to approach them unasked is
 * the same act the reticence gate refuses for an original post, reached from
 * the other side, and a match on "family" is a stranger's personal news.
 */
const PERSONAL = /\b(god|faith|prayer|church|family|health|gratitude|friends?)\b/i;

/** A search term worth running: specific enough that a match means something. */
function specific(term: string): boolean {
  const trimmed = term.trim();
  if (trimmed.length < 3 || trimmed.length > 60) return false;
  // A cashtag, a proper noun, or a product name. "builders" and "gratitude"
  // match half of X and say nothing about why this agent would be there.
  return /\$[A-Za-z]{2,}|[A-Z]|\d/.test(trimmed);
}

/**
 * The terms this agent searches, in order.
 *
 * Terms an owner pinned on the source come first and are used alone when
 * present: an owner who wrote them meant exactly those. Otherwise the persona's
 * specific topics. Not the attention working set: its items are fingerprinted
 * posts, and a sentence somebody wrote is not a search term. Anything the
 * reticence gate would stop it raising unasked is dropped, and duplicates
 * collapse.
 */
export function discoveryTerms(input: { pinned?: string[] | undefined; topics: string[] }): string[] {
  const pool = input.pinned && input.pinned.length > 0 ? input.pinned : input.topics;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of pool) {
    const term = raw.trim();
    const key = term.toLowerCase();
    if (!term || seen.has(key)) continue;
    if (!(input.pinned && input.pinned.length > 0) && !specific(term)) continue;
    if (unpromptedSubject(term)) continue;
    if (!(input.pinned && input.pinned.length > 0) && PERSONAL.test(term)) continue;
    seen.add(key);
    out.push(term);
  }
  return out;
}

/** The X search for one term. A cashtag goes bare, a phrase goes quoted. */
export function discoveryQuery(term: string, minFaves: number, withinMinutes?: number): string {
  const trimmed = term.trim();
  const phrase = /^\$[A-Za-z0-9]+$/.test(trimmed) || /["()]|\bOR\b|:/.test(trimmed) ? trimmed : `"${trimmed}"`;
  // A query that names its own floor keeps it: an owner who wrote min_faves:40
  // for one term and relied on the default for another meant both.
  const floor = minFaves > 0 && !/min_faves:/i.test(trimmed) ? ` min_faves:${minFaves}` : '';
  /*
    Only what can still be answered. Filtering afterwards spent the page on
    old posts: measured on a live agent, 8 to 10 of every 20 results were past
    the freshness window, so a session approached one post where it could have
    approached three. A query that names its own time bound keeps it.
  */
  const fresh =
    withinMinutes && withinMinutes > 0 && !/\b(within_time|since|since_time):/i.test(trimmed)
      ? ` within_time:${withinMinutes >= 60 && withinMinutes % 60 === 0 ? `${withinMinutes / 60}h` : `${withinMinutes}m`}`
      : '';
  return `${phrase}${floor}${fresh} lang:en -filter:replies -filter:retweets`;
}

/** What the discovery ranker knows beyond the post itself. */
export interface RankContext {
  /** The agent's specific topics, the same list its searches come from. */
  topics: string[];
  /** Authors it approached unasked in the last week, lowercased. */
  contactedRecently?: string[];
  /** Authors who have written to it lately, lowercased. */
  engagedWithUs?: string[];
  /**
   * The audience size this agent has learned does best, when it has one and
   * this session applies it. A lean among posts that already passed every
   * rule, never a way past one. See learning.ts.
   */
  preferAudience?: 'SMALL' | 'MID' | 'LARGE' | null;
}

export interface DiscoveryScore {
  score: number;
  factors: { label: string; delta: number }[];
}

const round = (n: number) => Math.round(n * 10) / 10;

/**
 * How worth a closer look one discovered post is, and why.
 *
 * The first version ranked on audience and engagement alone, and on a live
 * agent that put a 1.6-million-follower account flexing old calls and a
 * 1.3-million one pitching a token at the top of the list, above a
 * 55-thousand-follower account with a real thesis about the agent's own
 * subject. So audience is one term among several and not the largest:
 *
 * - naming the agent's own topics matters most, because a big account talking
 *   about something else is not a conversation the agent belongs in;
 * - audience and traction are log-scaled, so a million is not a thousand times
 *   a thousand, and a count X did not report adds nothing;
 * - a pitch is marked down hard, and somebody approached this week is marked
 *   down, while somebody who has written to the agent is marked up.
 *
 * Every term carries a label, and the labels travel with the candidate, so
 * "why did it pick that post" has an answer on the event itself.
 */
export function scoreDiscovered(candidate: RadarCandidate, context?: RankContext): DiscoveryScore {
  const factors: DiscoveryScore['factors'] = [];
  let score = 0;
  const add = (label: string, delta: number) => {
    const d = round(delta);
    if (d === 0) return;
    factors.push({ label, delta: d });
    score += d;
  };

  const raw = candidate.raw as { author?: { followers?: unknown }; metrics?: Record<string, unknown> };
  const text = candidate.text ?? '';
  const lower = text.toLowerCase();

  if (context) {
    const hits = context.topics.filter((topic) => lower.includes(topic.toLowerCase()));
    if (hits.length >= 2) add(`names ${hits.slice(0, 3).join(', ')}`, 3);
    else if (hits.length === 1) add(`names ${hits[0]}`, 2);
    else add('names none of its topics outright', -2);
  }

  const followers = typeof raw.author?.followers === 'number' ? raw.author.followers : null;
  if (followers !== null) add(`${followers.toLocaleString('en-US')} followers`, Math.log10(followers + 1));
  if (followers !== null && context?.preferAudience) {
    const bucket = followers < 1_000 ? 'SMALL' : followers < 10_000 ? 'MID' : 'LARGE';
    if (bucket === context.preferAudience) add('the audience size its own results favour', 1.5);
  }

  const metrics = raw.metrics ?? {};
  const count = (name: string) => (typeof metrics[name] === 'number' ? (metrics[name] as number) : 0);
  const traction = count('likes') + 2 * count('replies') + count('reposts') + count('quotes');
  if (traction > 0) add(`${traction} likes, replies and reposts`, 0.8 * Math.log10(traction + 1));

  const promo = readPromo(text);
  if (promo.level === 'strong') add(`reads as a token pitch (${promo.signals.join(', ')})`, -6);
  else if (promo.level === 'some') add(`reads partly as a pitch (${promo.signals.join(', ')})`, -2.5);

  const handle = (candidate.authorHandle ?? '').replace(/^@+/, '').toLowerCase();
  if (handle && context?.contactedRecently?.includes(handle)) add('approached them in the last week', -4);
  if (handle && context?.engagedWithUs?.includes(handle)) add('they have written to this agent', 2);
  if (candidate.parentRemoteId) add('a reply inside somebody else\'s thread', -1);

  return { score: round(score), factors };
}

/**
 * Which of a search's results are worth ingesting at all, best first.
 *
 * Keeps `keep` of them, and writes each kept candidate's score, rank and
 * reasons onto its payload, so the event, the job and the owner's screen can
 * all say why this post was chosen over the others.
 */
/**
 * What a people-focused session read, turned into posts the agent may answer.
 *
 * For COMMUNITY, the page is a watched account's post and everything under it.
 * The account itself is not a candidate, the agent is not, and nor is anybody
 * the account already answered on that page: it spoke to them, and the agent
 * joining in would be talking over the person it follows. What remains are the
 * people who replied and heard nothing back.
 *
 * Every kept post is marked with where it came from, so the engagement
 * decision and the prompt both know it is somebody in that account's
 * conversation rather than a stranger found by searching a word.
 */
export function peopleCandidates(
  candidates: RadarCandidate[],
  input: { mode: 'COMMUNITY' | 'CIRCLE'; watched: string; self: string; postId?: string | null },
): RadarCandidate[] {
  const watched = input.watched.replace(/^@+/, '').toLowerCase();
  const self = input.self.replace(/^@+/, '').toLowerCase();
  const author = (c: RadarCandidate) => (c.authorHandle ?? '').replace(/^@+/, '').toLowerCase();

  const answered = new Set<string>();
  if (input.mode === 'COMMUNITY') {
    for (const candidate of candidates) {
      if (author(candidate) !== watched) continue;
      // X renders whom a reply answers on its own "Replying to" line, which the
      // reader keeps; a reply's text only starts with handles when typed there.
      const rendered = (candidate.raw as { replyingTo?: unknown } | null)?.replyingTo;
      for (const handle of Array.isArray(rendered) ? rendered : []) {
        if (typeof handle === 'string') answered.add(handle.replace(/^@+/, '').toLowerCase());
      }
      const leading = /^\s*((?:@[A-Za-z0-9_]{1,15}\s+)+)/.exec(`${candidate.text} `)?.[1] ?? '';
      for (const handle of leading.match(/@[A-Za-z0-9_]{1,15}/g) ?? []) answered.add(handle.slice(1).toLowerCase());
    }
  }

  return candidates
    .filter((c) => author(c) && author(c) !== watched && author(c) !== self && !answered.has(author(c)))
    .map((c) => ({
      ...c,
      eventType: 'KEYWORD_MATCH',
      ...(input.mode === 'COMMUNITY' && input.postId
        ? { parentRemoteId: input.postId, conversationRemoteId: input.postId }
        : {}),
      raw: {
        ...(c.raw && typeof c.raw === 'object' ? (c.raw as Record<string, unknown>) : {}),
        community: {
          watched: input.watched.replace(/^@+/, ''),
          kind: input.mode === 'COMMUNITY' ? 'REPLY' : 'CIRCLE',
          ...(input.postId ? { postId: input.postId } : {}),
        },
      },
    }));
}

/**
 * Which of those people to approach this session.
 *
 * Not the topic ranker: these posts are not chosen for their subject. Never
 * somebody selling a token, never somebody approached in the last week, and
 * somebody who has written to the agent before goes first. Otherwise a reply
 * with something in it beats a bare "gm", because kind words need something to
 * be kind about, and one person is taken once.
 */
export function rankPeople(
  candidates: RadarCandidate[],
  keep: number,
  context: { contactedRecently?: string[]; engagedWithUs?: string[] } = {},
): RadarCandidate[] {
  const contacted = new Set((context.contactedRecently ?? []).map((h) => h.toLowerCase()));
  const engaged = new Set((context.engagedWithUs ?? []).map((h) => h.toLowerCase()));
  const seen = new Set<string>();
  return candidates
    .filter((c) => readPromo(c.text).level !== 'strong')
    .filter((c) => !contacted.has((c.authorHandle ?? '').toLowerCase()))
    .map((c) => {
      const handle = (c.authorHandle ?? '').toLowerCase();
      const words = c.text.replace(/@[A-Za-z0-9_]{1,15}/g, ' ').replace(/https?:\/\/\S+/g, ' ').split(/\s+/).filter(Boolean).length;
      const score = (engaged.has(handle) ? 20 : 0) + Math.min(words, 20);
      return { c, handle, score };
    })
    .sort((a, b) => b.score - a.score)
    .filter(({ handle }) => (seen.has(handle) ? false : (seen.add(handle), true)))
    .slice(0, Math.max(0, keep))
    .map(({ c }) => c);
}

export function rankDiscovered(candidates: RadarCandidate[], keep: number, context?: RankContext): RadarCandidate[] {
  return [...candidates]
    .map((candidate, index) => ({ candidate, index, scored: scoreDiscovered(candidate, context) }))
    .sort((a, b) => b.scored.score - a.scored.score || a.index - b.index)
    .slice(0, Math.max(0, keep))
    .map((entry, rank) => ({
      ...entry.candidate,
      raw: {
        ...entry.candidate.raw,
        ranking: { score: entry.scored.score, rank: rank + 1, of: candidates.length, factors: entry.scored.factors },
      },
    }));
}

/**
 * Where a session looks.
 *
 * COMMUNITY is the replies under a watched account's own recent post that the
 * account never answered. CIRCLE is fresh posts from the people that account
 * replies to again and again. TOPIC is a search of the agent's subjects.
 *
 * Topics alone were not enough, and measured badly: every search for a ticker
 * or a launchpad on a crypto subject returns mostly people selling coins, and a
 * live agent spent its sessions correcting token pitches. The person its voice
 * follows spends his replies on the people who talk to him and on the people
 * he knows. So two sessions in three now go there, and topics take the third.
 */
export type DiscoveryMode = 'COMMUNITY' | 'CIRCLE' | 'TOPIC';

export type DiscoveryPlan =
  | {
      go: true;
      agentId: string;
      mode: DiscoveryMode;
      /** What was looked at, in words, for the radar's idle reason. */
      term: string;
      /** The search to run, for CIRCLE and TOPIC. */
      query: string;
      /** The watched post whose replies are read, for COMMUNITY. */
      statusId?: string;
      /** The watched account, for COMMUNITY. */
      watched?: string;
      nextCursor: string;
      keep: number;
      topics: string[];
      /** Learned preferences this session applies, and whether each ran as learned or as the control. */
      variants: Record<string, 'learned' | 'control'>;
      preferAudience: 'SMALL' | 'MID' | 'LARGE' | null;
    }
  | { go: false; reason: string; retryAfterMs: number };

/** How many people a CIRCLE search names at once; X's query length is finite. */
const CIRCLE_SIZE = 8;

/**
 * How many a people-focused session may approach at once.
 *
 * Fewer than a topic search keeps, on purpose: replying to three people under
 * the same post in one sitting is exactly what reads as a bot working a thread.
 */
const PEOPLE_KEEP = 2;

const HOUR = 60 * 60_000;

/**
 * What this source should search now, or why it should not search at all.
 *
 * It searches for the one agent on the account that has outreach on and is
 * active, and only when that agent's growth may run: switched off, resting for
 * the night, or held because the account is in trouble all defer it with that
 * sentence. Resting between sessions and a spent hour do not, because the wake
 * that ends a session is what asks for this search.
 */
export async function planPersonaDiscovery(
  source: RadarSourceRow,
  now = new Date(),
  /** How old a post may be and still be answered; the search asks for nothing older. */
  withinMinutes?: number,
): Promise<DiscoveryPlan> {
  const links = await accountsRepo.listAccountAgents(source.accountId);
  for (const link of links) {
    const agent = await agentsRepo.getAgent(link.agentId);
    if (!agent || agent.state !== 'ACTIVE') continue;
    const policyRow = await agentsRepo.getActivePolicy(agent.id);
    const policy = PolicyConfig.parse(policyRow?.config ?? {});
    if (!policy.outreach.enabled) continue;

    const verdict = await growthGateFor(agent.id, source.accountId, policy, now);
    /*
      Not SPENT, and not RESTING. The session that asks for this search is
      counted before the search runs, so on the hour's last session its own
      search would be refused as "all of this hour's sessions used". Pacing is
      already the wake's job: a search runs because a session asked for it, or
      on this source's own long interval.
    */
    if (['OFF', 'QUIET_HOURS', 'HELD'].includes(verdict.state)) {
      return { go: false, reason: verdict.message, retryAfterMs: verdict.retryAfterMs ?? HOUR };
    }

    const persona = await agentsRepo.getActivePersona(agent.id).catch(() => null);
    const config = (source.config ?? {}) as { queries?: string[]; minFaves?: number; limit?: number };
    const terms = discoveryTerms({ pinned: config.queries, topics: persona?.topics ?? [] });
    const keep = Math.max(1, Math.min(policy.growth.maxCandidatesPerSession || 1, 10));
    // The ranker judges relevance against the persona's own topics even when
    // the owner pinned the searches: a pinned query says where to look, the
    // persona says what counts as on-subject once there.
    const topics = discoveryTerms({ topics: persona?.topics ?? [] }).map((t) => t.replace(/^"|"$/g, ''));

    // The accounts its owner asked it to follow, and what they are doing.
    const account = await accountsRepo.getAccount(source.accountId).catch(() => null);
    const self = (account?.handle ?? '').replace(/^@+/, '').toLowerCase();
    const watched = (await targetsRepo.listAgentTargets(agent.id).catch(() => []))
      .filter((target) => target.enabled)
      .map((target) => target.handle.replace(/^@+/, ''));
    const originals = await eventsRepo.watchedOriginals(source.accountId, watched).catch(() => []);
    const circle = (await eventsRepo.watchedCircle(source.accountId, watched).catch(() => []))
      .map((entry) => entry.handle)
      .filter((handle) => handle !== self && !watched.some((w) => w.toLowerCase() === handle))
      .slice(0, CIRCLE_SIZE);

    const step = cursorIndex(source.cursor);
    const round = Math.floor(step / 3);
    const wanted: DiscoveryMode[] = (['COMMUNITY', 'CIRCLE', 'TOPIC'] as const).slice(step % 3);
    const order: DiscoveryMode[] = [...wanted, ...(['COMMUNITY', 'CIRCLE', 'TOPIC'] as const)];
    const nextCursor = `rotation:${step + 1}`;

    /*
      What this agent has learned about where to look and whom to favour, with
      the old behaviour kept running as the control. See learning.ts.
    */
    const variants: Record<string, 'learned' | 'control'> = {};
    let preferAudience: 'SMALL' | 'MID' | 'LARGE' | null = null;
    if (policy.learning.enabled) {
      const learned = await activePreferences(agent.id);
      const mode = learned.mode;
      if (mode && ['COMMUNITY', 'CIRCLE', 'TOPIC'].includes(mode.arm)) {
        variants.mode = variantFor(`${source.id}:${step}:mode`, mode.status);
        if (variants.mode === 'learned') order.unshift(mode.arm as DiscoveryMode);
      }
      const audience = learned.audience;
      if (audience && ['SMALL', 'MID', 'LARGE'].includes(audience.arm)) {
        variants.audience = variantFor(`${source.id}:${step}:audience`, audience.status);
        if (variants.audience === 'learned') preferAudience = audience.arm as 'SMALL' | 'MID' | 'LARGE';
      }
    }

    for (const mode of order) {
      if (mode === 'COMMUNITY' && originals.length > 0) {
        const post = originals[round % originals.length]!;
        return {
          go: true,
          agentId: agent.id,
          mode,
          term: `replies to @${post.handle}`,
          query: '',
          statusId: post.statusId,
          watched: post.handle,
          nextCursor,
          keep: Math.min(keep, PEOPLE_KEEP),
          topics,
          variants,
          preferAudience,
        };
      }
      if (mode === 'CIRCLE' && circle.length > 0) {
        return {
          go: true,
          agentId: agent.id,
          mode,
          term: `people @${watched[0]} talks to`,
          // Whose circle this is, which is what exempts these posts from the
          // rules for strangers. Left empty once, and every one was declined as
          // off topic.
          watched: watched[0],
          query: discoveryQuery(`(${circle.map((handle) => `from:${handle}`).join(' OR ')})`, 0, withinMinutes),
          nextCursor,
          keep: Math.min(keep, PEOPLE_KEEP),
          topics,
          variants,
          preferAudience,
        };
      }
      if (mode === 'TOPIC' && terms.length > 0) {
        // With nobody to look at, every session is a topic session and moves on.
        const people = originals.length > 0 || circle.length > 0;
        const term = terms[(people ? round : step) % terms.length]!;
        return {
          go: true,
          agentId: agent.id,
          mode,
          term,
          query: discoveryQuery(term, config.minFaves ?? 20, withinMinutes),
          nextCursor,
          keep,
          topics,
          variants,
          preferAudience,
        };
      }
    }
    return {
      go: false,
      reason:
        'Nothing to look at: this agent follows no account and has no specific topics yet. Watch an account, add a topic to its persona, or pin a search term on this source.',
      retryAfterMs: 6 * HOUR,
    };
  }
  return {
    go: false,
    reason: 'No active agent on this account goes looking for people, so there is nothing to search for.',
    retryAfterMs: 6 * HOUR,
  };
}

function cursorIndex(cursor: string | null): number {
  const match = cursor?.match(/^rotation:(\d+)$/);
  return match ? Number(match[1]) : 0;
}

/**
 * Asks the radar to search now, because a growth session has just run.
 *
 * Moves the due time forward and nothing else, so the search happens on the
 * worker that owns the browser, under the same budget as every other read.
 */
export async function requestDiscovery(accountId: string): Promise<number> {
  const rows = await query(
    `UPDATE radar_sources SET next_poll_at = now(), updated_at = now()
      WHERE account_id = $1 AND kind = 'persona_discovery' AND enabled
        AND (next_poll_at IS NULL OR next_poll_at > now())
      RETURNING id`,
    [accountId],
  );
  return rows.length;
}

