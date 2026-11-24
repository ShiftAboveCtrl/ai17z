import {
  GOAL_END_REASON_MAX, GOAL_END_REASON_MIN, GOAL_FACT_MAX_CHARS, GOAL_FACT_TTL_MS, GOAL_HINT_MAX_CHARS,
  GOAL_RESUME_MAX_FACTS, type GoalAttemptState, type GoalFact, type GoalProposedEnd, type GoalResume,
} from '@xbam/shared/contracts';
import { fenceUntrusted, UNTRUSTED_PREAMBLE } from './researchFabric';

/*
  What a goal carries from one wake to the next, and nothing else.

  A fact is built by code from the fields a capability returned after its own
  schema accepted them. No model sentence is copied in, so the checkpoint cannot
  carry a model's reasoning or a model's claim about what it found. What a
  capability returned can still hold somebody else's text, so every fact is
  rendered back inside the evidence fence and never as an instruction.
*/

/** The stored checkpoint stays under the database cap with room for its punctuation. */
const RESUME_TARGET_BYTES = 1_700;
const MIN_ATTEMPT_DELAY_MS = 2 * 60 * 60 * 1000;
const MAX_BACKOFF = 8;
/** Attempts in a row that found nothing new before the agent proposes to stop. */
export const QUIET_ATTEMPTS_BEFORE_ABANDON = 5;
export const QUIET_ABANDON_REASON = 'Five attempts in a row found nothing new, so it stopped trying.';
export const WRITE_UNCERTAIN_REASON = 'A write may or may not have happened; the owner must check.';

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F]/g;

function oneLine(text: string, max: number): string {
  return text.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();
}

function bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/** Top-level scalar fields in key order, so the same output always gives the same line. */
export function factFromOutput(
  capabilityId: string, output: unknown, atAttempt: number, now: number,
): GoalFact | null {
  if (output === null || typeof output !== 'object' || Array.isArray(output)) return null;
  const parts: string[] = [];
  for (const key of Object.keys(output).sort()) {
    const value = (output as Record<string, unknown>)[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      parts.push(`${key}: ${String(value)}`);
    } else if (Array.isArray(value)) {
      parts.push(`${key}: ${value.length} item${value.length === 1 ? '' : 's'}`);
    }
  }
  const summary = oneLine(parts.join('; '), GOAL_FACT_MAX_CHARS);
  if (!summary) return null;
  return { capabilityId, atAttempt, at: new Date(now).toISOString(), summary };
}

/** Facts still worth showing. A fact with an unreadable date is dropped. */
export function liveFacts(facts: readonly GoalFact[], now: number): GoalFact[] {
  return facts.filter(fact => {
    const at = Date.parse(fact.at);
    return Number.isFinite(at) && now - at < GOAL_FACT_TTL_MS;
  });
}

const sameFact = (a: GoalFact, b: GoalFact) => a.capabilityId === b.capabilityId && a.summary === b.summary;

/**
 * The next checkpoint. `added` counts facts no earlier live fact already held,
 * which is what resets the backoff: the same answer twice is not progress.
 */
export function buildResume(input: {
  prior: GoalResume | null; fresh: readonly GoalFact[]; attemptNo: number;
  hint: string; outcome: GoalAttemptState; now: number;
}): { resume: GoalResume; added: number } {
  const kept = liveFacts(input.prior?.facts ?? [], input.now);
  let added = 0;
  const merged = [...kept];
  for (const fact of input.fresh) {
    const at = merged.findIndex(held => sameFact(held, fact));
    if (at === -1) added += 1;
    else merged.splice(at, 1);
    merged.push(fact);
  }
  let facts = merged.slice(-GOAL_RESUME_MAX_FACTS);
  const resume = (): GoalResume => ({ attemptNo: input.attemptNo, facts,
    nextHint: oneLine(input.hint, GOAL_HINT_MAX_CHARS), lastOutcome: input.outcome });
  while (facts.length > 0 && bytes(resume()) > RESUME_TARGET_BYTES) facts = facts.slice(1);
  return { resume: resume(), added };
}

/** The evidence block for the next attempt's prompt, or null when there is nothing to carry. */
export function renderResumeEvidence(resume: GoalResume | null, now: number): string | null {
  if (!resume) return null;
  const facts = liveFacts(resume.facts, now);
  if (facts.length === 0 && !resume.nextHint) return null;
  const lines = facts.map(fact => `- attempt ${fact.atAttempt}, ${fact.at.slice(0, 10)}, ${fact.capabilityId}: ${fact.summary}`);
  if (resume.nextHint) lines.push(`Where the last attempt (${resume.lastOutcome.toLowerCase()}) left off: ${resume.nextHint}`);
  return `${UNTRUSTED_PREAMBLE}\n` +
    fenceUntrusted({ content: lines.join('\n'), source: 'looked up in earlier attempts at this goal, may be stale', tier: 'UNKNOWN' });
}

/**
 * Only a closed marker on the last line ends anything. Anything else a model
 * says is ignored, so prose cannot settle a goal by accident.
 */
export function parseGoalEnding(answer: string): { end: GoalProposedEnd; reason: string } | null {
  const last = answer.trim().split(/\r?\n/).filter(line => line.trim()).pop() ?? '';
  const match = /^(DONE|ABANDON):[ \t]*(.+)$/.exec(last.trim());
  if (!match) return null;
  const reason = oneLine(match[2]!, GOAL_END_REASON_MAX + 1);
  if (reason.length < GOAL_END_REASON_MIN || reason.length > GOAL_END_REASON_MAX) return null;
  return { end: match[1] as GoalProposedEnd, reason };
}

/** The wake interval or two hours, doubling to eight times after quiet attempts. */
export function nextAttemptDelayMs(wakeIntervalSeconds: number, quietAttempts: number): number {
  const base = Math.max(wakeIntervalSeconds * 1000, MIN_ATTEMPT_DELAY_MS);
  return base * Math.min(MAX_BACKOFF, 2 ** Math.max(0, quietAttempts));
}

/**
 * A write that did not clearly succeed or clearly not run. A refusal or a
 * proposal never executed, so a later attempt may start fresh after one.
 */
export function leavesWriteUncertain(effect: string | undefined, outcome: string): boolean {
  return effect === 'WRITE' && !['SUCCEEDED', 'REFUSED', 'PROPOSED'].includes(outcome);
}
