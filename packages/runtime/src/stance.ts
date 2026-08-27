import type { StanceContext, StancePolicy, StancePosition } from '@xbam/shared/contracts';
import { positionsConflict } from '@xbam/shared/contracts';
import { stances as stancesRepo, type StanceRow } from '@xbam/database';

/**
 * Keeping the agent consistent with what it has already said.
 *
 * The failure this addresses is an agent that is sceptical about something on
 * Monday and enthusiastic on Thursday, with no record that anything changed.
 *
 * It is emphatically not about freezing opinions. An agent should be able to
 * change its mind — what it should not do is change it by accident, because a
 * different slice of context happened to be retrieved that day.
 */

/** Words that signal a positive or negative reading, with no model call. */
const POSITIVE = /\b(good|great|strong|right|works|impressive|solid|promising|bullish|agree|correct|excellent|better)\b/gi;
const NEGATIVE = /\b(bad|weak|wrong|broken|fails|failing|sceptical|skeptical|doubt|overrated|bearish|disagree|concerned|risky|worse)\b/gi;
const HEDGE = /\b(maybe|perhaps|might|could|not sure|unclear|depends|arguably|possibly)\b/gi;

/**
 * Reads a position out of a piece of text.
 *
 * Deliberately arithmetic rather than a model call. This runs on every candidate
 * reply, the result is shown to the owner, and a judgement that cannot be
 * explained is not much use for deciding whether to stop a post.
 */
export function readPosition(text: string): { position: StancePosition; strength: number } {
  const positives = (text.match(POSITIVE) ?? []).length;
  const negatives = (text.match(NEGATIVE) ?? []).length;
  const hedges = (text.match(HEDGE) ?? []).length;

  if (positives === 0 && negatives === 0) return { position: 'NEUTRAL', strength: 0 };
  if (hedges >= 2 && Math.abs(positives - negatives) <= 1) return { position: 'UNCERTAIN', strength: 0.3 };
  if (positives > 0 && negatives > 0 && Math.abs(positives - negatives) <= 1) {
    return { position: 'MIXED', strength: 0.4 };
  }

  const total = positives + negatives;
  const lean = Math.abs(positives - negatives) / total;
  // Hedging weakens a position without changing which way it points.
  const strength = Math.max(0.2, Math.min(0.85, lean * (hedges > 0 ? 0.6 : 1)));
  return { position: positives > negatives ? 'POSITIVE' : 'NEGATIVE', strength };
}

export interface StanceCheck {
  ok: boolean;
  /** The position that is contradicted, when one is. */
  conflictsWith: StanceRow | null;
  candidatePosition: StancePosition;
  message: string | null;
}

/**
 * Checks a candidate reply against positions already held.
 *
 * Only a straight reversal on a firmly held position counts. Moving from firm
 * to hedged, or taking a view where none was held, is a position developing —
 * and an agent that can never do that is not consistent, it is stuck.
 */
export async function checkStanceConsistency(input: {
  agentId: string;
  text: string;
  policy: StancePolicy;
}): Promise<StanceCheck> {
  const candidate = readPosition(input.text);
  const empty: StanceCheck = { ok: true, conflictsWith: null, candidatePosition: candidate.position, message: null };
  if (!input.policy.enabled || candidate.position === 'NEUTRAL') return empty;

  const relevant = await stancesRepo.relevantTo(input.agentId, input.text, 4);
  for (const held of relevant) {
    if (Number(held.confidence) < input.policy.conflictThreshold) continue;
    if (!positionsConflict(held.position, candidate.position)) continue;

    return {
      ok: false,
      conflictsWith: held,
      candidatePosition: candidate.position,
      message: `This reads as ${candidate.position.toLowerCase()} about ${held.subject}, and the agent has been ${held.position.toLowerCase()} about it since ${new Date(held.createdAt).toISOString().slice(0, 10)}: "${held.summary}"`,
    };
  }
  return empty;
}

/** Positions worth putting in front of the model for this conversation. */
export async function loadStanceContext(agentId: string, text: string): Promise<StanceContext> {
  const [relevant, revised] = await Promise.all([
    stancesRepo.relevantTo(agentId, text, 4),
    stancesRepo.recentlyRevised(agentId),
  ]);

  return {
    relevant: relevant.map((stance) => ({
      subject: stance.subject,
      position: stance.position,
      summary: stance.summary,
      confidence: Number(stance.confidence),
      heldSince: stance.createdAt,
    })),
    revised: revised.map((row) => ({
      subject: row.subject,
      from: row.fromPosition,
      to: row.toPosition,
      changedAt: row.changedAt,
    })),
  };
}

