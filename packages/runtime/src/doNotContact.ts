/**
 * Somebody asking to be left alone.
 *
 * Deterministic and deliberately so. "Did they ask us to stop" is exactly the
 * judgement an owner most needs to be able to inspect and correct, and a model
 * deciding it would be a judgement nobody could audit, that costs a call, and
 * that answers differently on Tuesday. The same reasoning `salience.ts` gives
 * for not letting a model decide what is worth attending to.
 *
 * It is also the one judgement here where a false negative is far worse than a
 * false positive. Missing it means continuing to approach somebody who asked
 * twice; over-reading it means leaving somebody alone who did not quite mean
 * it, and the agent can still answer them when they write in.
 */

/**
 * Phrases that are a request to stop, not a complaint.
 *
 * Every one of these has to be unambiguous on its own, because a person who is
 * annoyed says all sorts of things and only some of them are an instruction.
 * "This is annoying" is not on the list. "Stop replying to me" is.
 *
 * Apostrophes are matched loosely, because somebody typing on a phone gets a
 * typographic one and somebody on a keyboard gets a straight one, and a list
 * that only matches one of them matches neither reliably.
 */
const ASKED_TO_STOP: RegExp[] = [
  /\bstop (replying|responding|messaging|tagging|mentioning|contacting|talking to)\b/i,
  /\b(do ?n.?t|dont|please don.?t) (reply|respond|message|tag|mention|contact|talk) (to )?me\b/i,
  /\b(do ?n.?t|dont) (ever )?(reply|respond|message|tag|mention|contact) me (again|ever)\b/i,
  /\bleave me alone\b/i,
  /\b(un|stop )?(tagging|mentioning) me\b.*\b(stop|please)\b/i,
  /\bremove me from\b.*\b(this|your)\b/i,
  /\bnot interested\b.*\b(stop|again|anymore|any more)\b/i,
  /\bblock(ed)? (you|this (bot|account))\b/i,
  /\bstop\b.{0,12}\b(bot|spamming|spam)\b/i,
  /\bopt(ing)? out\b/i,
];

/**
 * Things that look like the above and are not.
 *
 * Checked first, because the cost of getting this wrong is an agent that
 * silently stops talking to somebody who was being friendly. "Stop it, that is
 * too funny" is not an instruction, and neither is somebody quoting the phrase
 * to talk about it.
 */
const NOT_AN_INSTRUCTION: RegExp[] = [
  /\bstop it\b/i,
  /\b(can|could|would) ?n.?t stop\b/i,
  /\bnever stop\b/i,
  /\bdon.?t stop\b/i,
  /\bstop (me|us|him|her|them|it) if\b/i,
  // Somebody describing the feature rather than using it.
  /\b(if|when|should) (you|someone|somebody|anyone) (say|says|said|ask)\b/i,
];

export interface StopRequest {
  /** The matched sentence, trimmed, so the decision can be checked. */
  evidence: string;
  /** Which rule matched, for the panel. */
  reason: string;
}

/**
 * Whether this message asks the agent to stop.
 *
 * Returns the evidence rather than a boolean, because a durable record that
 * somebody asked to be left alone is worth nothing if nobody can see what they
 * actually wrote.
 */
export function asksToBeLeftAlone(text: string | null | undefined): StopRequest | null {
  if (!text) return null;
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return null;

  // Sentence by sentence, so a stop request buried in a longer message is
  // still found, and so the evidence is the sentence rather than the essay.
  const sentences = clean.split(/(?<=[.!?])\s+|\n+/).filter(Boolean);
  for (const sentence of sentences.length > 0 ? sentences : [clean]) {
    if (NOT_AN_INSTRUCTION.some((pattern) => pattern.test(sentence))) continue;
    const matched = ASKED_TO_STOP.find((pattern) => pattern.test(sentence));
    if (matched) {
      return {
        evidence: sentence.slice(0, 240),
        reason: 'They asked this agent to stop contacting them.',
      };
    }
  }
  return null;
}
