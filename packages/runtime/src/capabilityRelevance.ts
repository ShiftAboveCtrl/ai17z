import type { AnyCapability } from '@xbam/tools';

/**
 * Which capabilities are worth showing the model for one task.
 *
 * ## Why this exists
 *
 * The loop offered everything the owner had not switched off. That was right
 * when there were a dozen capabilities and wrong by the time there were
 * seventy-three: the menu measured 20,535 characters against a 3,010-character
 * prompt, so the question a person actually asked arrived under seven times its
 * own weight in descriptions of Bitcoin fee estimation and Snapshot proposals.
 *
 * Measured on a live agent with the loop enabled: asked the time in Tokyo it
 * called nothing, ran a web search instead, and answered "I don't know" while
 * `time.now` sat in the menu. Asked whether its browser was working it again
 * called nothing. The mechanism was fine. The model could not find the two
 * lines that mattered.
 *
 * ## Deterministic, for the reason `salience.ts` gives
 *
 * No model call. Choosing which tools a later model call may see is exactly the
 * kind of judgement an owner needs to be able to inspect, correct and tune, and
 * "the classifier thought these were relevant" is not a reason anybody can
 * argue with. It is also the wrong economics: an extra model call to decide
 * whether to make a model call is the opposite of the point.
 *
 * ## What it reads
 *
 * Only what a capability already declares: its id, the family the id begins
 * with, and the description written for the model. Nothing here is a second
 * catalogue, and a capability added tomorrow is shortlisted without editing
 * this file, provided it is described in the words somebody would use to ask
 * for it. That is a reasonable thing to require of a description that exists to
 * be read by a model.
 *
 * ## The default answer is "none"
 *
 * A task that matches nothing gets an empty shortlist and no menu at all, which
 * is both correct and fast: "nice one" needs no capability, and the model
 * should answer it without reading a catalogue first.
 */

/**
 * Words that say which family a task belongs to.
 *
 * Deliberately the words a person uses rather than the family name alone.
 * Somebody asks what time it is, not what `time` it is, and nobody says
 * "github" when they say "what shipped".
 *
 * Short on purpose. This is a hint that lifts a family above the noise, not a
 * classifier: the word overlap below does most of the work, and a long list
 * here starts deciding what an agent is allowed to look up.
 */
const FAMILY_HINTS: Record<string, string[]> = {
  time: ['time', 'clock', 'date', 'today', 'tomorrow', 'timezone', 'utc', 'hour'],
  memory: ['remember', 'memory', 'recall', 'forgot', 'told you', 'we discussed'],
  agent: ['you working', 'your status', 'diagnostics', 'health', 'are you ok', 'browser working', 'blind'],
  x: ['tweet', 'post', 'thread', 'timeline', 'profile', 'mention', 'follower', 'reply', 'quote'],
  github: ['github', 'repo', 'repository', 'commit', 'release', 'pull request', 'issue', 'shipped', 'changelog'],
  chain: ['ethereum', 'evm', 'base', 'arbitrum', 'optimism', 'polygon', 'gas', 'block', 'receipt', 'onchain'],
  solana: ['solana', 'sol', 'spl'],
  bitcoin: ['bitcoin', 'btc', 'satoshi', 'utxo'],
  market: ['price', 'ticker', 'pair', 'liquidity', 'volume', 'market cap', 'chart', 'trading'],
  defi: ['tvl', 'defi', 'stablecoin', 'protocol'],
  token: ['token', 'rug', 'honeypot', 'risk'],
  address: ['wallet', 'address', 'sanction', 'phishing', 'stolen'],
  contract: ['contract', 'abi', 'verified', 'bytecode'],
  governance: ['proposal', 'governance', 'snapshot', 'vote', 'dao'],
  company: ['filing', 'sec', 'earnings', 'ticker symbol'],
  research: ['paper', 'arxiv', 'study', 'preprint'],
  /*
    No hints, deliberately.

    These answered to "who is" and "what is", which is the opening of almost
    every question anybody asks, so `entity.*` turned up on the time in Tokyo
    and the price of SOL. A family whose hint matches everything is worse than
    a family with no hint at all: the description overlap below still finds it
    when somebody actually asks about an entity.
  */
  entity: [],
  reference: ['definition', 'wikipedia'],
  feed: ['feed', 'rss', 'blog'],
  web: ['website', 'web page', 'archive', 'wayback'],
  storage: ['ipfs', 'arweave', 'cid'],
};

