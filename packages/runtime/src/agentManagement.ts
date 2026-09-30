/**
 * Changing an agent from owner chat.
 *
 * "Be less formal", "stop posting for a while", "add Solana to your topics":
 * an owner should be able to say it to the agent and have it happen. What
 * makes that safe is that the agent never writes its own settings. It names a
 * change from a closed list, and this module applies it through the same
 * versioned repositories the settings screens use.
 *
 * ## A closed list, typed
 *
 * Every change is a kind here with its own input schema, the part of the
 * agent it belongs to, how to read the current value, how to write a new one,
 * and how risky the particular move is. There is no free-form write, no path
 * to a raw row, and nothing a model can name that is not in `CHANGES`.
 *
 * ## Three tiers, decided per move rather than per kind
 *
 * - **LOW** applies at once and can be undone: tone, topics, emoji, length,
 *   pausing, slowing down, tightening a guard.
 * - **CONFIRM** waits for the owner to press Confirm: anything that makes the
 *   agent do more or say more, or changes what it is called. Resuming posting
 *   is CONFIRM while pausing is LOW, because the errors are not symmetric.
 * - **NEVER** is refused with a sentence and recorded: anything to do with
 *   money, keys or wallets, credentials, whether it may deny being an AI,
 *   capability permissions, another agent, or deleting itself. Those have
 *   screens of their own, where the owner can see what they are agreeing to.
 *
 * ## One agent
 *
 * A change applies to the agent it was asked of and nobody else. In a
 * capability that is `ctx.agentId`, which the model cannot choose; in a room,
 * `changeTargets` decides who was asked before any model runs, and asks once
 * when it cannot tell rather than changing everybody.
 *
 * ## Checked, and reversible
 *
 * Every write is read back. A read that disagrees puts the old value back and
 * records a failure. Undo writes the old value only if the setting still holds
 * what the change wrote: undoing a change somebody has since changed again
 * would silently overwrite the later decision.
 */
import { z } from 'zod';
import {
  agentChanges as changesRepo,
  agents as agentsRepo,
  ops,
  posting as postingRepo,
  type AgentChangeRisk,
  type AgentChangeRow,
  type AgentChangeSubsystem,
} from '@xbam/database';
import { NotFoundError, ValidationError } from '@xbam/shared';
import { AUTOMATION_MODES, EmojiUse, PersonaDraft, type PersonaVersion, type PolicyConfig } from '@xbam/shared/contracts';

// ── The closed list ─────────────────────────────────────────────────────────

interface ChangeKind<TInput, TValue> {
  kind: string;
  subsystem: AgentChangeSubsystem;
  /** For the model: what this changes, in the owner's words. */
  describe: string;
  input: z.ZodType<TInput, z.ZodTypeDef, unknown>;
  read(agentId: string): Promise<TValue>;
  next(before: TValue, input: TInput): TValue;
  risk(before: TValue, after: TValue): Exclude<AgentChangeRisk, 'NEVER'>;
  write(agentId: string, value: TValue, ownerId: string | null, note: string): Promise<void>;
  summary(before: TValue, after: TValue): string;
}

function change<TInput, TValue>(kind: ChangeKind<TInput, TValue>): ChangeKind<TInput, TValue> {
  return kind;
}

async function persona(agentId: string): Promise<PersonaVersion> {
  const current = await agentsRepo.getActivePersona(agentId);
  if (!current) throw new ValidationError('This agent has no persona yet, so there is nothing to change. Set one up on its page first.');
  return current;
}

/** Writes one new persona version with everything else exactly as it was. */
async function savePersona(agentId: string, patch: Partial<PersonaDraft>, ownerId: string | null, note: string): Promise<void> {
  const current = await persona(agentId);
  const draft = PersonaDraft.parse({
    identityKind: current.identityKind,
    displayName: current.displayName,
    biography: current.biography,
    personality: current.personality,
    tone: current.tone,
    styleGuidelines: current.styleGuidelines,
    styleExamples: current.styleExamples,
    topics: current.topics,
    languagePolicy: current.languagePolicy,
    responseLength: current.responseLength,
    prohibitedBehaviors: current.prohibitedBehaviors,
    customInstructions: current.customInstructions,
    ...patch,
    changeNote: note.slice(0, 500),
  });
  await agentsRepo.savePersonaVersion(agentId, draft, ownerId);
}

