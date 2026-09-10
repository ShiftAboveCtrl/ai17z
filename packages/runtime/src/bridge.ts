/**
 * How much of an audience the agent does not already reach sits behind one
 * account, and why.
 *
 * The name is the definition. A bridge connects two groups that are otherwise
 * separate, so somebody entirely inside the circle the agent already talks to
 * is not a bridge however well liked they are -- the audience behind them has
 * already heard everything. Reach without novelty is a megaphone pointed at the
 * same room.
 *
 * ### What this is not
 *
 * `contracts/relationship.ts` says plainly that familiarity exists so a
 * conversation can continue naturally, "not as a score for deciding whose
 * message is worth more, and not as a measure of anybody's value". That rule
 * holds here and this file is on the other side of it:
 *
 * - Nothing in the reply path may read a bridge score. Whether to answer
 *   somebody is the engagement heuristic's decision and is about the message,
 *   never about who sent it.
 * - This ranks conversations the agent might *start*, which is a question about
 *   the agent's own attention and nobody else's worth.
 * - It is shown to the owner with its reasons, because a number nobody can
 *   argue with is a number nobody can correct.
 *
 * `docs/ENGINEERING.md`: "The reasons matter more than the scores." Every
 * factor here carries the sentence that produced it, and a score whose factors
 * were all guesses says so in `gaps` rather than looking like the same number
 * as one that was measured.
 */

/** What was observed about one account. Everything optional was not visible. */
export interface BridgeInput {
  handle: string;
  /** How many accounts follow them, where a profile said. */
  followerCount?: number;
  /** How many the agent's own account has, for scale. */
  ourFollowerCount?: number;
  /** X's own badge on their row or profile. */
  followsUs?: boolean;
  weFollow?: boolean;
  /** Exchanges with the agent, from relationship memory. */
  inboundCount?: number;
  outboundCount?: number;
  /** ISO timestamp of the last exchange, where there has been one. */
  lastInteractionAt?: string;
  /**
   * Accounts seen in the same conversations as them, and how many of those the
   * agent already talks to. The ratio is the novelty: an account whose whole
   * neighbourhood is already ours bridges to nowhere.
   */
  neighbours?: number;
  neighboursWeKnow?: number;
  /** An owner instruction. BLOCKED is not a low score, it is a stop. */
  disposition?: 'NEUTRAL' | 'FRIENDLY' | 'CAUTIOUS' | 'BLOCKED';
}

export interface BridgeFactor {
  name: string;
  /** A sentence a person could read on its own. */
  detail: string;
  /** How much this moved the score, positive or negative. */
  points: number;
}

export const BRIDGE_BANDS = ['NONE', 'WEAK', 'WORTH_KNOWING', 'STRONG'] as const;
export type BridgeBand = (typeof BRIDGE_BANDS)[number];

export interface BridgeScore {
  handle: string;
  /** 0 to 100. Only ever compared with other scores from the same agent. */
  value: number;
  band: BridgeBand;
  factors: BridgeFactor[];
  /** What could not be measured. A score built on three gaps is a guess. */
  gaps: string[];
  /** True when an owner instruction, not a measurement, decided this. */
  blocked: boolean;
}

/** Where the bands sit. Named so a change is a decision rather than a tweak. */
const BANDS: { band: BridgeBand; atLeast: number }[] = [
  { band: 'STRONG', atLeast: 65 },
  { band: 'WORTH_KNOWING', atLeast: 40 },
  { band: 'WEAK', atLeast: 18 },
  { band: 'NONE', atLeast: 0 },
];

/**
 * Reach, on a log scale and relative to the agent's own following.
 *
 * Linear reach makes one large account outrank every other consideration
 * combined, which is how automated outreach ends up talking exclusively at
 * people who will never answer. An account ten times our size is worth more
 * attention than one our own size, but not ten times more.
 */
