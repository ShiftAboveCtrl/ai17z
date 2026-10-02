/**
 * The owner-only capabilities through which an agent changes itself when its
 * owner asks in chat. Everything they do is `agentManagement.ts`; these only
 * let the model name a change from the closed list.
 *
 * All are `audience: 'OWNER'`, so a stranger on X can never reach them, and
 * they act on `ctx.agentId`, which the model cannot choose, so an agent can
 * only ever change itself.
 */
import { z } from 'zod';
import { defineCapability, registerCapability, type AnyCapability, type CapabilityContext } from '@xbam/tools';
import {
  CHANGE_KINDS,
  CHANGES,
  NEVER_FROM_CHAT,
  changesSince,
  refuseChange,
  requestChange,
  undoChange,
  looksLikeChangeRequest,
  type ChangeKindId,
  type ChangeOrigin,
  type NeverKind,
} from './agentManagement';
import { agentChanges as changesRepo } from '@xbam/database';

function originOf(ctx: CapabilityContext): { ownerId: string | null; origin: ChangeOrigin } {
  const o = ctx.origin ?? null;
  return {
    ownerId: o?.ownerId ?? null,
    origin: { conversationId: o?.conversationId ?? null, messageId: o?.messageId ?? null, text: o?.text ?? '' },
  };
}

/** Only in owner chat: the origin is what proves an owner asked. */
function requireOwnerChat(ctx: CapabilityContext): void {
  if (ctx.audience !== 'OWNER' || !ctx.origin) throw new Error('Changes are only made when the owner asks in owner chat.');
}

const Outcome = z.object({
  changeId: z.string(),
  status: z.string(),
  risk: z.string(),
  summary: z.string(),
  detail: z.string(),
});

/** The fields a kind takes, as the model has to write them. */
function fieldsOf(kind: ChangeKindId): string[] {
  const shape = (CHANGES[kind].input as unknown as { shape?: Record<string, unknown> }).shape;
  return shape ? Object.keys(shape) : [];
}

/*
  Each kind with the exact value it takes. Measured on a real installation: a
  menu that named the kinds and not their fields had the model send the tone as
  a bare string, then under the wrong key, and nothing changed.
*/
const kindList = CHANGE_KINDS.map((k) => {
  const fields = fieldsOf(k);
  return `${k} ${fields.length ? `{${fields.map((f) => `"${f}"`).join(', ')}}` : '{}'}: ${CHANGES[k].describe}`;
}).join(' ');

/**
 * A value the model wrote loosely, put in the one place it can mean.
 *
 * Only for a kind with exactly one field: "dry, warm" for persona.tone is
 * {"tone": "dry, warm"} and nothing else. The kind's own schema still decides
 * whether that is valid; this never invents a field or a value.
 */
export function normaliseChangeValue(kind: ChangeKindId, value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const fields = fieldsOf(kind);
    const keys = Object.keys(value);
    // {"value": "dry"} or {"tone_description": "dry"} for a one-field kind.
    if (fields.length === 1 && keys.length === 1 && !fields.includes(keys[0]!)) {
      return normaliseChangeValue(kind, (value as Record<string, unknown>)[keys[0]!]);
    }
    return value;
  }
  const fields = fieldsOf(kind);
  if (fields.length !== 1 || value === undefined || value === null) return value ?? {};
  const field = fields[0]!;
  if (field === 'topics') {
    const list = Array.isArray(value) ? value : String(value).split(/\s*,\s*/);
    return { topics: list.map(String).filter(Boolean) };
  }
  return { [field]: value };
}

