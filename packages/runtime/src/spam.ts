/**
 * Spam defense: deciding, before anything expensive happens, whether an
 * inbound post deserves the agent's attention at all.
 *
 * Measured on ai17z-main: at least six accounts posted "#ai17zoss @grok" and
 * two links, the agent read each thread, wrote each reply with a model, and
 * published six variations of "tagging Grok won't make the video load". Every
 * one cost a thread read, several model calls and a reply slot a real person
 * could have had.
 *
 * Runs at ingest, after the event is recorded and before any job exists, so a
 * post judged SPAM costs no thread read, no model call and no priority. It is
 * kept, with its reasons, for the owner to audit and correct.
 *
 * ## What it will never do
 *
 * Condemn a word, a hashtag, a domain or an account for being present. The
 * handle @grok appearing in a message is not a signal and there is no path by
 * which it becomes one: this module has no list of handles. What it learns from
 * is repetition (the same text from many people, or many times from one), a
 * post that carries no words at all, the owner's verdicts counted per template
 * and per actor, and relationships the agent already has.
 *
 * One owner verdict applies to the one item. A template is treated as spam
 * only after two owner verdicts and none the other way, and a single "not spam"
 * outweighs the lot.
 *
 * Deterministic, so every verdict is a list of sentences an owner can read.
 */
import { createHash } from 'node:crypto';
import { relationships as relationshipsRepo, spam as spamRepo, type Tx } from '@xbam/database';

export const SPAM_VERDICTS = ['SPAM', 'SUSPECT', 'CLEAN'] as const;
export type SpamVerdict = (typeof SPAM_VERDICTS)[number];

export interface SpamFeatures {
  /** The words left once mentions, links and hashtags are taken away. */
  residue: string;
  /** What makes two posts the same post for campaign purposes. */
  fingerprint: string;
  mentions: number;
  links: number;
  hashtags: string[];
  words: number;
  scamTerms: string[];
}

export interface SpamContext {
  template: { items: number; actors: number; ownerSpam: number; ownerNotSpam: number } | null;
  actor: { spamItems: number; cleanItems: number; ownerSpam: number; ownerNotSpam: number; muted: boolean } | null;
  /** How well the agent already knows the author. */
  familiarity: 'NEW' | 'KNOWN' | 'FAMILIAR' | 'REGULAR' | null;
}

export interface SpamJudgement {
  verdict: SpamVerdict;
  score: number;
  reasons: string[];
}

/**
 * Phrases that come with a link in scam replies and almost never in a real
 * one. Two of them beside a link is a pitch; one is a hint.
 */
const SCAM_TERMS = [
  'airdrop', 'claim', 'giveaway', 'free mint', 'whitelist', 'presale', 'guaranteed', '100x', '1000x',
  'dm me', 'dm for', 'wallet connect', 'connect wallet', 'reward', 'eligible', 'limited spots', 'send me',
  'double your', 'promo', 'check my bio', 'link in bio', 'join now', 'hurry',
];

const URL = /https?:\/\/\S+|\bt\.co\/\S+/gi;
// The whole handle, whatever its length: stopping at X's fifteen left the tail
// of a longer one behind as a "word", and a post of nothing but tags read as
// having something to say.
const MENTION = /@[A-Za-z0-9_]+/g;
const HASHTAG = /#([\p{L}\p{N}_]+)/gu;

