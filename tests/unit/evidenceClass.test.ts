import { describe, expect, it } from 'vitest';
import { classifyEvidence, type EvidenceInput } from '@xbam/runtime';

const nothing: EvidenceInput = {
  hasConversationContext: false,
  projectPassages: 0,
  webFindings: 0,
  marketFindings: 0,
  memories: 0,
  failedLookups: 0,
};
const evidence = (over: Partial<EvidenceInput> = {}) => classifyEvidence({ ...nothing, ...over });

/**
 * Not a confidence score. A number invites the model to produce a number, and a
 * fabricated 0.87 is worse than nothing because it looks like measurement.
 *
 * The two ends are what matter: several independent sources agreeing is worth
 * saying plainly, and nothing at all is the case an agent gets wrong by
 * default, because a model with no evidence writes exactly as confidently as
 * one with plenty.
 */
describe('what an answer rests on', () => {
  it('says uncertain when nothing was found, and says to admit it', () => {
    const verdict = evidence();
    expect(verdict.evidence).toBe('UNCERTAIN');
    expect(verdict.shouldAdmitUncertainty).toBe(true);
  });

  it('says so when lookups were tried and all failed', () => {
    // Different from never having looked: something was asked for and the
    // answer is not available, which is worth stating rather than papering over.
    const verdict = evidence({ failedLookups: 3 });
    expect(verdict.evidence).toBe('UNCERTAIN');
    expect(verdict.reason).toContain('3 lookup');
  });

  it('names the single source when there is one', () => {
    expect(evidence({ webFindings: 2 }).evidence).toBe('CURRENT_RESEARCH');
    expect(evidence({ marketFindings: 1 }).evidence).toBe('MARKET_DATA');
    expect(evidence({ projectPassages: 4 }).evidence).toBe('KNOWN_FROM_PROJECT');
    expect(evidence({ memories: 2 }).evidence).toBe('MEMORY');
    expect(evidence({ hasConversationContext: true }).evidence).toBe('KNOWN_FROM_CONTEXT');
  });

  it('calls it multi-source only when sources were actually retrieved', () => {
    expect(evidence({ webFindings: 1, marketFindings: 1 }).evidence).toBe('MULTI_SOURCE');
    expect(evidence({ projectPassages: 1, memories: 1 }).evidence).toBe('MULTI_SOURCE');
  });

  it('does not count the conversation as corroboration', () => {
    // The thread is the question restated, not a second source agreeing. A
    // thread plus one lookup is just the lookup, and calling it multi-source
    // would make the weakest answers look like the strongest.
    const verdict = evidence({ hasConversationContext: true, webFindings: 1 });
    expect(verdict.evidence).toBe('CURRENT_RESEARCH');
  });

  it('prefers market data over research when both are present as the single source', () => {
    // Only one retrieved source here, and it is the more specific one.
    expect(evidence({ marketFindings: 2, hasConversationContext: true }).evidence).toBe('MARKET_DATA');
  });

  it('still asks for a caveat when one source worked and another did not', () => {
    // The gap is real even though something came back, and an answer that
    // silently drops the part it could not find is the confident wrong one.
    const verdict = evidence({ webFindings: 1, failedLookups: 2 });
    expect(verdict.shouldAdmitUncertainty).toBe(true);
  });

  it('asks for no caveat when everything asked for came back', () => {
    expect(evidence({ webFindings: 2 }).shouldAdmitUncertainty).toBe(false);
  });

  it('explains itself in words, because a category alone tells nobody anything', () => {
    expect(evidence({ webFindings: 1 }).reason).toContain('looked up');
    expect(evidence({ marketFindings: 1, projectPassages: 1 }).reason).toContain('and');
  });
});