const changeSetting = defineCapability({
  id: 'agent.change_setting',
  name: 'Change own setting',
  description:
    'Changes one of your own settings when the owner asks you to: tone, topics, reply length, a standing instruction, ' +
    'emoji, subjects to avoid, how automated you are, or your own posting. Pick exactly one kind and give its value. ' +
    `Kinds: ${kindList} Small changes apply at once and can be undone; bigger ones wait for the owner to confirm. ` +
    'Say what happened in one sentence, using the detail returned. When the owner asks you to fix yourself, read your health ' +
    'first; change a setting only if it is the cause, and for a browser, account, provider or model problem say which screen fixes it. ' +
    // In the words owners use, because the shortlist matches words. Measured
    // on a real installation: "make your replies slightly shorter" offered
    // nothing, and the agent answered that it would, having changed nothing.
    'Owners ask in words like: make your replies shorter or longer, be less formal, sound more casual, use fewer emoji, ' +
    "stop posting, post less often, add or drop topics, don't talk about something, call yourself something else.",
  category: 'ACCOUNT',
  effect: 'WRITE',
  risk: 'LOW',
  // The owner asking is the decision; the tiers inside decide what waits.
  unsetPermission: 'ALLOWED',
  audience: 'OWNER',
  input: z.object({
    kind: z.enum(CHANGE_KINDS as [ChangeKindId, ...ChangeKindId[]]),
    value: z.union([z.record(z.string(), z.unknown()), z.string(), z.number(), z.array(z.string())]).default({}),
  }),
  output: Outcome,
  modelCallable: true,
  timeoutMs: 20_000,
  async run(input, ctx) {
    requireOwnerChat(ctx);
    const { ownerId, origin } = originOf(ctx);
    const out = await requestChange({ agentId: ctx.agentId, ownerId, kind: input.kind, value: normaliseChangeValue(input.kind, input.value), origin });
    return { changeId: out.change.id, status: out.change.status, risk: out.change.risk, summary: out.change.summary, detail: out.message };
  },
});

const refuse = defineCapability({
  id: 'agent.cannot_change',
  name: 'Something chat cannot change',
  description:
    'Use when the owner asks you to change something chat never changes: money, tokens, wallets, keys or purchases (financial); ' +
    'passwords or API keys (credentials); whether you may say you are not an AI (identity_disclosure); what you are allowed to do, ' +
    'capabilities or Plugins (permissions); another agent (other_agent); deleting yourself (delete_agent); safety rules (safety). ' +
    'It records the request and returns where the owner does it instead.',
  category: 'ANALYTICS',
  effect: 'READ',
  risk: 'LOW',
  audience: 'OWNER',
  input: z.object({ about: z.enum(Object.keys(NEVER_FROM_CHAT) as [NeverKind, ...NeverKind[]]) }),
  output: Outcome,
  modelCallable: true,
  timeoutMs: 10_000,
  async run(input, ctx) {
    requireOwnerChat(ctx);
    const { ownerId, origin } = originOf(ctx);
    const out = await refuseChange({ agentId: ctx.agentId, ownerId, about: input.about, origin });
    return { changeId: out.change.id, status: out.change.status, risk: out.change.risk, summary: out.change.summary, detail: out.message };
  },
});

const undo = defineCapability({
  id: 'agent.undo_change',
  name: 'Undo own change',
  description:
    'Undoes a change you made to your own settings when the owner asks to undo, revert or put it back. ' +
    'Without an id it undoes the most recent one. Owners ask in words like: undo that, change it back, ' +
    'put it back the way it was, revert the last change.',
  category: 'ACCOUNT',
  effect: 'WRITE',
  risk: 'LOW',
  unsetPermission: 'ALLOWED',
  audience: 'OWNER',
  input: z.object({ changeId: z.string().uuid().optional() }),
  output: Outcome,
  modelCallable: true,
  timeoutMs: 20_000,
  async run(input, ctx) {
    requireOwnerChat(ctx);
    const { ownerId } = originOf(ctx);
    const target = input.changeId ? await changesRepo.get(input.changeId) : await changesRepo.latestUndoable(ctx.agentId);
    // Another agent's change is not this agent's to undo, and is reported as absent.
    if (!target || target.agentId !== ctx.agentId) throw new Error('There is no change of mine to undo.');
    const out = await undoChange(target.id, ownerId);
    return { changeId: out.change.id, status: out.change.status, risk: out.change.risk, summary: out.change.summary, detail: out.message };
  },
});