/** Too common to say anything about which capability is wanted. */
const NOISE = new Set([
  'about', 'after', 'again', 'all', 'and', 'any', 'anything', 'are', 'ask', 'back', 'because', 'been', 'being',
  'but', 'can', 'could', 'did', 'does', 'doing', 'done', 'for', 'from', 'get', 'give', 'going', 'good', 'got',
  'had', 'has', 'have', 'here', 'how', 'into', 'its', 'just', 'know', 'like', 'made', 'make', 'many', 'me',
  'more', 'most', 'much', 'need', 'not', 'now', 'one', 'only', 'other', 'our', 'out', 'over', 'own', 'read',
  'really', 'right', 'said', 'same', 'say', 'see', 'should', 'some', 'still', 'such', 'take', 'tell', 'than',
  'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'thing', 'things', 'think', 'this', 'those',
  'through', 'too', 'use', 'using', 'very', 'want', 'was', 'way', 'well', 'were', 'what', 'when', 'where',
  'which', 'while', 'who', 'why', 'will', 'with', 'would', 'you', 'your', 'returns', 'reports', 'takes',
  'exact', 'current', 'every', 'never', 'always', 'means', 'result', 'answer', 'check', 'checks',
]);

function words(text: string): Set<string> {
  const found = new Set<string>();
  for (const match of text.toLowerCase().matchAll(/[a-z][a-z0-9_]{2,}/g)) {
    const word = match[0]!;
    if (!NOISE.has(word)) found.add(word);
  }
  return found;
}

/**
 * Whether a task used this word, allowing for the endings people put on verbs.
 *
 * "What has @foo been posting" is a question about posts, and matching the
 * exact word only meant it was offered nothing at all. A short suffix is
 * enough for the endings that matter -- posting, posts, posted, tweets,
 * commits, releases -- and refusing anything longer keeps `post` away from
 * `postgres`, which is a different subject entirely.
 */
const LONGEST_ENDING = 3;

function mentions(asked: Set<string>, hint: string): boolean {
  if (asked.has(hint)) return true;
  for (const word of asked) {
    if (word.length > hint.length && word.length <= hint.length + LONGEST_ENDING && word.startsWith(hint)) {
      return true;
    }
  }
  return false;
}

/** The part of an id before the first dot: `x.read_post` is in the `x` family. */
export function familyOf(capabilityId: string): string {
  const dot = capabilityId.indexOf('.');
  return dot === -1 ? capabilityId : capabilityId.slice(0, dot);
}

export interface Shortlist {
  /** What the model is shown, best first. */
  offered: AnyCapability[];
  /** How many were available before relevance narrowed them. */
  considered: number;
  /** Families that scored, best first, for the owner to inspect. */
  families: string[];
}

/**
 * How many capabilities one task may see.
 *
 * Small enough that the menu stays a short list a model reads rather than a
 * catalogue it skims, and large enough that a question touching two families
 * still gets both. Eight is about 2,000 characters at current description
 * lengths, against 20,535 for all of them.
 */
export const SHORTLIST_LIMIT = 8;

/** Below this a family has not really been asked for. */
const FLOOR = 2;

/**
 * The capabilities worth offering for this task.
 *
 * `task` is the text of what is being answered: the incoming message, plus
 * whatever context the caller thinks describes the job. Everything is scored
 * against it and the best few are returned.
 */