function reachPoints(followers: number, ours: number): number {
  const ratio = followers / Math.max(ours, 100);
  if (ratio <= 0) return 0;
  // log10 of the ratio: same size scores 0, ten times scores 1, a hundred
  // times scores 2. Capped, because past a point the answer stops changing.
  const magnitude = Math.log10(ratio);
  return Math.round(Math.max(-10, Math.min(30, magnitude * 15)));
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function scoreBridge(input: BridgeInput, now: Date = new Date()): BridgeScore {
  const factors: BridgeFactor[] = [];
  const gaps: string[] = [];

  if (input.disposition === 'BLOCKED') {
    // An owner instruction is not a low score to be outweighed by a big
    // follower count. It is the end of the question.
    return {
      handle: input.handle,
      value: 0,
      band: 'NONE',
      factors: [{ name: 'blocked', detail: 'You asked this agent not to engage with this account.', points: 0 }],
      gaps: [],
      blocked: true,
    };
  }

  if (input.followerCount === undefined) {
    gaps.push('How many people follow them was not visible.');
  } else if (input.ourFollowerCount === undefined) {
    gaps.push('This account’s own follower count is not known, so reach has no scale to be measured against.');
  } else {
    const points = reachPoints(input.followerCount, input.ourFollowerCount);
    factors.push({
      name: 'reach',
      detail:
        points > 0
          ? `They reach ${input.followerCount.toLocaleString()} accounts, against your ${input.ourFollowerCount.toLocaleString()}.`
          : `They reach ${input.followerCount.toLocaleString()} accounts, fewer than your ${input.ourFollowerCount.toLocaleString()}.`,
      points,
    });
  }

  // Novelty. The distinctive half: a bridge leads somewhere new.
  if (input.neighbours === undefined || input.neighbours === 0) {
    gaps.push('Nobody has been seen in a conversation with them yet, so it is not known where they lead.');
  } else {
    const known = input.neighboursWeKnow ?? 0;
    const novelty = 1 - Math.min(known / input.neighbours, 1);
    const points = Math.round(novelty * 35);
    factors.push({
      name: 'novelty',
      detail:
        known === 0
          ? `None of the ${input.neighbours} accounts seen around them are ones you already talk to.`
          : `${known} of the ${input.neighbours} accounts seen around them are already yours.`,
      points,
    });
  }

  // Reciprocity. Somebody who follows back is reachable; a mutual is more so.
  if (input.followsUs === undefined && input.weFollow === undefined) {
    gaps.push('Whether either account follows the other was not visible.');
  } else if (input.followsUs && input.weFollow) {
    factors.push({ name: 'mutual', detail: 'You follow each other.', points: 15 });
  } else if (input.followsUs) {
    factors.push({ name: 'follows-you', detail: 'They follow you and you do not follow them.', points: 10 });
  } else if (input.weFollow) {
    factors.push({ name: 'you-follow', detail: 'You follow them and they do not follow you.', points: 3 });
  } else {
    factors.push({ name: 'strangers', detail: 'Neither of you follows the other.', points: 0 });
  }

  // Whether talking to them has ever worked. Answered, not merely spoken at.
  const inbound = input.inboundCount ?? 0;
  const outbound = input.outboundCount ?? 0;
  if (inbound > 0) {
    const points = Math.min(20, 6 + inbound * 2);
    factors.push({
      name: 'answers',
      detail: `They have written to you ${inbound} time${inbound === 1 ? '' : 's'}.`,
      points,
    });
  } else if (outbound > 0) {
    // Spoken at and never answered. That is evidence, and it points down.
    factors.push({
      name: 'unanswered',
      detail: `You have written to them ${outbound} time${outbound === 1 ? '' : 's'} and they have not replied.`,
      points: -Math.min(15, outbound * 5),
    });
  }

  if (input.lastInteractionAt) {
    const days = Math.floor((now.getTime() - new Date(input.lastInteractionAt).getTime()) / DAY_MS);
    if (Number.isFinite(days) && days > 45) {
      factors.push({
        name: 'gone-quiet',
        detail: `Nothing has passed between you for ${days} days.`,
        points: -8,
      });
    }
  }

  if (input.disposition === 'CAUTIOUS') {
    factors.push({ name: 'cautious', detail: 'You marked this account as one to be careful with.', points: -25 });
  } else if (input.disposition === 'FRIENDLY') {
    factors.push({ name: 'friendly', detail: 'You marked this account as friendly.', points: 10 });
  }

  const raw = factors.reduce((total, factor) => total + factor.points, 0);
  const value = Math.max(0, Math.min(100, raw));
  const band = BANDS.find((entry) => value >= entry.atLeast)?.band ?? 'NONE';
  return { handle: input.handle, value, band, factors, gaps, blocked: false };
}

/**
 * Ranks accounts by how much of a bridge each is, worst gaps last.
 *
 * Two accounts on the same score are not equally well understood, and the one
 * whose score rests on three missing measurements should not be presented as
 * though it were the sure thing. Ties break towards the one that was actually
 * measured.
 */
export function rankBridges(scores: BridgeScore[]): BridgeScore[] {
  return [...scores].sort((a, b) => b.value - a.value || a.gaps.length - b.gaps.length || a.handle.localeCompare(b.handle));
}