const myChanges = defineCapability({
  id: 'agent.my_changes',
  name: 'Changes made in chat',
  description:
    'Lists what you changed about yourself because the owner asked in chat: what, before and after, when, and whether it was ' +
    'confirmed, undone or refused. Use it for "show me what you changed today".',
  category: 'ANALYTICS',
  effect: 'READ',
  risk: 'LOW',
  audience: 'OWNER',
  input: z.object({ days: z.number().int().min(1).max(90).default(1) }),
  output: z.object({
    changes: z.array(z.object({ id: z.string(), kind: z.string(), status: z.string(), summary: z.string(), asked: z.string(), at: z.string() })),
    detail: z.string(),
  }),
  modelCallable: true,
  timeoutMs: 10_000,
  async run(input, ctx) {
    const rows = await changesSince(ctx.agentId, null, new Date(Date.now() - input.days * 86_400_000).toISOString());
    return {
      changes: rows.map((r) => ({ id: r.id, kind: r.kind, status: r.status, summary: r.summary, asked: r.requestText.slice(0, 200), at: r.createdAt })),
      detail: rows.length === 0 ? `Nothing was changed from chat in the last ${input.days === 1 ? 'day' : `${input.days} days`}.` : `${rows.length} changes, newest first.`,
    };
  },
});

/** The capabilities whose result is a change to the agent, for the honesty check in owner chat. */
export const CHANGE_CAPABILITY_IDS = new Set(['agent.change_setting', 'agent.undo_change']);

/**
 * What an answer may say after trying to change the agent.
 *
 * A model writes "I changed my tone" whether or not the change went through;
 * on a real installation it did exactly that after both attempts were
 * refused. So when a change was attempted and none succeeded, the answer is
 * replaced with what actually happened. A model is not a witness to its own
 * tool use.
 */
/** An answer saying something about the agent has changed, or will from now on. */
const CLAIMS_A_CHANGE =
  /\b(?:from now on|going forward|i(?:'ll| will) (?:keep|be|make|use|stop|start|post|avoid|sound|try to|cut|go)|i(?:'ve| have) (?:changed|updated|set|switched|made|adjusted|turned)|(?:changed|updated|adjusted|switched) (?:my|it|that)|done\b)/i;

export function honestChangeAnswer(
  answer: string,
  steps: ReadonlyArray<{ capabilityId: string; outcome: string; detail: string; output?: unknown }>,
  question = '',
): string {
  const attempts = steps.filter((s) => CHANGE_CAPABILITY_IDS.has(s.capabilityId));
  if (attempts.length === 0) {
    // Asked for a change, attempted none, and said it was done: that is a
    // promise nothing will keep. Measured on a real installation.
    if (looksLikeChangeRequest(question) && CLAIMS_A_CHANGE.test(answer)) {
      return 'I have not changed anything: that request did not reach my settings, so nothing about me changed. Ask again and name the setting, for example "make your replies shorter".';
    }
    return answer;
  }
  const succeeded = attempts.filter((s) => s.outcome === 'SUCCEEDED');
  const applied = succeeded.filter((s) => {
    const status = (s.output as { status?: string } | undefined)?.status;
    return status === 'APPLIED' || status === 'AWAITING_CONFIRMATION' || status === 'UNDONE';
  });
  if (applied.length > 0) return answer;
  const last = succeeded.length > 0 ? ((succeeded[succeeded.length - 1]!.output as { detail?: string } | undefined)?.detail ?? '') : attempts[attempts.length - 1]!.detail;
  return `I tried to make that change and it did not go through, so nothing about me changed. ${last}`.trim();
}

export const MANAGEMENT_CAPABILITIES = [changeSetting, refuse, undo, myChanges] as unknown as AnyCapability[];

export function registerManagementCapabilities(): void {
  for (const capability of MANAGEMENT_CAPABILITIES) registerCapability(capability);
}
