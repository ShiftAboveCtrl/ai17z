import { z } from 'zod';

/**
 * The Research Fabric's vocabulary: what a piece of outside evidence is, where
 * it came from, and how far it may be believed.
 *
 * One vocabulary for every feature that reads the outside world on an owner's
 * behalf: Agent Foundry, persona sources, knowledge collections, the reply
 * research step, Response Lab and chat. Before it, each of those had its own
 * idea of what a source was, and "is this a mirror of that" had no answer
 * anywhere.
 *
 * Nothing here knows what X looks like. A platform's object ids, URL shapes and
 * mirror hosts are the channel's business; the fabric sees an opaque object key
 * such as `x:status:123` and a source family such as `TWSTALKER`.
 */

/**
 * How much a source may be believed, as a class rather than a number.
 *
 * A number invites arithmetic that means nothing. A class answers the question
 * that matters: is this the thing itself, somebody quoting it, or somebody
 * quoting somebody quoting it.
 */
export const SOURCE_TRUST_TIERS = [
  /** The platform's own record, read as the platform shows it: canonical X. */
  'PRIMARY_PLATFORM',
  /** A project's own site or documentation. */
  'OFFICIAL_PROJECT',
  /** A project's own repository, at a commit. */
  'OFFICIAL_REPOSITORY',
  /** State read directly from where it lives: a chain, a registry. */
  'DIRECT_AUTHORITATIVE',
  /** Something the owner handed over. Trusted as theirs, not as the world's. */
  'OWNER_SUPPLIED',
  /** A search engine's index: a pointer and a snippet, never the whole thing. */
  'SEARCH_INDEX',
  /** A third-party copy of a platform: TwStalker, Sotwe. */
  'PUBLIC_MIRROR',
  /** A dated snapshot: the Wayback Machine and the like. */
  'ARCHIVE',
  'UNKNOWN',
] as const;
export const SourceTrustTier = z.enum(SOURCE_TRUST_TIERS);
export type SourceTrustTier = (typeof SOURCE_TRUST_TIERS)[number];

/**
 * What the research is for, because the ranking depends on it.
 *
 * For how a person writes, the platform they write on is the best witness and a
 * project's documentation says nothing. For what a project does, its own docs
 * and code outrank anything anybody posted about it, the project's own account
 * included.
 */
export const RESEARCH_PURPOSES = ['PERSONA', 'FACTUAL'] as const;
export const ResearchPurpose = z.enum(RESEARCH_PURPOSES);
export type ResearchPurpose = (typeof RESEARCH_PURPOSES)[number];

const PERSONA_ORDER: readonly SourceTrustTier[] = [
  'PRIMARY_PLATFORM',
  'OWNER_SUPPLIED',
  'SEARCH_INDEX',
  'PUBLIC_MIRROR',
  'ARCHIVE',
  'OFFICIAL_PROJECT',
  'OFFICIAL_REPOSITORY',
  'DIRECT_AUTHORITATIVE',
  'UNKNOWN',
];

const FACTUAL_ORDER: readonly SourceTrustTier[] = [
  'DIRECT_AUTHORITATIVE',
  'OFFICIAL_REPOSITORY',
  'OFFICIAL_PROJECT',
  'PRIMARY_PLATFORM',
  'OWNER_SUPPLIED',
  'ARCHIVE',
  'SEARCH_INDEX',
  'PUBLIC_MIRROR',
  'UNKNOWN',
];

/** Higher is believed first, for this purpose. */
export function trustRank(tier: SourceTrustTier, purpose: ResearchPurpose): number {
  const order = purpose === 'PERSONA' ? PERSONA_ORDER : FACTUAL_ORDER;
  const at = order.indexOf(tier);
  return at < 0 ? 0 : order.length - at;
}

/**
 * Who produced an observation, as one family however many hosts it answers on.
 *
 * TwStalker serves the same copy of a post from twstalker.com, www6., ww.,
 * platform. and more. Five of them agreeing is one mirror saying something five
 * times, and counting it as five would let a mirror outvote the platform.
 */
