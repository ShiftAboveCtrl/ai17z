import { createLogger, errorMessage, refersToSomethingElse } from '@xbam/shared';
import { describeToken, mergeReferences, parseTokenReference, resolveToken } from './token';

const log = createLogger('research');

/**
 * Looking things up, so an agent asked about this morning is not limited to
 * whatever its model was trained on.
 *
 * "Hey, what is this about?" under a post from an hour ago is unanswerable from
 * a training set, and a model that answers it anyway invents something. The
 * options were to stay silent or to guess; this is the third one.
 *
 * Two sources, chosen because they cover what actually gets asked:
 *
 *   - the open web, read through the browser that is already running
 *   - DexScreener, for a contract address or a ticker, because it is free,
 *     needs no key, and is the specific question that comes up most
 *
 * What comes back is quoted as *what a source said*, never as something the
 * agent knows. A search result is evidence with a name on it, and the prompt
 * says so, because an agent that launders a search result into its own voice is
 * an agent that will state a wrong one just as confidently.
 */

export type LookupKind = 'search' | 'token' | 'link';

export interface Lookup {
  kind: LookupKind;
  query: string;
  /** Why this was worth looking up, shown in the trace. */
  reason: string;
}

export interface Finding {
  kind: LookupKind;
  query: string;
  /** Where this came from, named so the prompt can attribute it. */
  source: string;
  title: string;
  summary: string;
  url: string | null;
  retrievedAt: string;
}

export interface ResearchResult {
  findings: Finding[];
  /** Lookups that were attempted and failed, so a gap is visible not silent. */
  failed: { query: string; reason: string }[];
  /** Said in words for the trace. */
  note: string;
}

// ── Deciding what, if anything, is worth looking up ──────────────────────────

/** An EVM contract address. */
const EVM_ADDRESS = /\b0x[a-fA-F0-9]{40}\b/g;
/**
 * A Solana address. Base58, so no 0, O, I or l, and long enough not to match
 * an ordinary word — 32 is the shortest a real one gets.
 */
const SOLANA_ADDRESS = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
const TICKER = /\$([A-Za-z][A-Za-z0-9]{1,9})\b/g;

/**
 * Phrases that mean "I am asking about something you cannot know".
 *
 * Deliberately about the *shape* of the question rather than its subject: an
 * agent should look things up when it is being asked to, not when a keyword
 * list happens to fire.
 */