/** Same text however it was dressed: case, accents, width, invisible characters, numbers. */
export function normalizeForSpam(text: string): string {
  return text
    .normalize('NFKC')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/[\u200B-\u200F\u2060-\u206F\uFEFF]/g, '')
    .toLowerCase()
    .replace(/\d+/g, '#')
    .replace(/[^\p{L}\p{N}#\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function spamFeatures(text: string): SpamFeatures {
  const links = (text.match(URL) ?? []).length;
  const mentions = (text.match(MENTION) ?? []).length;
  const hashtags = [...text.matchAll(HASHTAG)].map((m) => m[1]!.toLowerCase());
  const residue = normalizeForSpam(text.replace(URL, ' ').replace(MENTION, ' ').replace(HASHTAG, ' '));
  const words = residue ? residue.split(' ').filter((w) => /\p{L}/u.test(w)).length : 0;
  const lower = normalizeForSpam(text);
  const scamTerms = SCAM_TERMS.filter((term) => lower.includes(term));
  /*
    A post with no words is identified by what it carried instead: its
    hashtags and how many links. "#ai17zoss @grok <two links>" from six
    accounts is one campaign; the handles they tagged are not part of it.
    With no hashtag either, nothing is shared but the shape, and a shape is
    not a text: on a live installation three unrelated link-only posts were
    grouped as a campaign, and so would three people each sending a picture.
    Such a post is identified by its own links, which X makes unique per post.
  */
  const basis =
    words > 0
      ? residue
      : hashtags.length > 0
        ? `no-words|${[...new Set(hashtags)].sort().join(',')}|links:${Math.min(links, 3)}`
        : `links-only|${(text.match(URL) ?? []).sort().join(' ')}`;
  const fingerprint = createHash('sha256').update(basis).digest('hex').slice(0, 32);
  return { residue, fingerprint, mentions, links, hashtags, words, scamTerms };
}

/** Verdict lines, from the score. */
export const SPAM_AT = 70;
export const SUSPECT_AT = 40;

export function judgeSpam(features: SpamFeatures, context: SpamContext): SpamJudgement {
  const reasons: string[] = [];
  let score = 0;
  const add = (points: number, reason: string) => {
    score += points;
    reasons.push(reason);
  };

  if (context.actor?.muted) {
    return { verdict: 'SPAM', score: 100, reasons: ['You muted this account from the agent’s attention.'] };
  }

  // What the post itself is.
  if (features.words === 0 && (features.links > 0 || features.hashtags.length > 0)) {
    add(45, 'It has no words, only links or hashtags.');
  }
  if (features.links > 0 && features.scamTerms.length >= 2) {
    add(70, `It pairs a link with a pitch (${features.scamTerms.slice(0, 3).join(', ')}).`);
  } else if (features.links > 0 && features.scamTerms.length === 1 && features.words < 12) {
    add(40, `A short post with a link and "${features.scamTerms[0]}".`);
  }
  if (features.mentions >= 10) add(30, `It tags ${features.mentions} accounts.`);
  else if (features.mentions >= 6) add(20, `It tags ${features.mentions} accounts.`);

  // What repetition says.
  const template = context.template;
  if (template) {
    if (template.actors >= 3) add(45, `The same text came from ${template.actors} different accounts.`);
    else if (template.items >= 3) add(30, `The same account sent this text ${template.items} times.`);
    if (template.ownerNotSpam > 0) add(-100, 'You marked this text as not spam before.');
    else if (template.ownerSpam >= 2) add(60, `You marked this text as spam ${template.ownerSpam} times.`);
  }

  // What the owner and the record say about the author.
  const actor = context.actor;
  if (actor) {
    if (actor.ownerNotSpam > 0) add(-40, 'You said a post from this account was not spam.');
    else if (actor.ownerSpam >= 2) add(25, `You marked ${actor.ownerSpam} posts from this account as spam.`);
    else if (actor.spamItems >= 3 && actor.cleanItems === 0) add(15, 'This account has sent nothing but spam here.');
  }

  // Somebody the agent already talks to gets the benefit of the doubt.
  if (context.familiarity === 'FAMILIAR' || context.familiarity === 'REGULAR') add(-50, 'The agent knows this person well.');
  else if (context.familiarity === 'KNOWN') add(-25, 'The agent has talked with this person before.');

  const verdict: SpamVerdict = score >= SPAM_AT ? 'SPAM' : score >= SUSPECT_AT ? 'SUSPECT' : 'CLEAN';
  return { verdict, score, reasons: reasons.length > 0 ? reasons : ['Nothing about it looks like spam.'] };
}

// ── At ingest ────────────────────────────────────────────────────────────────


/** The kinds of inbound post that are screened. An owner's own watch or a scheduled post never is. */
export const SCREENED_EVENT_TYPES = new Set(['MENTION', 'REPLY', 'KEYWORD_MATCH', 'DIRECT_MESSAGE']);

/**
 * Judges one newly recorded inbound post and keeps the verdict.
 *
 * In the ingest transaction, so the template count and the verdict land with
 * the event or not at all.
 */
/**
 * What is known about the author, read before the ingest transaction opens:
 * the record is only read there, and a pooled read inside a transaction can
 * deadlock the pool.
 */
export async function authorContext(input: {
  accountId: string;
  channel: string;
  authorHandle: string | null;
  agentIds: string[];
}): Promise<Pick<SpamContext, 'actor' | 'familiarity'>> {
  const author = spamRepo.handleKey(input.authorHandle);
  if (!author) return { actor: null, familiarity: null };
  const actor = await spamRepo.getActor(input.accountId, author).catch(() => null);
  let familiarity: SpamContext['familiarity'] = null;
  for (const agentId of input.agentIds) {
    const known = await relationshipsRepo.find({ agentId, channel: input.channel, handle: author }).catch(() => null);
    if (known && (!familiarity || rank(known.familiarity) > rank(familiarity))) familiarity = known.familiarity;
  }
  return {
    actor: actor
      ? { spamItems: actor.spamItems, cleanItems: actor.cleanItems, ownerSpam: actor.ownerSpam, ownerNotSpam: actor.ownerNotSpam, muted: actor.muted }
      : null,
    familiarity,
  };
}

export async function screenInbound(
  tx: Tx,
  input: { eventId: string; accountId: string; text: string; authorHandle: string | null },
  known: Pick<SpamContext, 'actor' | 'familiarity'>,
): Promise<SpamJudgement> {
  const features = spamFeatures(input.text);
  const author = spamRepo.handleKey(input.authorHandle);
  const template = await spamRepo.noteTemplate(tx, {
    accountId: input.accountId,
    fingerprint: features.fingerprint,
    sample: input.text,
    author,
  });
  const judgement = judgeSpam(features, {
    template: { items: template.items, actors: template.actors, ownerSpam: template.ownerSpam, ownerNotSpam: template.ownerNotSpam },
    actor: known.actor,
    familiarity: known.familiarity,
  });
  await spamRepo.recordVerdict(tx, {
    eventId: input.eventId,
    accountId: input.accountId,
    verdict: judgement.verdict,
    score: judgement.score,
    reasons: judgement.reasons,
    templateId: template.id,
  });
  if (author) await spamRepo.noteActorVerdict(tx, input.accountId, author, judgement.verdict === 'SPAM');
  return judgement;
}

function rank(familiarity: string): number {
  return ['NEW', 'KNOWN', 'FAMILIAR', 'REGULAR'].indexOf(familiarity);
}
