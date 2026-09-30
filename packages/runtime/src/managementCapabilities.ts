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

const kindList = CHANGE_KINDS.map((k) => `${k}: ${CHANGES[k].describe}`).join(' ');

const changeSetting = defineCapability({
  id: 'agent.change_setting',
  name: 'Change own setting',
  description:
    'Changes one of your own settings when the owner asks you to: tone, topics, reply length, a standing instruction, ' +
    'emoji, subjects to avoid, how automated you are, or your own posting. Pick exactly one kind and give its value. ' +
    `Kinds: ${kindList} Small changes apply at once and can be undone; bigger ones wait for the owner to confirm. ` +
    'Say what happened in one sentence, using the detail returned.',
  category: 'ACCOUNT',
  effect: 'WRITE',
  risk: 'LOW',
  // The owner asking is the decision; the tiers inside decide what waits.
  unsetPermission: 'ALLOWED',
  audience: 'OWNER',
  input: z.object({
    kind: z.enum(CHANGE_KINDS as [ChangeKindId, ...ChangeKindId[]]),
    value: z.record(z.string(), z.unknown()).default({}),
  }),
  output: Outcome,
  modelCallable: true,
  timeoutMs: 20_000,
  async run(input, ctx) {
    requireOwnerChat(ctx);
    const { ownerId, origin } = originOf(ctx);
    const out = await requestChange({ agentId: ctx.agentId, ownerId, kind: input.kind, value: input.value, origin });
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
    'Without an id it undoes the most recent one.',
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

export const MANAGEMENT_CAPABILITIES = [changeSetting, refuse, undo, myChanges] as unknown as AnyCapability[];

export function registerManagementCapabilities(): void {
  for (const capability of MANAGEMENT_CAPABILITIES) registerCapability(capability);
}
