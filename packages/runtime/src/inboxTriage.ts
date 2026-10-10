/**
 * Inbox triage: which of the people who wrote in an owner should look at first.
 *
 * Deterministic and model free, for the reason `salience.ts` gives: the order
 * an owner reads their inbox in is a judgement they need to be able to read,
 * correct and disagree with, and "a model thought this was urgent" is none of
 * those. Every point carries a named factor and a sentence.
 *
 * It suggests and never acts. The suggestion is one of four words, none of
 * which sends anything: answering stays with the pipeline, its policy gates
 * and its approvals, and an owner who agrees presses the button they already
 * have. Spam is a reason to leave something, never a reason to delete it.
 *
 * Audience plays no part. Somebody who writes to the agent is never weighed by
 * how many people follow them.
 */

export type InboxPriority = 'HIGH' | 'NORMAL' | 'LOW';
export type InboxSuggestion = 'ANSWER' | 'REVIEW' | 'LEAVE' | 'NOTHING';

export interface InboxTriageInput {
  type: string;
  text: string;
  state: string;
  occurredAt: string | null;
  ingestedAt: string;
  decision: { decision: string; value: number; reason: string } | null;
  threadMessages: number;
  ourTurns: number;
  priorFromPerson: number;
  spamVerdict: string | null;
}

export interface InboxFactor {
  factor: string;
  points: number;
  reason: string;
}

export interface InboxTriage {
  priority: InboxPriority;
  score: number;
  suggestion: InboxSuggestion;
  factors: InboxFactor[];
  /** One sentence an owner can read instead of the factors. */
  summary: string;
}

/** States in which there is nothing left for anybody to do. */
const SETTLED = new Set(['REPLIED', 'DRY_RUN', 'DECLINED']);
const DIRECT = new Set(['MENTION', 'REPLY', 'DIRECT_MESSAGE']);

/** Past a day, a reply reads as an afterthought; past three it is a different conversation. */
const STALE_AFTER_MS = 24 * 3_600_000;
const GONE_AFTER_MS = 72 * 3_600_000;

const HIGH_AT = 50;
const LOW_BELOW = 20;

/** A question, by shape: a question mark, or a sentence that opens like one. */
export function readsAsQuestion(text: string): boolean {
  if (text.includes('?')) return true;
  return /(^|[.!]\s+)(who|what|when|where|why|how|is|are|can|could|do|does|did|will|would|should)\b/i.test(text.trim());
}

export function inboxTriage(row: InboxTriageInput, now: Date = new Date()): InboxTriage {
  const factors: InboxFactor[] = [];
  const add = (factor: string, points: number, reason: string) => factors.push({ factor, points, reason });

  if (row.spamVerdict === 'SPAM' || row.state === 'FILTERED') {
    add('spam', -100, 'Judged spam when it arrived. Kept here so the verdict can be corrected.');
    return finish(factors, 'LEAVE');
  }
  if (SETTLED.has(row.state)) {
    const said =
      row.state === 'REPLIED' ? 'Already answered.' : row.state === 'DECLINED' ? 'The agent decided not to answer, and said why.' : 'Rehearsed only; nothing was sent.';
    add('settled', 0, said);
    return finish(factors, 'NOTHING');
  }
  if (row.state === 'WORKING') {
    add('in_progress', 0, 'The agent is working on it now.');
    return finish(factors, 'NOTHING');
  }

  if (row.state === 'NEEDS_REVIEW') add('waiting_on_owner', 40, 'Held for you to approve or look at.');
  if (row.state === 'FAILED') add('failed', 25, 'An answer was attempted and failed.');
  if (row.type === 'DIRECT_MESSAGE') add('direct_message', 25, 'A direct message, written to the agent alone.');
  else if (DIRECT.has(row.type)) add('wrote_to_agent', 20, 'Written to the agent, not found by searching.');
  else add('found_by_search', -10, 'Found by the radar, not written to the agent.');

  if (readsAsQuestion(row.text)) add('question', 15, 'Asks something.');
  if (row.ourTurns > 0) add('conversation', 10, 'Continues a conversation the agent is already in.');
  else if (row.priorFromPerson > 0) add('known_person', 5, 'From somebody who has written before.');

  if (row.spamVerdict === 'SUSPECT') add('suspect', -20, 'Looked borderline when it arrived.');
  if (row.decision && row.decision.decision !== 'REPLY') add('declined_before', -5, `The engagement check leaned against it: ${row.decision.reason}`);

  const when = Date.parse(row.occurredAt ?? row.ingestedAt);
  const age = Number.isFinite(when) ? now.getTime() - when : 0;
  if (age > GONE_AFTER_MS) add('old', -30, 'More than three days old; an answer now would be to a different conversation.');
  else if (age > STALE_AFTER_MS) add('stale', -10, 'More than a day old.');

  const score = factors.reduce((sum, f) => sum + f.points, 0);
  const suggestion: InboxSuggestion =
    row.state === 'NEEDS_REVIEW' || row.state === 'FAILED' ? 'REVIEW' : score >= LOW_BELOW && age <= GONE_AFTER_MS ? 'ANSWER' : 'LEAVE';
  return finish(factors, suggestion);
}

function finish(factors: InboxFactor[], suggestion: InboxSuggestion): InboxTriage {
  const score = factors.reduce((sum, f) => sum + f.points, 0);
  const priority: InboxPriority = suggestion === 'NOTHING' || suggestion === 'LEAVE' ? 'LOW' : score >= HIGH_AT ? 'HIGH' : score >= LOW_BELOW ? 'NORMAL' : 'LOW';
  const lead = [...factors].sort((a, b) => Math.abs(b.points) - Math.abs(a.points))[0];
  const verb =
    suggestion === 'ANSWER' ? 'Worth answering' : suggestion === 'REVIEW' ? 'Needs you' : suggestion === 'LEAVE' ? 'Can be left' : 'Nothing to do';
  return { priority, score, suggestion, factors, summary: lead ? `${verb}. ${lead.reason}` : `${verb}.` };
}
