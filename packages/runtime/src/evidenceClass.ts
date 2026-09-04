/**
 * What an answer is actually resting on.
 *
 * Not a confidence score. A number invites the model to produce a number, and
 * a fabricated 0.87 is worse than nothing because it looks like measurement.
 * This is a category, derived from what the pipeline actually gathered for this
 * job, and it exists to answer one question before the model writes anything:
 * is there something behind this, and what.
 *
 * The useful cases are the two ends. MULTI_SOURCE says several independent
 * things agreed, which is worth saying plainly. UNCERTAIN says nothing was
 * found -- and an agent that knows it found nothing can say so, where one that
 * does not will fill the gap confidently.
 *
 * Pure, and derived from evidence rather than asserted by the model. Asking a
 * model how well-founded its own answer is gets you the answer it would like to
 * be true.
 */

export const EVIDENCE_CLASSES = [
  /** The conversation itself contained the answer. */
  'KNOWN_FROM_CONTEXT',
  /** Retrieved from documentation the owner attached. */
  'KNOWN_FROM_PROJECT',
  /** Looked up on the open web, a moment ago. */
  'CURRENT_RESEARCH',
  /** Prices, liquidity, pairs. */
  'MARKET_DATA',
  /** Something this agent remembered about this person or subject. */
  'MEMORY',
  /** More than one of the above, independently. */
  'MULTI_SOURCE',
  /** Nothing was found. The most important one, and the easiest to skip. */
  'UNCERTAIN',
] as const;
export type EvidenceClass = (typeof EVIDENCE_CLASSES)[number];

export interface EvidenceInput {
  /** Whether the incoming message and its thread carry the subject. */
  hasConversationContext: boolean;
  /** Passages retrieved from attached documentation. */
  projectPassages: number;
  /** Findings from the open web. */
  webFindings: number;
  /** Findings from a market source. */
  marketFindings: number;
  /** Memories retrieved and actually put in the prompt. */
  memories: number;
  /** Lookups that were attempted and did not work. */
  failedLookups: number;
}

export interface EvidenceVerdict {
  evidence: EvidenceClass;
  /** What it rests on, in the words the trace and Activity will show. */
  reason: string;
  /**
   * Whether the answer should say it does not know.
   *
   * True when something was asked for and nothing came back -- which is the
   * case an agent gets wrong by default, because a model with no evidence
   * writes exactly as confidently as one with plenty.
   */
  shouldAdmitUncertainty: boolean;
}

/** The sources that actually produced something, most specific first. */
function present(input: EvidenceInput): EvidenceClass[] {
  const found: EvidenceClass[] = [];
  if (input.marketFindings > 0) found.push('MARKET_DATA');
  if (input.webFindings > 0) found.push('CURRENT_RESEARCH');
  if (input.projectPassages > 0) found.push('KNOWN_FROM_PROJECT');
  if (input.memories > 0) found.push('MEMORY');
  if (input.hasConversationContext) found.push('KNOWN_FROM_CONTEXT');
  return found;
}

const WORDS: Record<EvidenceClass, string> = {
  KNOWN_FROM_CONTEXT: 'what was said in this conversation',
  KNOWN_FROM_PROJECT: 'documentation this agent has been given',
  CURRENT_RESEARCH: 'something looked up a moment ago',
  MARKET_DATA: 'market data',
  MEMORY: 'something this agent remembered',
  MULTI_SOURCE: 'several independent sources',
  UNCERTAIN: 'nothing',
};

export function classifyEvidence(input: EvidenceInput): EvidenceVerdict {
  const sources = present(input);

  if (sources.length === 0) {
    return {
      evidence: 'UNCERTAIN',
      reason:
        input.failedLookups > 0
          ? `${input.failedLookups} lookup(s) were tried and none of them worked, so there is nothing behind this.`
          : 'Nothing was retrieved, so anything specific here would be invented.',
      // The whole point. A model with no evidence writes exactly as confidently
      // as one with plenty, so this is where it has to be told to say so.
      shouldAdmitUncertainty: true,
    };
  }

  // Conversation context alone is not corroboration -- it is the question
  // restated. Two *retrieved* sources agreeing is worth saying; a thread plus
  // one lookup is just the lookup.
  const retrieved = sources.filter((s) => s !== 'KNOWN_FROM_CONTEXT');
  if (retrieved.length > 1) {
    return {
      evidence: 'MULTI_SOURCE',
      reason: `Rests on ${retrieved.map((s) => WORDS[s]).join(' and ')}.`,
      shouldAdmitUncertainty: false,
    };
  }

  const primary = sources[0]!;
  return {
    evidence: primary,
    reason: `Rests on ${WORDS[primary]}.`,
    // Something was asked for and nothing came back, even though something else
    // did: the gap is real and the answer should not paper over it.
    shouldAdmitUncertainty: input.failedLookups > 0,
  };
}