export const SOURCE_FAMILIES = [
  'X',
  'SEARCH_ENGINE',
  'TWSTALKER',
  'SOTWE',
  'WEB',
  'GITHUB',
  'DOCUMENTATION',
  'OWNER',
  'PLUGIN',
  'ARCHIVE',
] as const;
export const SourceFamily = z.enum(SOURCE_FAMILIES);
export type SourceFamily = (typeof SOURCE_FAMILIES)[number];

/** What kind of thing was seen. */
export const EVIDENCE_KINDS = [
  'POST',
  'REPLY',
  'QUOTE',
  'PROFILE',
  'WEB_PAGE',
  'DOC_PAGE',
  'REPO_FILE',
  'SEARCH_RESULT',
  'OWNER_TEXT',
] as const;
export const EvidenceKind = z.enum(EVIDENCE_KINDS);
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/**
 * How much of the thing an observation actually holds.
 *
 * A search snippet is a fragment chosen to make somebody click. It is never
 * presented as the post, and a post known only from a snippet stays PARTIAL
 * until something reads the original.
 */
export const EVIDENCE_COMPLETENESS = ['FULL', 'PARTIAL', 'SNIPPET'] as const;
export const EvidenceCompleteness = z.enum(EVIDENCE_COMPLETENESS);
export type EvidenceCompleteness = (typeof EVIDENCE_COMPLETENESS)[number];

/** Bumped when the way observations are normalised changes, so old rows can be told apart. */
export const RESEARCH_NORMALIZATION_VERSION = 1;

/**
 * One sighting of something, as an adapter hands it over.
 *
 * `objectKey` is how two sightings are known to be the same thing: the same
 * post seen on X, on two TwStalker hosts and in a search result has one key.
 * An observation with no recoverable identity keys on its canonical URL, and
 * failing that on its content hash, so it still deduplicates with itself.
 */
export const ResearchObservation = z.object({
  objectKey: z.string().min(1).max(300),
  family: SourceFamily,
  kind: EvidenceKind,
  tier: SourceTrustTier,
  completeness: EvidenceCompleteness,
  canonicalUrl: z.string().max(2_000).nullable(),
  originalUrl: z.string().max(2_000).nullable(),
  platform: z.string().max(40).nullable(),
  externalId: z.string().max(200).nullable(),
  author: z.string().max(200).nullable(),
  /** Who this was a reply to, when it was one. */
  inReplyTo: z.string().max(200).nullable().default(null),
  publishedAt: z.string().nullable(),
  fetchedAt: z.string(),
  content: z.string().max(40_000),
  language: z.string().max(12).nullable().default(null),
  /** Anything provenance needs that the columns above do not hold. Never secrets. */
  meta: z.record(z.string(), z.unknown()).default({}),
});
export type ResearchObservation = z.infer<typeof ResearchObservation>;

/** What a research run is for. */
export const RESEARCH_RUN_KINDS = ['FOUNDRY_SETUP', 'FOUNDRY_IMPROVE', 'PERSONA_REFRESH', 'OWNER_REQUEST', 'KNOWLEDGE_DISCOVERY'] as const;
export type ResearchRunKind = (typeof RESEARCH_RUN_KINDS)[number];

/** Stages a research run moves through, each committed before the next starts. */
export const RESEARCH_RUN_STATUSES = ['QUEUED', 'RUNNING', 'READY', 'FAILED', 'CANCELLED'] as const;
export const ResearchRunStatus = z.enum(RESEARCH_RUN_STATUSES);
export type ResearchRunStatus = (typeof RESEARCH_RUN_STATUSES)[number];

/** Whether a source can be asked right now, and why not. */
export const SOURCE_AVAILABILITY = ['AVAILABLE', 'DEGRADED', 'UNAVAILABLE', 'NOT_CONFIGURED'] as const;
export type SourceAvailability = (typeof SOURCE_AVAILABILITY)[number];