async function policy(agentId: string): Promise<PolicyConfig> {
  const row = await agentsRepo.getActivePolicy(agentId);
  if (!row) throw new ValidationError('This agent has no policy yet, so there is nothing to change.');
  return row.config as PolicyConfig;
}

async function savePolicy(agentId: string, mutate: (config: PolicyConfig) => void, ownerId: string | null, note: string): Promise<void> {
  const config = structuredClone(await policy(agentId));
  mutate(config);
  await agentsRepo.savePolicyVersion(agentId, config, note.slice(0, 500), ownerId);
}

const clean = (list: readonly string[]) => [...new Set(list.map((t) => t.trim()).filter(Boolean))];
const sameText = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const without = (list: readonly string[], drop: readonly string[]) => list.filter((t) => !drop.some((d) => sameText(d, t)));
const withAdded = (list: readonly string[], add: readonly string[]) => [...list, ...clean(add).filter((t) => !list.some((x) => sameText(x, t)))];
const listed = (items: readonly string[]) => (items.length ? items.join(', ') : 'none');

const Topics = z.object({ topics: z.array(z.string().trim().min(1).max(120)).min(1).max(20) });
const Text = z.object({ text: z.string().trim().min(1).max(600) });

/** The least automated first, so moving right is doing more on its own. */
const AUTONOMY_ORDER: readonly string[] = ['OFF', 'MONITOR_ONLY', 'MANUAL_ONLY', 'REVIEW_BEFORE_ACTION', 'AUTONOMOUS'];

/** No agent is told to post more often than this from a chat message. */
const MIN_POST_INTERVAL_HOURS = 1;

interface PostingValue {
  enabled: boolean;
  intervalHours: number;
}

async function readPosting(agentId: string): Promise<PostingValue> {
  const row = await postingRepo.getSchedule(agentId);
  if (!row) throw new ValidationError("This agent has no posting schedule yet. Set one up on the agent's page, then it can be changed here.");
  return { enabled: row.enabled, intervalHours: Math.round((row.intervalSeconds / 3600) * 100) / 100 };
}

async function writePosting(agentId: string, value: PostingValue): Promise<void> {
  const row = await postingRepo.getSchedule(agentId);
  if (!row) throw new ValidationError('This agent has no posting schedule yet.');
  await postingRepo.setSchedule({
    agentId,
    accountId: row.accountId,
    enabled: value.enabled,
    intervalSeconds: Math.round(value.intervalHours * 3600),
    jitterPercent: row.jitterPercent,
  });
}