export function shortlistCapabilities(
  available: AnyCapability[],
  task: string,
  limit: number = SHORTLIST_LIMIT,
): Shortlist {
  const asked = words(task);
  const lowered = task.toLowerCase();
  if (asked.size === 0) return { offered: [], considered: available.length, families: [] };

  // A family named by the words somebody used is a strong signal, and it lifts
  // every capability in that family rather than only the one whose description
  // happened to repeat the word.
  const familyScore = new Map<string, number>();
  for (const [family, hints] of Object.entries(FAMILY_HINTS)) {
    let hits = 0;
    for (const hint of hints) {
      if (hint.includes(' ') ? lowered.includes(hint) : mentions(asked, hint)) hits += 1;
    }
    if (hits > 0) familyScore.set(family, hits * 3);
  }

  /*
    A family nothing here has hints for still has to be findable.

    `FAMILY_HINTS` names the families that ship with AI17Z, which is fine right
    up until a family arrives that this file has never heard of: an installed
    Plugin's. Its family then scored zero however well its own words matched,
    so the only way to reach one was to say its id out loud -- an imported
    Plugin called `berth-times` answered "the next berth slot at Falmouth" and
    was invisible to "what is the temperature there", with `temperature` in
    both its title and its description. Measured on a real installation: score
    1 against a floor of 2.

    So a family with no hints derives them from what its own capabilities
    declare: the words of their titles. That is the same promise the
    description scoring already makes, applied at the family level, and it
    reads only what a Plugin already had to write down. Deterministic and with
    no model call, for the reason `salience.ts` gives: which tools a later
    model call may see is exactly the judgement an owner needs to inspect.

    Families that do have hints are untouched, so none of the built-in
    families can shift.
  */
  const derived = new Map<string, Set<string>>();
  for (const capability of available) {
    const family = familyOf(capability.id);
    if (family in FAMILY_HINTS) continue;
    let bag = derived.get(family);
    if (!bag) derived.set(family, (bag = new Set<string>()));
    for (const word of words(capability.name)) bag.add(word);
  }
  for (const [family, hints] of derived) {
    let hits = 0;
    for (const hint of hints) if (mentions(asked, hint)) hits += 1;
    if (hits > 0) familyScore.set(family, hits * 3);
  }

  const scored = available.map((capability) => {
    const family = familyOf(capability.id);
    let score = familyScore.get(family) ?? 0;

    // The id says what it answers: `read_post`, `price_check`, `paper_search`.
    for (const word of words(capability.id.replace(/[._]/g, ' '))) {
      if (asked.has(word)) score += 2;
    }
    /*
      And so does the title, which was read by nothing at all.

      A capability's id is written for a programmer and its title for a person,
      so the title is the one carrying the words somebody would actually use.
      Only counted for a family this file has no hints for, so the twenty
      built-in families score exactly as they did: this is here to make an
      installed Plugin reachable, not to re-tune capabilities that already are.
    */
    if (!(family in FAMILY_HINTS)) {
      for (const word of words(capability.name)) {
        if (asked.has(word)) score += 2;
      }
    }
    /*
      The description is written for the model, so the words it uses are the
      words somebody asking for it would use.

      A match is worth more when it is most of what the capability says.

      "The time." answering "what time is it?" has one word to offer and it is
      the right one; scoring purely by volume put it below the floor. Simply
      rewarding any first match instead let one incidental word out of twenty
      lift unrelated families onto a question about a browser session. So the
      bonus is for covering the description rather than merely touching it.
    */
    const described = words(capability.description);
    let overlap = 0;
    for (const word of described) {
      if (asked.has(word)) overlap += 1;
    }
    score += Math.min(overlap, 4);
    if (described.size > 0 && overlap / described.size >= 0.5) score += 2;

    /*
      A question wants reading, so reading sorts first.

      "What has @foo been posting" put `x.like` at the top of the list purely
      because it is in the family somebody named. It is still permission-gated
      and the model may legitimately want it, so this is an ordering and not a
      ban: one point, enough to put the eight reads above the one write when
      the shortlist is cut.
    */
    if (capability.effect !== 'READ') score -= 1;
    return { capability, score, family };
  });

  const keep = scored
    .filter((entry) => entry.score >= FLOOR)
    .sort((a, b) => b.score - a.score || a.capability.id.localeCompare(b.capability.id))
    .slice(0, limit);

  const families: string[] = [];
  for (const entry of keep) if (!families.includes(entry.family)) families.push(entry.family);

  return {
    offered: keep.map((entry) => entry.capability),
    considered: available.length,
    families,
  };
}