/** What a secondary source may be used for. */
export const RESEARCH_SOURCE_ROLES = ['PERSONA_RESEARCH', 'SOCIAL_HISTORY', 'KNOWLEDGE_DISCOVERY', 'WEB_RESEARCH'] as const;
export type ResearchSourceRole = (typeof RESEARCH_SOURCE_ROLES)[number];

/**
 * Tiers that may establish a fact on their own.
 *
 * A mirror, a search snippet and an archive may point at something and may
 * enrich a persona; none of them may by itself establish an official
 * announcement, a contract address, a financial figure, anything private, or the
 * current state of an account.
 */
export function mayEstablishFact(tier: SourceTrustTier): boolean {
  return tier === 'PRIMARY_PLATFORM' || tier === 'OFFICIAL_PROJECT' || tier === 'OFFICIAL_REPOSITORY' || tier === 'DIRECT_AUTHORITATIVE';
}

/**
 * Tiers that may start anything live: a reply, a like, a follow.
 *
 * Only the platform itself, read now. A mirror's copy may be hours old and of a
 * post since deleted, and acting on it is acting on a rumour.
 */
export function mayTriggerAction(tier: SourceTrustTier): boolean {
  return tier === 'PRIMARY_PLATFORM';
}

const READING_ORDER: readonly SourceTrustTier[] = [
  'PRIMARY_PLATFORM',
  'DIRECT_AUTHORITATIVE',
  'OFFICIAL_REPOSITORY',
  'OFFICIAL_PROJECT',
  'OWNER_SUPPLIED',
  'ARCHIVE',
  'PUBLIC_MIRROR',
  'SEARCH_INDEX',
  'UNKNOWN',
];

/**
 * Which copy of one object is its text, whatever the research is for.
 *
 * Different from `trustRank`, which orders claims: this orders copies of the
 * same thing. A whole copy beats a fragment, and then the thing's own home beats
 * anybody's copy of it, so X's reading of a post is the post and a mirror's is
 * a sighting of it.
 */
export function readingPrecedence(tier: SourceTrustTier, completeness: EvidenceCompleteness): number {
  const whole = completeness === 'FULL' ? 2 : completeness === 'PARTIAL' ? 1 : 0;
  const at = READING_ORDER.indexOf(tier);
  return whole * 100 + (at < 0 ? 0 : READING_ORDER.length - at);
}

/** Collapses whitespace and case, so two copies of one text compare equal. */
export function normalizeEvidenceText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[…]|\.{3}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Whether a copy of an object says something different from its best reading.
 *
 * A snippet or partial copy disagrees only if it is not part of the whole: a
 * search engine cutting a post short is not a different post. Two whole copies
 * disagree when they differ at all, and the difference is recorded rather than
 * merged, because a hybrid of two copies is a post nobody wrote.
 */
export function copiesDisagree(
  best: { content: string; completeness: EvidenceCompleteness },
  copy: { content: string; completeness: EvidenceCompleteness },
): boolean {
  const a = normalizeEvidenceText(best.content);
  const b = normalizeEvidenceText(copy.content);
  if (!a || !b) return false;
  if (copy.completeness !== 'FULL') return !fragmentOf(b, a);
  if (best.completeness !== 'FULL') return !fragmentOf(a, b);
  return a !== b;
}

/**
 * Whether a fragment could have come from a whole text.
 *
 * By the words it shares rather than as a substring, because a search engine's
 * result is the page title and a snippet stitched together, neither of which
 * appears verbatim in the post. Short words carry nothing, so only words of
 * four letters or more are counted, and a fragment with fewer than three of
 * those cannot be judged and is given the benefit of the doubt.
 */
function fragmentOf(fragment: string, whole: string): boolean {
  const words = (text: string) => text.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4);
  const mine = words(fragment);
  if (mine.length < 3) return true;
  const theirs = new Set(words(whole));
  const shared = mine.filter((w) => theirs.has(w)).length;
  return shared / mine.length >= 0.5;
}