export const CHANGES = {
  'persona.tone': change({
    kind: 'persona.tone',
    subsystem: 'PERSONA',
    describe: 'How it sounds: replace the tone description, e.g. "dry, warm, a little playful".',
    input: z.object({ tone: z.string().trim().min(1).max(500) }),
    read: async (agentId) => (await persona(agentId)).tone,
    next: (_before, input) => input.tone,
    risk: () => 'LOW',
    write: (agentId, tone, ownerId, note) => savePersona(agentId, { tone }, ownerId, note),
    summary: (before, after) => `Tone changed from "${before || 'unset'}" to "${after}".`,
  }),
  'persona.add_topics': change({
    kind: 'persona.add_topics',
    subsystem: 'PERSONA',
    describe: 'Add subjects it is interested in and talks about.',
    input: Topics,
    read: async (agentId) => (await persona(agentId)).topics,
    next: (before, input) => withAdded(before, input.topics),
    risk: () => 'LOW',
    write: (agentId, topics, ownerId, note) => savePersona(agentId, { topics }, ownerId, note),
    summary: (before, after) => `Added topics: ${listed(after.filter((t) => !before.includes(t)))}.`,
  }),
  'persona.remove_topics': change({
    kind: 'persona.remove_topics',
    subsystem: 'PERSONA',
    describe: 'Remove subjects from its interests.',
    input: Topics,
    read: async (agentId) => (await persona(agentId)).topics,
    next: (before, input) => without(before, input.topics),
    risk: () => 'LOW',
    write: (agentId, topics, ownerId, note) => savePersona(agentId, { topics }, ownerId, note),
    summary: (before, after) => `Removed topics: ${listed(before.filter((t) => !after.includes(t)))}.`,
  }),
  'persona.response_length': change({
    kind: 'persona.response_length',
    subsystem: 'PERSONA',
    describe: 'How long its replies usually are: TERSE, SHORT, MEDIUM, LONG or ADAPTIVE.',
    input: z.object({ length: z.enum(['TERSE', 'SHORT', 'MEDIUM', 'LONG', 'ADAPTIVE']) }),
    read: async (agentId) => (await persona(agentId)).responseLength,
    next: (_before, input) => input.length,
    risk: () => 'LOW',
    write: (agentId, responseLength, ownerId, note) => savePersona(agentId, { responseLength }, ownerId, note),
    summary: (before, after) => `Reply length changed from ${before} to ${after}.`,
  }),
  'persona.add_instruction': change({
    kind: 'persona.add_instruction',
    subsystem: 'PERSONA',
    describe: 'Add one standing instruction about how it behaves, e.g. "Never explain a feature unless asked."',
    input: Text,
    read: async (agentId) => (await persona(agentId)).customInstructions,
    next: (before, input) => (before.includes(input.text) ? before : [before.trim(), input.text].filter(Boolean).join('\n\n')),
    risk: () => 'LOW',
    write: (agentId, customInstructions, ownerId, note) => savePersona(agentId, { customInstructions }, ownerId, note),
    summary: (before, after) => (before === after ? 'That instruction was already there.' : `Added the instruction: "${after.slice(before.trim().length).trim()}".`),
  }),
  'persona.display_name': change({
    kind: 'persona.display_name',
    subsystem: 'PERSONA',
    describe: 'The name it uses for itself.',
    input: z.object({ name: z.string().trim().min(1).max(80) }),
    read: async (agentId) => (await persona(agentId)).displayName,
    next: (_before, input) => input.name,
    risk: () => 'CONFIRM',
    write: (agentId, displayName, ownerId, note) => savePersona(agentId, { displayName }, ownerId, note),
    summary: (before, after) => `Name changed from "${before}" to "${after}".`,
  }),
  'policy.emoji': change({
    kind: 'policy.emoji',
    subsystem: 'POLICY',
    describe: 'How much emoji it uses: NONE, MINIMAL, SELECTED or UNRESTRICTED, and at most how many per message.',
    input: z.object({ use: EmojiUse, maxPerMessage: z.number().int().min(0).max(5).optional() }),
    read: async (agentId) => {
      const emoji = (await policy(agentId)).output.emoji;
      return { use: emoji.use, maxPerMessage: emoji.maxPerMessage };
    },
    next: (before, input) => ({ use: input.use, maxPerMessage: input.maxPerMessage ?? before.maxPerMessage }),
    risk: () => 'LOW',
    write: (agentId, value, ownerId, note) =>
      savePolicy(agentId, (c) => void Object.assign(c.output.emoji, value), ownerId, note),
    summary: (before, after) => `Emoji changed from ${before.use} (at most ${before.maxPerMessage}) to ${after.use} (at most ${after.maxPerMessage}).`,
  }),
  'policy.block_topics': change({
    kind: 'policy.block_topics',
    subsystem: 'POLICY',
    describe: 'Subjects it must not talk about.',
    input: Topics,
    read: async (agentId) => (await policy(agentId)).content.blockedTopics,
    next: (before, input) => withAdded(before, input.topics),
    risk: () => 'LOW',
    write: (agentId, blockedTopics, ownerId, note) => savePolicy(agentId, (c) => void (c.content.blockedTopics = blockedTopics), ownerId, note),
    summary: (before, after) => `Now avoids: ${listed(after.filter((t) => !before.includes(t)))}.`,
  }),
  'policy.unblock_topics': change({
    kind: 'policy.unblock_topics',
    subsystem: 'POLICY',
    describe: 'Allow subjects it was told to avoid.',
    input: Topics,
    read: async (agentId) => (await policy(agentId)).content.blockedTopics,
    next: (before, input) => without(before, input.topics),
    // Loosening a guard is a decision the owner confirms.
    risk: () => 'CONFIRM',
    write: (agentId, blockedTopics, ownerId, note) => savePolicy(agentId, (c) => void (c.content.blockedTopics = blockedTopics), ownerId, note),
    summary: (before, after) => `No longer avoids: ${listed(before.filter((t) => !after.includes(t)))}.`,
  }),
  'policy.automation': change({
    kind: 'policy.automation',
    subsystem: 'POLICY',
    describe:
      'How much it does on its own: OFF, MONITOR_ONLY, MANUAL_ONLY, REVIEW_BEFORE_ACTION (drafts wait for the owner) or AUTONOMOUS.',
    input: z.object({ mode: z.enum(AUTOMATION_MODES) }),
    read: async (agentId) => (await policy(agentId)).automation.mode,
    next: (_before, input) => input.mode,
    risk: (before, after) => (AUTONOMY_ORDER.indexOf(after) > AUTONOMY_ORDER.indexOf(before) ? 'CONFIRM' : 'LOW'),
    write: (agentId, mode, ownerId, note) => savePolicy(agentId, (c) => void (c.automation.mode = mode), ownerId, note),
    summary: (before, after) => `Automation changed from ${before} to ${after}.`,
  }),
  'posting.pause': change({
    kind: 'posting.pause',
    subsystem: 'POSTING',
    describe: 'Stop its own unprompted posts. Replies are not affected.',
    input: z.object({}),
    read: readPosting,
    next: (before) => ({ ...before, enabled: false }),
    risk: () => 'LOW',
    write: (agentId, value) => writePosting(agentId, value),
    summary: (before) => (before.enabled ? 'Paused its own posts.' : 'Its own posts were already paused.'),
  }),
  'posting.resume': change({
    kind: 'posting.resume',
    subsystem: 'POSTING',
    describe: 'Start its own unprompted posts again.',
    input: z.object({}),
    read: readPosting,
    next: (before) => ({ ...before, enabled: true }),
    risk: (before) => (before.enabled ? 'LOW' : 'CONFIRM'),
    write: (agentId, value) => writePosting(agentId, value),
    summary: (before, after) => (before.enabled ? 'Its own posts were already on.' : `Resumed its own posts, at most one every ${after.intervalHours} hours.`),
  }),
  'posting.interval': change({
    kind: 'posting.interval',
    subsystem: 'POSTING',
    describe: `How often it may post on its own, as hours between posts (at least ${MIN_POST_INTERVAL_HOURS}). A ceiling, not a timetable.`,
    input: z.object({ hours: z.number().min(MIN_POST_INTERVAL_HOURS).max(24 * 14) }),
    read: readPosting,
    next: (before, input) => ({ ...before, intervalHours: input.hours }),
    // Posting less often is LOW; more often is doing more in public.
    risk: (before, after) => (after.intervalHours < before.intervalHours ? 'CONFIRM' : 'LOW'),
    write: (agentId, value) => writePosting(agentId, value),
    summary: (before, after) => `Posts at most every ${after.intervalHours} hours, was ${before.intervalHours}.`,
  }),
} as const;

