/**
 * Whether a message can be understood on its own.
 *
 * There were two copies of this and both were a word count: eight words or more
 * and the post was assumed to carry its own meaning, so nothing bothered
 * looking at the image above it.
 *
 * That is wrong in a way that produced a real, visible failure. Somebody
 * replied to a screenshot of a trade with:
 *
 *   "@agent what did he roundtrip on? also whats the weather like in Chicago today"
 *
 * Thirteen words, so it "stood alone", so the parent's image was never read,
 * so the one thing that could answer the question was never looked at. The
 * agent then searched the web for the parent's *text* -- "Nothing as waking up
 * on a 30k roundtrip during sleep GM" -- and came back with three articles
 * about waking at 3am.
 *
 * Length was never the question. "He" has no antecedent in that sentence. A
 * message that points outside itself needs what it points at, however long it
 * is, and a message that does not can be answered as written.
 */

/**
 * Pronouns that stand in for somebody or something not named here.
 *
 * Only counted when nothing in the message could be what they refer to -- see
 * `hasAntecedent`. "How much did Solana raise in its seed round" contains "its"
 * and needs nothing outside itself.
 */
const PRONOUN = /\b(?:he|she|they|him|her|them|his|hers|their|theirs|it|its)\b/i;

/**
 * Demonstratives standing on their own rather than introducing a noun.
 *
 * "this about", "that says", "is that real" all point outwards. "this week"
 * and "that price" carry their own subject and are left alone.
 */
const DEMONSTRATIVE = [
  /\b(?:this|that|these|those)\s*(?:[?!.,]|$)/i,
  /\b(?:this|that|these|those)\s+(?:is|are|was|were|about|on|in|for|with|from|at|to|one|thing|guy|looks?|means?|says?|shows?|happened)\b/i,
  // A copula in front: "is that real", "are those genuine".
  /\b(?:is|are|was|were|isn't|aren't)\s+(?:this|that|these|those)\b/i,
];

/** Naming the attachment, however it is determined. */
const NAMES_ATTACHMENT =
  /\b(?:the|this|that|his|her|their|your)\s+(?:chart|image|picture|photo|screenshot|graph|video|clip|post|thread|article|link|meme|table)\b/i;

/** Pointing at the layout rather than at a word. */
const DEIXIS = /\b(?:above|below|attached|pictured|shown)\b/i;

/** Strips the parts of a post that are addressing rather than saying. */
export function spokenPart(text: string): string {
  return text
    .replace(/@[A-Za-z0-9_]{1,32}/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Whether something earlier in the message could be what the pronoun means.
 *
 * A proper noun or a ticker before the pronoun is almost always its antecedent:
 * "how much did Solana raise in its seed round" answers its own "its". Without
 * this the possessives make every second sentence look like it needs an image.
 *
 * Approximate on purpose, and wrong in the safe direction: a missed antecedent
 * costs one extra look at an image that was there anyway, while a missed
 * reference costs an answer to the wrong question.
 */
function hasAntecedent(spoken: string, pronounIndex: number): boolean {
  const before = spoken.slice(0, pronounIndex);
  // Capitalised, but not merely the first word of the sentence.
  if (/\S\s+[A-Z][a-z]{2,}/.test(before)) return true;
  if (/\$[A-Za-z]{2,10}\b/.test(before)) return true;
  return false;
}

/**
 * True when the message names something it does not contain.
 *
 * Exported because two different layers need the same answer: the channel
 * adapter, deciding whether to spend a DOM pass reading the parent's
 * attachments, and the runtime, deciding whether failing to read them should
 * stop a reply.
 */
export function refersToSomethingElse(text: string): boolean {
  const spoken = spokenPart(text);
  if (!spoken) return false;

  if (DEMONSTRATIVE.some((pattern) => pattern.test(spoken))) return true;
  if (NAMES_ATTACHMENT.test(spoken)) return true;
  if (DEIXIS.test(spoken)) return true;

  // A pronoun only makes a message dependent when the message is asking about
  // what it stands for. "What did he roundtrip on" cannot be answered without
  // knowing who he is; "I still think the schedule is the weak point, whatever
  // they announce" is a complete thought that happens to contain a pronoun, and
  // treating it as incomplete would send every substantial post looking for an
  // image that is not there.
  if (!ASKS(spoken)) return false;
  const pronoun = PRONOUN.exec(spoken);
  return pronoun ? !hasAntecedent(spoken, pronoun.index) : false;
}

/** Whether the message is asking rather than saying. */
function ASKS(spoken: string): boolean {
  return (
    spoken.includes('?') ||
    /^(?:what|why|how|when|where|who|which|is|are|do|does|did|can|could|would|should|will|whats|whos|tell me|explain)\b/i.test(
      spoken,
    )
  );
}

/**
 * Whether the text alone is enough to answer.
 *
 * Two conditions, and the referring one comes first because it does not care
 * how long the message is. The word count still does useful work underneath:
 * "thoughts?" under a chart is a question about the chart even though it names
 * nothing.
 */
export function textStandsAlone(text: string): boolean {
  if (refersToSomethingElse(text)) return false;
  return spokenPart(text).split(/\s+/).filter(Boolean).length >= 8;
}