const ASKS_ABOUT_SOMETHING = [
  /\bwhat(?:'s| is| are| was| were)\b.{0,40}\b(?:this|that|it|going on|happening|about)\b/i,
  /\bwho(?:'s| is| are)\b/i,
  /\bany (?:news|update|info|information)\b/i,
  /\bwhat happened\b/i,
  /\bexplain\b/i,
  /\bcontext\b/i,
  /\bthoughts on\b/i,
  /\bis (?:this|it) (?:real|true|legit|a scam)\b/i,
];

/** Words that mean the answer changes by the day. */
const TIME_SENSITIVE = [
  /\b(?:today|tonight|this (?:morning|week|month)|just now|breaking|latest|current|right now|recently)\b/i,
  /\b(?:price|pump|dump|listing|airdrop|launch|hack|exploit|outage|announcement)\b/i,
];

export interface ResearchSubject {
  /** What the person said to the agent. */
  incoming: string;
  /** The post they were replying to, when there is one. */
  parent?: string | null;
  /**
   * Whether that parent is the agent's own post.
   *
   * When somebody replies to the agent, the parent *is* the agent's last reply,
   * and the fallback below treats the parent as the thing being asked about. So
   * an agent that had written "I'm an AI agent, I can't edit or fix websites."
   * then sent exactly that sentence to a search engine as a question, and read
   * the results back as evidence about the world.
   *
   * Own words are never evidence. The conversation already carries this as
   * `ContextPost.isSelf`; research simply never asked for it.
   */
  parentIsOwn?: boolean;
  /** Links found on either. */
  links?: string[];
  /** Whether anything on the branch had an image nobody could read. */
  hasUnreadMedia?: boolean;
}

/**
 * The separate things somebody asked in one message.
 *
 * People ask two questions at once and expect two answers. "what did he
 * roundtrip on? also whats the weather like in Chicago today" is a question
 * about a screenshot and a question about the weather, and treating it as one
 * subject gets neither: what actually happened was a web search for the parent
 * post's text, three articles about waking up at 3am, and no weather at all.
 *
 * Split on question marks, keeping the run of text before each one. A trailing
 * fragment with no question mark is kept only if it reads as a request --
 * "explain the fee change" is a question without the punctuation.
 */
export function questionsIn(text: string): string[] {
  const spoken = text
    .replace(/@[A-Za-z0-9_]{1,32}/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!spoken) return [];

  const questions: string[] = [];
  let cursor = 0;
  for (let i = 0; i < spoken.length; i += 1) {
    if (spoken[i] !== '?') continue;
    const clause = spoken.slice(cursor, i).trim();
    cursor = i + 1;
    if (clause) questions.push(...splitOnConnective(clause));
  }

  const tail = spoken.slice(cursor).trim();
  if (tail && IMPERATIVE_ASK.test(tail)) questions.push(...splitOnConnective(tail));
  // No punctuation anywhere, but the whole message is a request.
  if (questions.length === 0 && IMPERATIVE_ASK.test(spoken)) questions.push(spoken);

  return questions.filter((q) => q.split(/\s+/).filter(Boolean).length >= 2);
}

/** "also whats the weather" is a question; "also" is not part of it. */
function trimConnective(clause: string): string {
  return clause.replace(/^(?:and|also|plus|but|so|then|oh|btw|by the way)[,\s]+/i, '').trim();
}

/**
 * Two requests joined by "also", carrying one question mark between them.
 *
 * Splitting on punctuation alone assumes people punctuate each question, and
 * they do not. Somebody wrote "how are you feeling about this post, also could
 * you get me the weather details for new york city on septemeber 3rd?" -- one
 * mark, at the very end. That arrived as a single question, and because its
 * first half says "this post" the whole thing was discarded as referring to
 * something already on screen. The weather was never looked up and never
 * mentioned in the reply; the half that could be answered from the page
 * silenced the half that needed the web.
 *
 * So the connective splits a clause as well as being trimmed from its front.
 */
const CONNECTIVE = /[,;]?\s+(?:and\s+also|also|and then|plus|as well as|and)\s+(?=\S)/i;

function splitOnConnective(clause: string): string[] {
  const parts: string[] = [];
  let rest = trimConnective(clause);
  // Bounded: a message with fifty "and"s is not fifty questions.
  for (let guard = 0; guard < 4; guard += 1) {
    const at = rest.search(CONNECTIVE);
    if (at < 0) break;
    const head = rest.slice(0, at).trim();
    const tail = rest.slice(at).replace(CONNECTIVE, '').trim();
    // Only a split that leaves two things worth asking about is a split.
    if (head.split(/\s+/).length < 3 || tail.split(/\s+/).length < 3) break;
    parts.push(head);
    rest = tail;
  }
  parts.push(rest);
  return parts.filter(Boolean);
}

/**
 * A request phrased without a question mark.
 *
 * The polite forms matter as much as the blunt ones. "could you get me the
 * weather details for new york city on septemeber 3rd" is a request for current
 * information containing no interrogative word at all, so a gate looking only
 * for what/who/when/where let it through unresearched, and the reply answered
 * the other half of the message and said nothing about the weather.
 */
const IMPERATIVE_ASK =
  /\b(?:explain|tell me|what'?s|whats|how much|how many|any (?:news|update)|look up|check|(?:could|can|would|will) you|get me|give me|find me|send me|show me)\b/i;

/**
 * Turns one question into something worth asking an answer engine.
 *
 * The search behind this used to be a keyword engine, where pasting two hundred
 * characters of somebody's post was fine: more words, more overlap, more
 * results. An answer engine is not that. It reads the query as a question, and
 * a wall of text with no question in it gets a wall of text back.
 *
 * A question already phrased as one is passed through: "whats the weather like
 * in Chicago today" is exactly what a person would type. The "latest on" prefix
 * is only for a *subject* -- a post the agent was asked about, which is a topic
 * rather than a question -- where without it an answer engine happily
 * summarises something from two years ago.
 */
function asQuestion(subject: string, timeSensitive: boolean): string | null {
  const trimmed = subject.trim();
  if (!trimmed) return null;

  // Something already phrased as a question is the best query available: it is
  // what the person actually wants to know, in their own words.
  const firstSentence = trimmed.split(/(?<=[.!?])\s/)[0]!.trim() || trimmed;
  const core = (firstSentence.length > 120 ? firstSentence.slice(0, 120).replace(/\s\S*$/, '') : firstSentence).trim();
  if (READS_AS_QUESTION.test(core)) return core.endsWith('?') ? core : core + '?';

  // Otherwise: what is this *about*, not what did it say.
  //
  // This used to paste the first sentence behind "What is the latest on: ",
  // which is how a search engine was asked about "Absolutely WILD piece of tech
  // here." and "Windows is complete." Those are not questions and they have no
  // subject; the answers came back about whatever those words collocate with.
  //
  // A statement is worth researching when it names something. When it names
  // nothing, there is no query to build and the honest result is to look
  // nothing up, which is what returning null means.
  const subjects = namedSubjects(trimmed);
  if (subjects.length === 0) return null;

  const named = subjects.slice(0, 3).join(' ');
  return timeSensitive ? `${named} latest news` : named;
}

/**
 * The things a statement is about: names, tickers, quoted phrases, sites.
 *
 * Capitalised runs are taken from anywhere but the very first word, because
 * every sentence starts with a capital and "Absolutely" is not a subject. A
 * word in all caps is treated as shouting rather than as a name, for the same
 * reason "WHAT THE HELL" was being researched.
 */
/**
 * Words that are capitalised because a sentence started, not because they name
 * anything. Adverbs and openers, which is what social posts begin with.
 */
const OPENER = new Set([
  'absolutely', 'actually', 'obviously', 'honestly', 'seriously', 'literally', 'basically', 'apparently',
  'definitely', 'probably', 'maybe', 'clearly', 'finally', 'currently', 'recently', 'personally',
  'this', 'that', 'these', 'those', 'the', 'a', 'an', 'and', 'but', 'so', 'then', 'now', 'here', 'there',
  'what', 'when', 'where', 'who', 'why', 'how', 'which', 'if', 'is', 'are', 'was', 'were', 'it', 'its',
  'we', 'you', 'they', 'he', 'she', 'i', 'my', 'our', 'your', 'their', 'just', 'very', 'really', 'still',
  'every', 'some', 'any', 'all', 'no', 'not', 'yes', 'ok', 'okay', 'wow', 'nice', 'good', 'great', 'love',
  'holy', 'crazy', 'wild', 'insane', 'massive', 'huge', 'big', 'new', 'first', 'last', 'next', 'another',
]);

export function namedSubjects(text: string): string[] {
  const found: string[] = [];
  const add = (value: string) => {
    const cleaned = value.trim().replace(/\s+/g, ' ');
    if (!cleaned) return;
    if (!found.some((f) => f.toLowerCase() === cleaned.toLowerCase())) found.push(cleaned);
  };

  // Digits allowed after the first letter, or $AI17Z -- this project's own
  // ticker -- matches as far as "$AI" and then stops, which is no match at all.
  for (const match of text.matchAll(/\$[A-Za-z][A-Za-z0-9]{1,9}\b/g)) add(match[0]);
  for (const match of text.matchAll(/["“]([^"”]{3,60})["”]/g)) add(match[1]!);
  for (const match of text.matchAll(/\b[a-z0-9-]+\.(?:com|org|io|net|xyz|dev|ai|co)\b/gi)) add(match[0]);

  // Capitalised runs.
  //
  // The opening word of a sentence is capitalised whatever it is, so a run that
  // is only the first word is discarded -- that is what stopped "Absolutely" in
  // "Absolutely WILD piece of tech here." becoming a subject. But a run that
  // *continues* past the first word is a name: "Project Q announced a
  // migration" opens with the thing it is about, and dropping it because of
  // where it sits in the sentence loses the only subject there was.
  //
  // ALL CAPS is shouting, not a name, which is the other half of why "WHAT THE
  // HELL" was reaching a search engine.
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    const words = sentence.trim().split(/\s+/);
    let run: string[] = [];
    let runStartedAt = 0;

    const flush = () => {
      // A single capitalised word that opened the sentence is a name only if it
      // is not one of the words every sentence can start with. Position alone
      // was too blunt: it correctly threw away "Absolutely" and wrongly threw
      // away "Solana", and those are the same shape.
      const lone = run.length === 1;
      if (!lone || runStartedAt > 0 || !OPENER.has(run[0]!.toLowerCase())) {
        if (run.length > 0) add(run.join(' '));
      }
      run = [];
    };

    for (const [index, word] of words.entries()) {
      const bare = word.replace(/[^\p{L}\p{N}'-]/gu, '');
      // A name proper, or a single capital or number continuing one: the Q in
      // "Project Q", the 3 in "Layer 3".
      const isName = /^[A-Z][a-z'’-]{1,}$/.test(bare) && bare.length > 2;
      const continuesName = run.length > 0 && /^[A-Z0-9]$|^[A-Z][a-z]?$/.test(bare);

      if (isName || continuesName) {
        if (run.length === 0) runStartedAt = index;
        run.push(bare);
        continue;
      }
      flush();
    }
    flush();
  }

  return found;
}

/** Already phrased as a question, so it needs no framing. */
const READS_AS_QUESTION =
  /^(?:what|why|how|when|where|who|which|is|are|do|does|did|can|could|would|should|will|whats|whos)\b/i;

/** An interrogative. Necessary for a lookup, nowhere near sufficient. */
const INTERROGATIVE = /\b(?:what|who|when|where|which|how (?:much|many|old|far|long))\b/i;

/**
 * Words that name something checkable whatever the sentence around them.
 */
const FACT_WORD =
  /\b(?:weather|temperature|price|market ?cap|score|founded|launched|released|population|capital|deadline|rate|address|listed|hacked|exploit|outage)\b/i;

/**
 * Something in the question that a source could actually be asked about.
 *
 * An interrogative on its own is not enough, and treating it as enough is how
 * a conversation about a fee model produced a web search. "What happens to the
 * pairs that never migrated" is a question about an idea the two of them were
 * discussing; there is no page anywhere that answers it, and searching only
 * fills the prompt with something that sounds related.
 *
 * A name, a ticker, a number or a fact word is the difference. "Who founded
 * Solana" has a name. "What is the weather in Chicago" has both. "What happens
 * to the pairs that never migrated" has none of them, and the conversation is
 * the only place its answer lives.
 *
 * The capitalisation test misses a lowercase proper noun, which social media is
 * full of. That is the deliberate shape of this: the rules take the clear
 * cases, and the classifier model -- when the owner has configured one -- takes
 * the middle. Wrongly not searching costs a reply that says it does not know;
 * wrongly searching costs a reply built on something irrelevant.
 */
function namesSomethingCheckable(question: string): boolean {
  if (FACT_WORD.test(question)) return true;
  // A capitalised word that is not merely the first one.
  if (/\S\s+[A-Z][A-Za-z]{2,}/.test(question)) return true;
  if (/\$[A-Za-z]{2,10}\b/.test(question)) return true;
  // A number that is not part of a word: a year, an amount, a version.
  if (/(?:^|\s)\d[\d,.]*/.test(question)) return true;
  return false;
}

const ASKS_A_FACT = {
  // Either shape of asking counts. Requiring an interrogative word meant a
  // request had to be blunt to be researched, and people are not blunt: the
  // weather question that went unanswered was phrased "could you get me".
  // The checkable half of the test is what keeps this narrow -- a polite
  // request naming nothing in particular still does not reach the web.
  test: (question: string): boolean =>
    (INTERROGATIVE.test(question) || IMPERATIVE_ASK.test(question)) &&
    namesSomethingCheckable(question) &&
    !isOutburst(question),
};

/**
 * Text that is a reaction rather than a question.
 *
 * "WHAT THE HELL?!?" has an interrogative and a capitalised word, so it passed
 * both halves of the fact test and was sent to a search engine. So were "hey."
 * and "Right." -- each one a browser round trip on the research tab, returning
 * a dictionary entry and a Red Hot Chili Peppers video, which then entered the
 * prompt as evidence.
 *
 * The test is for an absence: no noun of its own to look up. Shouting is a
 * decent signal too, since somebody typing in capitals with three marks on the
 * end is not asking for a citation.
 */
const OUTBURST = /^(?:wow|whoa|woah|damn|lol|lmao|omg|wtf|what the (?:hell|f\w*)|huh|hey|hi|yo|sup|right|ok(?:ay)?|nice|cool|based|gm|gn|fr|bruh|man|dude|ah+|oh+|haha+)\b/i;

function isOutburst(text: string): boolean {
  const bare = text.replace(/[^\p{L}\p{N}\s'$]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!bare) return true;
  if (!OUTBURST.test(bare)) return false;
  // "hey what did the Fed do today" opens with a greeting and is still a
  // question, so an outburst only counts when nothing checkable follows it.
  const after = bare.replace(OUTBURST, '').trim();
  return !namesSomethingCheckable(after);
}

/**
 * What to look up, and why.
 *
 * Returns nothing for the ordinary case, which is most of them: an agent that
 * searches the web before every reply is slow, expensive, and no better at
 * answering "nice one".
 *
 * The order of business is: things named unambiguously in the text (a contract
 * address, a ticker) first; then each question the person actually asked; and
 * only if they asked nothing specific of their own, the subject of the post
 * they were replying to.
 *
 * That last fallback used to be the *only* behaviour, which is the failure this
 * exists to prevent. Asked "what did he roundtrip on? also whats the weather
 * like in Chicago today", it searched the parent post's text and came back with
 * three articles about waking up at 3am. Neither question was looked up. One of
 * them could not have been -- the answer was in an image -- and that is the
 * other half of the rule below.
 */
export function whatToResearch(subject: ResearchSubject, max = 3): Lookup[] {
  const lookups: Lookup[] = [];
  const haystack = subject.incoming + '\n' + (subject.parent ?? '');
  const seen = new Set<string>();

  const add = (lookup: Lookup) => {
    const key = lookup.kind + ':' + lookup.query.toLowerCase();
    if (seen.has(key) || lookups.length >= max) return;
    seen.add(key);
    lookups.push(lookup);
  };

  // A contract address is unambiguous and cheap to resolve, so it goes first
  // whatever else the message says.
  for (const match of haystack.matchAll(EVM_ADDRESS)) {
    add({ kind: 'token', query: match[0], reason: 'A contract address was mentioned.' });
  }
  for (const match of haystack.matchAll(SOLANA_ADDRESS)) {
    // Skip anything that is really a URL fragment or a status id.
    if (/^\d+$/.test(match[0])) continue;
    add({ kind: 'token', query: match[0], reason: 'A contract address was mentioned.' });
  }
  for (const match of haystack.matchAll(TICKER)) {
    add({ kind: 'token', query: match[1]!, reason: 'A ticker ($' + match[1] + ') was mentioned.' });
  }

  const asking = ASKS_ABOUT_SOMETHING.some((re) => re.test(subject.incoming));
  const timeSensitive = TIME_SENSITIVE.some((re) => re.test(haystack));

  // A link somebody is asking about is the most direct answer available.
  if (asking) {
    for (const link of subject.links ?? []) {
      add({ kind: 'link', query: link, reason: 'They asked about a link on the post.' });
    }
  }

  // Each question they actually asked, judged on its own.
  const questions = questionsIn(subject.incoming);
  let answeredSomething = false;
  for (const question of questions) {
    // A question about something on the page is not a question for the web.
    // "What did he roundtrip on" is answered by looking at the screenshot; a
    // search engine can only return something else that sounds similar, and it
    // will, confidently.
    if (refersToSomethingElse(question) && (subject.hasUnreadMedia || subject.parent)) continue;

    // Not everything with a question mark needs the internet. "you around?"
    // does not, and neither does "worth it?". Two conditions together: long
    // enough to name its own subject, and either current or a matter of fact.
    if (question.split(/\s+/).filter(Boolean).length < 3) continue;
    const questionIsTimely = TIME_SENSITIVE.some((re) => re.test(question));
    if (!questionIsTimely && !ASKS_A_FACT.test(question)) continue;

    const query = asQuestion(question, questionIsTimely);
    if (!query) continue;
    add({
      kind: 'search',
      query,
      reason: questionIsTimely
        ? 'They asked something whose answer changes by the day.'
        : 'They asked something with an answer that exists somewhere.',
    });
    answeredSomething = true;
  }

  // Only if they asked nothing specific of their own. "What is this about?"
  // has no subject in it -- the subject is the post above.
  if (!answeredSomething && (asking || timeSensitive)) {
    // A post whose substance is a picture has no subject in its text, and
    // searching the words around a picture returns whatever those words happen
    // to collocate with. That is how "Nothing as waking up on a 30k roundtrip
    // during sleep GM" became three articles about waking at 3am.
    if (subject.hasUnreadMedia && !asking) return lookups;

    // This whole branch means "they asked about the post above rather than
    // about anything in their own message". When the post above is ours there
    // is no subject here at all: the referent of "what about that?" is the
    // agent's own last sentence, and neither it nor the vague question that
    // points at it is something to send to a search engine.
    //
    // Anything genuinely checkable in their message was already handled by the
    // questions loop, which does not depend on this branch.
    if (subject.parentIsOwn && subject.parent) return lookups;

    const subjectText = (subject.parent ?? subject.incoming)
      .replace(/@[A-Za-z0-9_]{1,15}/g, ' ')
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (subjectText.split(' ').filter(Boolean).length >= 3 && !isOutburst(subjectText)) {
      const query = asQuestion(subjectText, timeSensitive);
      if (query) add({
        kind: 'search',
        query,
        reason: asking
          ? 'They asked what this is about, and the answer is not in the post.'
          : 'The subject changes by the day, so a trained answer would be out of date.',
      });
    }
  }

  return lookups;
}

// ── DexScreener ──────────────────────────────────────────────────────────────

export interface DexPair {
  chainId?: string;
  dexId?: string;
  url?: string;
  baseToken?: { name?: string; symbol?: string; address?: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
  fdv?: number;
  volume?: { h24?: number };
  priceChange?: { h24?: number };
  pairCreatedAt?: number;
}

function formatUsd(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return 'unknown';
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}k`;
  return `$${value.toFixed(2)}`;
}

/**
 * Looks a token up on DexScreener.
 *
 * No key, no account, no configuration — which is why it is the one market
 * source wired in by default.
 *
 * The price is the *median* across pairs, not the price on the deepest one.
 * That is not fussiness: the deepest UNI pair on DexScreener is UNI/SASHIMI,
 * which reports $5,178,076 a token against a real price of $5.18. One
 * manipulated or broken pair can top the liquidity table; it cannot move a
 * median. Liquidity is summed across pairs for the same reason.
 */
export async function lookupToken(query: string, timeoutMs = 8_000): Promise<Finding | null> {
  const cleaned = query.replace(/^\$/, '');
  const isAddress = /^(?:0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/.test(cleaned);
  // The dedicated endpoint for an address returns only that token's pairs.
  // `search` matches either side, which is how a query for a token comes back
  // with pairs where it is the quote asset and the price belongs to something
  // else entirely.
  const url = isAddress
    ? `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(cleaned)}`
    : `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(cleaned)}`;

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return null;

    const body = (await response.json()) as { pairs?: DexPair[] };
    let pairs = (body.pairs ?? []).filter((p) => (p.liquidity?.usd ?? 0) > 0);
    if (pairs.length === 0) return null;

    const chosen = choosePair(pairs, isAddress ? null : cleaned);
    if (!chosen) return null;
    const { best, price, totalLiquidity, totalVolume, pairCount, oldest, ambiguous } = chosen;
    const name = best.baseToken?.name ?? best.baseToken?.symbol ?? cleaned;
    const symbol = best.baseToken?.symbol ? `$${best.baseToken.symbol}` : '';
    const change = best.priceChange?.h24;

    const parts = [
      `price $${formatPrice(price)}`,
      change !== undefined ? `${change > 0 ? '+' : ''}${change}% over 24h` : null,
      `liquidity ${formatUsd(totalLiquidity)} across ${pairCount} pair${pairCount === 1 ? '' : 's'}`,
      totalVolume > 0 ? `24h volume ${formatUsd(totalVolume)}` : null,
      best.fdv !== undefined ? `FDV ${formatUsd(best.fdv)}` : null,
      best.chainId ? `on ${best.chainId}` : null,
      // Age matters more than any other number for a token somebody is asking
      // about in a reply, and it is the one nobody volunteers.
      oldest ? `first pair created ${describeAge(oldest)}` : null,
      // The address, because a ticker is not an identity and somebody reading
      // the reply may want to check which token this actually was.
      best.baseToken?.address ? `contract ${best.baseToken.address}` : null,
      ambiguous > 0
        ? `${ambiguous} other token${ambiguous === 1 ? '' : 's'} use this ticker; this is the most traded one`
        : null,
    ].filter(Boolean);

    return {
      kind: 'token',
      query,
      source: 'DexScreener',
      title: `${name} ${symbol}`.trim(),
      summary: parts.join(', '),
      url: best.url ?? null,
      retrievedAt: new Date().toISOString(),
    };
  } catch (error) {
    log.debug('token lookup failed', { query, message: errorMessage(error) });
    return null;
  }
}

export interface ChosenPair {
  best: DexPair;
  price: number;
  totalLiquidity: number;
  totalVolume: number;
  pairCount: number;
  oldest: number | undefined;
  /** How many other tokens share this ticker. Zero for an address lookup. */
  ambiguous: number;
}

/**
 * Picks which pair, and which price, actually answers the question.
 *
 * Two real failures shaped this, both found against the live API:
 *
 *   - The deepest UNI pair on DexScreener is UNI/SASHIMI, reporting $5,178,076
 *     a token against a real price of $5.18. One manipulated or broken pair can
 *     top the liquidity table; it cannot move a median.
 *   - A search for $WIF returns twenty different tokens using that ticker. The
 *     answer came back as an impostor with $26k of liquidity. Anyone can mint a
 *     token called anything, so a ticker is not an identity: group by contract
 *     and take the deepest group, then say how many others there were.
 *
 * `symbol` is null for an address lookup, where neither problem arises.
 */
export function choosePair(pairs: DexPair[], symbol: string | null): ChosenPair | null {
  let candidates = pairs.filter((p) => (p.liquidity?.usd ?? 0) > 0);
  if (candidates.length === 0) return null;

  let ambiguous = 0;
  if (symbol) {
    const wanted = symbol.toLowerCase().replace(/^\$/, '');
    const priced = candidates.filter((p) => p.baseToken?.symbol?.toLowerCase() === wanted);
    if (priced.length > 0) candidates = priced;

    // Anyone can mint a token called anything, so a ticker is not an identity:
    // group by contract and pick one group.
    const byAddress = new Map<string, DexPair[]>();
    for (const pair of candidates) {
      const key = pair.baseToken?.address?.toLowerCase() ?? 'unknown';
      byAddress.set(key, [...(byAddress.get(key) ?? []), pair]);
    }
    if (byAddress.size > 1) {
      ambiguous = byAddress.size - 1;
      // Ranked by traded volume rather than by claimed liquidity. Liquidity is a
      // number in a pool and can be inflated for nothing; volume is trades that
      // had to happen. A search for $UNI returned a Solana token claiming $6.6B
      // of liquidity against $3.99 of daily volume, and won on liquidity.
      candidates = [...byAddress.values()].sort(compareGroups)[0]!;
    }
  }

  // A pool nobody trades in is not price discovery. Pairs that do trade set the
  // price; if none of them do, they are all we have and the price is whatever
  // they say, which at least is not a lie about being busy.
  const traded = candidates.filter((p) => (p.volume?.h24 ?? 0) >= MIN_MEANINGFUL_VOLUME_USD);
  const pricing = traded.length > 0 ? traded : candidates;

  const withPrice = pricing
    .map((pair) => ({ pair, price: Number(pair.priceUsd) }))
    .filter((p) => Number.isFinite(p.price) && p.price > 0)
    .sort((a, b) => a.price - b.price);
  if (withPrice.length === 0) return null;

  const median = withPrice[Math.floor(withPrice.length / 2)]!;
  return {
    best: median.pair,
    price: median.price,
    totalLiquidity: candidates.reduce((sum, p) => sum + (p.liquidity?.usd ?? 0), 0),
    totalVolume: candidates.reduce((sum, p) => sum + (p.volume?.h24 ?? 0), 0),
    pairCount: candidates.length,
    oldest: candidates
      .map((p) => p.pairCreatedAt)
      .filter((t): t is number => typeof t === 'number')
      .sort((a, b) => a - b)[0],
    ambiguous,
  };
}

/**
 * Below this, a pair is not trading and its price means nothing.
 *
 * A hundred dollars a day is a very low bar deliberately: it is meant to
 * exclude pools with no activity at all, not to judge small tokens.
 */
const MIN_MEANINGFUL_VOLUME_USD = 100;

/**
 * Which of two tokens sharing a ticker is the one being asked about.
 *
 * Compared in order rather than scored, because these are unbounded numbers and
 * any weighted sum either caps one of them or lets it drown the others.
 *
 *   1. 24h volume, because it is expensive to fake: it is trades that had to
 *      happen. A Solana token claiming $6.6B of liquidity against $3.99 of
 *      daily volume beat the real Uniswap on liquidity alone.
 *   2. How many venues it trades in, because a token people hold trades in
 *      several.
 *   3. Liquidity, last, as the tie-break for when nothing has traded — which is
 *      the only case where the number that gets inflated is the best available.
 */
function compareGroups(a: DexPair[], b: DexPair[]): number {
  const sum = (pairs: DexPair[], pick: (p: DexPair) => number) => pairs.reduce((total, p) => total + pick(p), 0);

  const byVolume = sum(b, (p) => p.volume?.h24 ?? 0) - sum(a, (p) => p.volume?.h24 ?? 0);
  if (byVolume !== 0) return byVolume;

  const byVenues = b.length - a.length;
  if (byVenues !== 0) return byVenues;

  return sum(b, (p) => p.liquidity?.usd ?? 0) - sum(a, (p) => p.liquidity?.usd ?? 0);
}

/** Prices span nine orders of magnitude, so the useful precision moves. */
function formatPrice(value: number): string {
  if (value >= 1) return value.toFixed(2);
  if (value >= 0.01) return value.toFixed(4);
  return value.toPrecision(3);
}

function describeAge(createdAtMs: number): string {
  const days = Math.floor((Date.now() - createdAtMs) / 86_400_000);
  if (days < 1) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  if (days < 365) return `${Math.floor(days / 30)} months ago`;
  return `${Math.floor(days / 365)} years ago`;
}

// ── Putting it together ──────────────────────────────────────────────────────

/** Supplied by the caller, because searching needs a browser and this is pure. */
export type SearchFn = (query: string) => Promise<Finding[]>;

export interface ResearchOptions {
  search?: SearchFn;
  /**
   * Everything the conversation said about which token is meant: the mention,
   * the post above it, the quoted post.
   *
   * A ticker on its own is not an identity, and the chain is usually mentioned
   * a post earlier than the ticker is.
   */
  tokenContext?: string;
  /** Addresses this agent was given, which settle a question about its own token. */
  knownAddresses?: readonly string[];
}

export async function research(lookups: Lookup[], options: ResearchOptions = {}): Promise<ResearchResult> {
  const findings: Finding[] = [];
  const failed: { query: string; reason: string }[] = [];

  for (const lookup of lookups) {
    if (lookup.kind === 'token') {
      // Resolve rather than look up: what came back has to be the token that
      // was meant, and "several tokens use this ticker" is a real answer.
      const reference = mergeReferences(
        parseTokenReference(lookup.query),
        parseTokenReference(options.tokenContext ?? ''),
      );
      const resolution = await resolveToken(reference, { knownAddresses: options.knownAddresses });

      if (resolution.status === 'NOT_FOUND') {
        failed.push({ query: lookup.query, reason: resolution.how });
        continue;
      }
      findings.push({
        kind: 'token',
        query: lookup.query,
        source: 'DexScreener',
        title:
          resolution.status === 'AMBIGUOUS'
            ? `${lookup.query}: more than one token`
            : `${resolution.facts!.name}${resolution.facts!.symbol ? ` $${resolution.facts!.symbol}` : ''}`,
        summary: describeToken(resolution),
        url: resolution.facts?.url ?? null,
        retrievedAt: new Date().toISOString(),
      });
      continue;
    }

    if (!options.search) {
      failed.push({ query: lookup.query, reason: 'No browser was available to search with.' });
      continue;
    }
    try {
      const results = await options.search(lookup.query);
      if (results.length > 0) findings.push(...results);
      else failed.push({ query: lookup.query, reason: 'The search returned nothing usable.' });
    } catch (error) {
      failed.push({ query: lookup.query, reason: errorMessage(error) });
    }
  }

  const note =
    findings.length > 0
      ? `Looked up ${findings.length} thing${findings.length === 1 ? '' : 's'}${failed.length > 0 ? `, ${failed.length} failed` : ''}.`
      : failed.length > 0
        ? `Tried to look up ${failed.length} thing${failed.length === 1 ? '' : 's'} and could not.`
        : 'Nothing needed looking up.';

  return { findings, failed, note };
}

/**
 * How findings are put to the model.
 *
 * Attributed, dated, and framed as something a source said rather than as
 * something the agent knows. An agent that launders a search result into its
 * own voice will state a wrong one just as confidently as a right one.
 */
export function renderResearch(result: ResearchResult): string {
  if (result.findings.length === 0 && result.failed.length === 0) return '';

  const lines: string[] = [];
  for (const finding of result.findings) {
    lines.push(`${finding.source} — ${finding.title}`);
    if (finding.summary) lines.push(`  ${finding.summary}`);
    if (finding.url) lines.push(`  ${finding.url}`);
  }

  if (result.failed.length > 0) {
    lines.push('');
    lines.push(
      `Could not check: ${result.failed.map((f) => f.query.slice(0, 60)).join('; ')}. Say you do not know rather than guessing.`,
    );
  }

  lines.push('');
  lines.push(
    'This was looked up just now and is not something you knew. Use it if it answers the question, ' +
      'say where it came from if the number matters, and do not repeat any of it as your own knowledge.',
  );
  return lines.join('\n');
}