export type ChangeKindId = keyof typeof CHANGES;
export const CHANGE_KINDS = Object.keys(CHANGES) as ChangeKindId[];

/**
 * What is never changed from chat, and where it is changed instead.
 *
 * Named so a request for one of them is recorded as refused with a reason
 * rather than silently not done, and so the model can say where to go.
 */
export const NEVER_FROM_CHAT = {
  financial: 'Money, tokens, wallets, keys and purchases are never changed or acted on from chat. The owner does those on the Wallet and Plugins screens, one exact transaction at a time.',
  credentials: 'Passwords, API keys and signed-in sessions are only changed on the Accounts and Providers screens.',
  identity_disclosure: 'Whether it may say it is not an AI is part of its identity policy and is only changed on the Policies screen.',
  permissions: 'What it is allowed to do, its capabilities and Plugins, is only changed on the Plugins screen.',
  other_agent: 'An agent only changes itself. Ask the other agent, by name.',
  delete_agent: 'Deleting an agent is only done from its page.',
  safety: 'Safety rules, reticence and do-not-contact lists are not changed from chat.',
} as const;
export type NeverKind = keyof typeof NEVER_FROM_CHAT;

// ── Doing it ────────────────────────────────────────────────────────────────

export interface ChangeOrigin {
  conversationId: string | null;
  messageId: string | null;
  text: string;
}