/**
 * Subjects worth having a position about, taken from what was actually said.
 *
 * Capitalised multi-word names and hashtags only. Extracting every noun would
 * fill the ledger with positions on "the market" and "people", which are not
 * things anybody wants an agent to be pinned to.
 */
export function candidateSubjects(text: string): string[] {
  const withoutUrls = text.replace(/https?:\/\/\S+/g, ' ');
  const found = new Set<string>();

  // A continuation word may be a single character: "Project Q" and "Series A"
  // are names, and truncating them to "Project" merges unrelated subjects into
  // one stance, which is the opposite of what this table is for.
  for (const match of withoutUrls.matchAll(/\b([A-Z][a-zA-Z0-9]+(?:\s+[A-Z][a-zA-Z0-9]*){0,2})\b/g)) {
    const phrase = match[1]!.trim();
    // A capitalised word at the start of a sentence is usually just a sentence.
    if (phrase.split(/\s+/).length === 1 && withoutUrls.indexOf(phrase) === 0) continue;
    if (phrase.length >= 4) found.add(phrase);
  }
  for (const match of withoutUrls.matchAll(/#([A-Za-z][A-Za-z0-9_]{2,30})/g)) {
    found.add(match[1]!);
  }
  return [...found].slice(0, 3);
}

/**
 * Records positions from something the agent published.
 *
 * Only from executed actions: a draft is not something the agent has said, and
 * a dry run is explicitly not a public position.
 */
export async function learnStancesFromOwnPost(input: {
  agentId: string;
  text: string;
  policy: StancePolicy;
  jobId?: string | null;
  remoteUrl?: string | null;
}): Promise<StanceRow[]> {
  if (!input.policy.enabled || !input.policy.learnFromOwnPosts) return [];

  const read = readPosition(input.text);
  if (read.position === 'NEUTRAL' || read.strength < 0.3) return [];

  const recorded: StanceRow[] = [];
  for (const subject of candidateSubjects(input.text)) {
    const existing = await stancesRepo.active(input.agentId, subject);
    // A position the owner wrote is not revised by something the agent said.
    if (existing?.pinned) continue;

    recorded.push(
      await stancesRepo.assert({
        agentId: input.agentId,
        subject,
        position: read.position,
        summary: input.text.slice(0, 300),
        confidence: read.strength,
        evidence: { kind: 'said', excerpt: input.text.slice(0, 500), jobId: input.jobId, remoteUrl: input.remoteUrl },
      }),
    );
  }
  return recorded;
}

/** "X will happen by Y" — a claim about the future, worth revisiting. */
const PREDICTION = /\b(will|going to|expect|predict|by (?:the end of|next|Q[1-4])|within \d+\s+(?:days?|weeks?|months?))\b/i;

/** "I'll look into that" — a promise to somebody. */
const COMMITMENT = /\b(i(?:'| wi)ll|i am going to|let me|i can) (look into|check|find out|get back|follow up|dig into|report back)\b/i;

/**
 * Notices predictions and promises in something the agent said.
 *
 * Conservative on purpose. A casual turn of phrase is not an obligation, and an
 * agent that treats every "I'll take a look" as a tracked commitment produces a
 * backlog nobody asked for. Confidence is recorded so a weak detection can be
 * kept without being acted on.
 */
export function detectClaims(text: string): {
  prediction: { claim: string; confidence: number } | null;
  commitment: { promise: string; confidence: number } | null;
} {
  const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);

  let prediction: { claim: string; confidence: number } | null = null;
  let commitment: { promise: string; confidence: number } | null = null;

  for (const sentence of sentences) {
    if (!prediction && PREDICTION.test(sentence)) {
      // A dated claim is a real prediction; an unqualified "will" often is not.
      const dated = /\b(by |within |before |Q[1-4]|\d{4})\b/i.test(sentence);
      prediction = { claim: sentence.trim().slice(0, 500), confidence: dated ? 0.75 : 0.4 };
    }
    if (!commitment && COMMITMENT.test(sentence)) {
      commitment = { promise: sentence.trim().slice(0, 300), confidence: 0.7 };
    }
  }
  return { prediction, commitment };
}
