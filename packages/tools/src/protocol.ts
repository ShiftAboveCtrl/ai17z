import type { AnyCapability } from './capability';

/**
 * How a model asks for a capability, and how that answer is read back.
 *
 * A text protocol rather than a provider's own function calling, because
 * `ProviderAdapter.generate` takes messages and returns text and nothing else.
 * Adding tool calls to that interface would mean every adapter growing a
 * feature only some vendors have, and the ones without it -- ollama, mock,
 * animal mode -- getting a worse version of the same idea. A protocol the
 * model writes in prose works identically on all ten.
 *
 * The tag is explicit and closed. A bare JSON object would be indistinguishable
 * from a model quoting JSON in an answer, which is exactly the sort of thing an
 * agent that talks about software does all day.
 */
export const CALL_OPEN = '<use-capability>';
export const CALL_CLOSE = '</use-capability>';

export interface CapabilityCall {
  id: string;
  input: unknown;
}

export type ModelTurn =
  | { kind: 'call'; call: CapabilityCall; raw: string }
  | { kind: 'answer'; text: string }
  | { kind: 'malformed'; reason: string; raw: string };

/**
 * Reads one model turn.
 *
 * A turn is a call or an answer, never both: a model that writes a call and
 * then guesses what it will return has already answered without the evidence,
 * and letting that through teaches it that guessing works. Text around a call
 * is discarded rather than kept.
 */
export function parseTurn(text: string): ModelTurn {
  const open = text.indexOf(CALL_OPEN);
  if (open === -1) return { kind: 'answer', text: text.trim() };

  const close = text.indexOf(CALL_CLOSE, open);
  if (close === -1) {
    return { kind: 'malformed', reason: `A ${CALL_OPEN} was opened and never closed.`, raw: text };
  }

  const body = text.slice(open + CALL_OPEN.length, close).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { kind: 'malformed', reason: 'The capability call was not valid JSON.', raw: body };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { kind: 'malformed', reason: 'A capability call must be a JSON object.', raw: body };
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.id !== 'string' || !record.id) {
    return { kind: 'malformed', reason: 'A capability call needs an "id".', raw: body };
  }
  return { kind: 'call', call: { id: record.id, input: record.input ?? {} }, raw: body };
}

/**
 * The menu, written for the model.
 *
 * Only what it needs to choose: the id, what the capability answers, and the
 * shape of its argument. Risk and category are for the owner's screen, not for
 * the model -- telling it a capability is HIGH risk invites it to reason about
 * whether to obey the permission model, which is not its decision to make.
 */
export function renderMenu(capabilities: AnyCapability[], describeInput: (c: AnyCapability) => string): string {
  if (capabilities.length === 0) return 'No capabilities are available for this agent right now.';
  const lines = capabilities.map((c) => `- ${c.id}: ${c.description}\n  input: ${describeInput(c)}`);
  return lines.join('\n');
}

/** The instruction that goes with the menu. */
export function renderInstructions(): string {
  return [
    'You may look something up before answering, using exactly one of the capabilities listed above.',
    '',
    'To use one, reply with only this and nothing else:',
    CALL_OPEN,
    '{"id": "the.capability_id", "input": { ... }}',
    CALL_CLOSE,
    '',
    'The result comes back and you may then use another or write your answer.',
    'Do not describe what a capability would return. Ask for it, or answer without it.',
    'When you have what you need, write the answer on its own with no tags.',
  ].join('\n');
}