export interface ChangeOutcome {
  change: AgentChangeRow;
  /** A sentence for the owner. */
  message: string;
}

function equal(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function requireOwned(agentId: string, ownerId: string | null) {
  const agent = await agentsRepo.getAgent(agentId);
  // Somebody else's agent is reported exactly like a missing one.
  if (!agent || (ownerId !== null && agent.ownerId !== ownerId)) throw new NotFoundError('Agent');
  return agent;
}

/** Writes, reads back, and puts the old value back if the two disagree. */
async function applyChecked(kind: ChangeKind<never, unknown>, agentId: string, value: unknown, restore: unknown, ownerId: string | null, note: string) {
  await kind.write(agentId, value as never, ownerId, note);
  const readBack = await kind.read(agentId);
  if (equal(readBack, value)) return { agrees: true as const, readBack };
  await kind.write(agentId, restore as never, ownerId, `Put back: ${note}`).catch(() => undefined);
  return { agrees: false as const, readBack };
}

async function audit(ownerId: string | null, agentId: string, action: string, row: AgentChangeRow): Promise<void> {
  await ops.audit({
    actorUserId: ownerId,
    action,
    entityType: 'agent',
    entityId: agentId,
    data: { agentId, changeId: row.id, kind: row.kind, status: row.status, summary: row.summary },
  });
}

/** Records a request for something that is never changed from chat. */
export async function refuseChange(input: { agentId: string; ownerId: string | null; about: NeverKind; origin: ChangeOrigin }): Promise<ChangeOutcome> {
  await requireOwned(input.agentId, input.ownerId);
  const reason = NEVER_FROM_CHAT[input.about];
  const row = await changesRepo.create({
    agentId: input.agentId,
    ownerId: input.ownerId,
    conversationId: input.origin.conversationId,
    messageId: input.origin.messageId,
    requestText: input.origin.text,
    kind: `never.${input.about}`,
    subsystem: 'POLICY',
    risk: 'NEVER',
    status: 'REFUSED',
    summary: reason,
    beforeValue: null,
    afterValue: null,
  });
  await audit(input.ownerId, input.agentId, 'agent.change.refused', row);
  return { change: row, message: reason };
}

/**
 * Asks for one change to one agent.
 *
 * LOW applies now; CONFIRM is recorded and waits. Nothing that does not change
 * anything is written, so asking twice does not make a second version.
 */
export async function requestChange(input: {
  agentId: string;
  ownerId: string | null;
  kind: ChangeKindId;
  value: unknown;
  origin: ChangeOrigin;
}): Promise<ChangeOutcome> {
  await requireOwned(input.agentId, input.ownerId);
  const kind = CHANGES[input.kind] as unknown as ChangeKind<unknown, unknown> | undefined;
  if (!kind) throw new ValidationError(`There is no change called ${input.kind}.`);
  const parsed = kind.input.safeParse(input.value ?? {});
  if (!parsed.success) throw new ValidationError(`That change needs ${kind.describe.toLowerCase()}`);

  const base = {
    agentId: input.agentId,
    ownerId: input.ownerId,
    conversationId: input.origin.conversationId,
    messageId: input.origin.messageId,
    requestText: input.origin.text,
    kind: kind.kind,
    subsystem: kind.subsystem,
  };
  let before: unknown;
  try {
    before = await kind.read(input.agentId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const row = await changesRepo.create({ ...base, risk: 'LOW', status: 'FAILED', summary: message, beforeValue: null, afterValue: null, error: message });
    return { change: row, message };
  }
  const after = kind.next(before, parsed.data);
  const risk = kind.risk(before, after);
  const summary = kind.summary(before, after);
  if (equal(before, after)) {
    const row = await changesRepo.create({ ...base, risk, status: 'APPLIED', summary: `Nothing to change: ${summary}`, beforeValue: before, afterValue: after, verification: { unchanged: true } });
    return { change: row, message: `Nothing needed changing. ${summary}` };
  }
  if (risk === 'CONFIRM') {
    const row = await changesRepo.create({ ...base, risk, status: 'AWAITING_CONFIRMATION', summary, beforeValue: before, afterValue: after });
    await audit(input.ownerId, input.agentId, 'agent.change.proposed', row);
    return { change: row, message: `Waiting for you to confirm: ${summary}` };
  }
  const note = `From owner chat: ${summary}`;
  const checked = await applyChecked(kind as ChangeKind<never, unknown>, input.agentId, after, before, input.ownerId, note);
  const row = await changesRepo.create({
    ...base,
    risk,
    status: checked.agrees ? 'APPLIED' : 'FAILED',
    summary,
    beforeValue: before,
    afterValue: after,
    verification: { readBackAgrees: checked.agrees, readBack: checked.readBack },
    error: checked.agrees ? null : 'The setting read back differently, so the old value was put back.',
  });
  await audit(input.ownerId, input.agentId, checked.agrees ? 'agent.change.applied' : 'agent.change.failed', row);
  return { change: row, message: checked.agrees ? `Done. ${summary} You can undo it.` : 'That did not stick, so nothing was changed.' };
}

async function owned(changeId: string, ownerId: string | null): Promise<AgentChangeRow> {
  const row = await changesRepo.get(changeId);
  if (!row) throw new NotFoundError('Change');
  await requireOwned(row.agentId, ownerId);
  return row;
}

function kindOf(row: AgentChangeRow): ChangeKind<never, unknown> {
  const kind = CHANGES[row.kind as ChangeKindId] as unknown as ChangeKind<never, unknown> | undefined;
  if (!kind) throw new ValidationError('That change cannot be applied or undone.');
  return kind;
}

/** The owner pressed Confirm on a change that was waiting. */
export async function confirmChange(changeId: string, ownerId: string | null): Promise<ChangeOutcome> {
  const row = await owned(changeId, ownerId);
  if (row.status !== 'AWAITING_CONFIRMATION') throw new ValidationError('That change is not waiting for confirmation any more.');
  const kind = kindOf(row);
  const current = await kind.read(row.agentId);
  if (!equal(current, row.beforeValue)) {
    const moved = await changesRepo.transition(row.id, 'AWAITING_CONFIRMATION', 'FAILED', { error: 'The setting changed after this was asked for, so it was not applied.' });
    return { change: moved ?? row, message: 'That setting has changed since you asked, so nothing was applied. Ask again if you still want it.' };
  }
  const checked = await applyChecked(kind, row.agentId, row.afterValue, row.beforeValue, ownerId, `Confirmed from owner chat: ${row.summary}`);
  const moved = await changesRepo.transition(row.id, 'AWAITING_CONFIRMATION', checked.agrees ? 'APPLIED' : 'FAILED', {
    verification: { readBackAgrees: checked.agrees, readBack: checked.readBack },
    error: checked.agrees ? null : 'The setting read back differently, so the old value was put back.',
  });
  if (!moved) throw new ValidationError('That change was already decided.');
  await audit(ownerId, row.agentId, checked.agrees ? 'agent.change.applied' : 'agent.change.failed', moved);
  return { change: moved, message: checked.agrees ? `Done. ${row.summary}` : 'That did not stick, so nothing was changed.' };
}

export async function declineChange(changeId: string, ownerId: string | null): Promise<ChangeOutcome> {
  const row = await owned(changeId, ownerId);
  const moved = await changesRepo.transition(row.id, 'AWAITING_CONFIRMATION', 'DECLINED');
  if (!moved) throw new ValidationError('That change is not waiting for confirmation any more.');
  await audit(ownerId, row.agentId, 'agent.change.declined', moved);
  return { change: moved, message: 'Left as it was.' };
}

/** Puts back what a change replaced, if nothing has changed it since. */
export async function undoChange(changeId: string, ownerId: string | null): Promise<ChangeOutcome> {
  const row = await owned(changeId, ownerId);
  if (row.status !== 'APPLIED') throw new ValidationError('Only a change that was applied can be undone.');
  const kind = kindOf(row);
  const current = await kind.read(row.agentId);
  if (!equal(current, row.afterValue)) {
    throw new ValidationError('That setting has been changed again since, so undoing this would overwrite the newer change. Change it directly instead.');
  }
  const checked = await applyChecked(kind, row.agentId, row.beforeValue, row.afterValue, ownerId, `Undone from owner chat: ${row.summary}`);
  if (!checked.agrees) throw new ValidationError('The undo did not stick, so the setting was left as the change made it.');
  const moved = await changesRepo.transition(row.id, 'APPLIED', 'UNDONE', { verification: { ...row.verification, undoReadBackAgrees: true } });
  if (!moved) throw new ValidationError('That change was already undone.');
  await audit(ownerId, row.agentId, 'agent.change.undone', moved);
  return { change: moved, message: `Undone. ${row.summary.replace(/\.$/, '')} is reversed.` };
}

/** What changed for this agent since a moment, for "show me what you changed today". */
export async function changesSince(agentId: string, ownerId: string | null, since: string): Promise<AgentChangeRow[]> {
  await requireOwned(agentId, ownerId);
  return changesRepo.listForAgent(agentId, since, 100);
}

// ── Who a message in a room is asking ───────────────────────────────────────

/**
 * Whether a message asks for something to change, from its shape.
 *
 * An instruction at the start of a clause, not a word anywhere: "why did you
 * stop replying?" is a question about the past, "stop posting" is a change.
 */
const CHANGE_REQUEST =
  /(?:^|[.!?;:,]\s*|\b(?:please|pls|can you|could you|would you|i want you to|i'd like you to|i need you to)\s+|\b(?:you\s+(?:should|need to|must)\s+))(?:change|make|set|switch|turn|stop|start|pause|resume|use|add|remove|drop|update|be\s+(?:more|less)|don'?t|do not|never|always|post|tone down|tone up)\b/i;

export function looksLikeChangeRequest(text: string): boolean {
  return CHANGE_REQUEST.test(text.trim());
}

const EVERYONE = /\b(?:both of you|you both|you two|all of you|all three of you|everyone|everybody|each of you|all agents|every agent)\b/i;

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The message with whoever it opens by addressing taken off the front.
 *
 * "MEADGod stop posting" is a change for MEADGod; read with the name still on
 * it, the instruction is not at the start of a clause, the message counts as a
 * question, and the ordinary rule sends it to everybody in the room.
 */
function withoutAddressees(content: string, participants: ReadonlyArray<{ name: string; slug: string }>): string {
  const names = participants
    .flatMap((p) => [p.slug, p.name, p.name.replace(/\s+/g, '')])
    .filter((n) => n.length >= 3)
    .map(escape);
  const group = '(?:both of you|you both|you two|all of you|everyone|everybody|each of you|and|&)';
  const lead = new RegExp(`^(?:\\s*(?:hey\\s+|ok\\s+|okay\\s+)?(?:@?(?:${names.join('|')})|${group})[\\s,:;!.-]*)+`, 'i');
  return content.replace(lead, '').trim();
}

export interface Targeting {
  answerers: string[];
  /** Set when the message asks for a change and does not say to whom. */
  clarification: string | null;
}

/**
 * Who in a room a message is for, when it asks for a change.
 *
 * A named agent means that agent only; "both of you" or "everyone" means all;
 * a change request that names nobody in a room of several gets one question
 * back rather than changing everybody. Anything that is not a change keeps the
 * ordinary rule, where naming nobody asks everybody.
 */
export function changeTargets(
  content: string,
  participants: ReadonlyArray<{ agentId: string; name: string; slug: string }>,
  to: 'ALL' | string[] | null,
  ordinary: string[],
): Targeting {
  if (participants.length <= 1 || to !== null || !looksLikeChangeRequest(withoutAddressees(content, participants))) {
    return { answerers: ordinary, clarification: null };
  }
  if (EVERYONE.test(content)) return { answerers: participants.map((p) => p.agentId), clarification: null };
  const lower = content.toLowerCase();
  const named = participants.filter((p) =>
    [p.slug, p.name, p.name.replace(/\s+/g, '')]
      .map((n) => n.toLowerCase())
      .filter((n) => n.length >= 3)
      .some((n) => new RegExp(`(?:^|[^a-z0-9_])@?${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9_])`).test(lower)),
  );
  if (named.length > 0) return { answerers: named.map((p) => p.agentId), clarification: null };
  const names = participants.map((p) => p.name);
  const choices = names.length === 2 ? `${names[0]}, ${names[1]}, or both` : `${names.slice(0, -1).join(', ')}, ${names[names.length - 1]}, or everyone`;
  return {
    answerers: [],
    clarification: `Which of you should change: ${choices}? Say it again with a name, or "both of you", and only that agent changes.`,
  };
}
