import { z } from 'zod';
import {
  BrowserEngine,
  AccountStatus,
  PipelineBranch,
  ActionType,
  AgentState,
  AvatarMode,
  BrowserMode,
  ChannelId,
  EventType,
  ModelRole,
  PipelineNodeKind,
  ProviderKind,
} from './enums';

/** Which browser build an account drives. Real Chrome carries a real session. */
export const BROWSER_CHANNELS = ['chrome', 'msedge', 'chromium'] as const;
export const BrowserChannel = z.enum(BROWSER_CHANNELS);
export type BrowserChannel = (typeof BROWSER_CHANNELS)[number];

export const Agent = z.object({
  id: z.string().uuid(),
  ownerId: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  avatarUrl: z.string().nullable(),
  avatarMode: AvatarMode,
  state: AgentState,
  lastError: z.string().nullable(),
  personaVersionId: z.string().uuid().nullable(),
  policyVersionId: z.string().uuid().nullable(),
  pipelineVersionId: z.string().uuid().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Agent = z.infer<typeof Agent>;

export const CreateAgentInput = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9-]{1,62}$/, 'lowercase letters, digits and dashes')
    .optional(),
  description: z.string().max(2_000).default(''),
  avatarUrl: z.string().max(2_000).nullable().default(null),
  avatarMode: AvatarMode.default('PORTRAIT_25D'),
});
export type CreateAgentInput = z.infer<typeof CreateAgentInput>;

export const UpdateAgentInput = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(2_000).optional(),
  avatarUrl: z.string().max(2_000).nullable().optional(),
  avatarMode: AvatarMode.optional(),
  state: AgentState.optional(),
});
export type UpdateAgentInput = z.infer<typeof UpdateAgentInput>;

export const Account = z.object({
  id: z.string().uuid(),
  ownerId: z.string().uuid(),
  channel: ChannelId,
  remoteAccountId: z.string().nullable(),
  handle: z.string(),
  displayName: z.string(),
  status: AccountStatus,
  enabled: z.boolean(),
  capabilities: z.array(z.string()),
  settings: z.record(z.unknown()),
  lastHealthCheckAt: z.string().nullable(),
  lastHealthStatus: z.string().nullable(),
  lastActivityAt: z.string().nullable(),
  lastError: z.string().nullable(),
  /** When a sign-in was started and when it gives up. Null when none is running. */
  authStartedAt: z.string().nullable().default(null),
  authDeadlineAt: z.string().nullable().default(null),
  /** Which kind of challenge is waiting on the owner. Never its content. */
  challengeKind: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Account = z.infer<typeof Account>;

export const CreateAccountInput = z.object({
  channel: ChannelId,
  handle: z.string().trim().min(1).max(120),
  displayName: z.string().trim().max(200).default(''),
  remoteAccountId: z.string().max(200).nullable().default(null),
  settings: z.record(z.unknown()).default({}),
  browser: z
    .object({
      mode: BrowserMode.default('MANAGED'),
      channel: BrowserChannel.default('chromium'),
      cdpUrl: z.string().max(500).default(''),
    })
    .optional(),
});
export type CreateAccountInput = z.infer<typeof CreateAccountInput>;

export const AgentAccountLink = z.object({
  agentId: z.string().uuid(),
  accountId: z.string().uuid(),
  /** Which inbound event types on this account create jobs for this agent. */
  triggerEventTypes: z.array(EventType),
  /** The action the pipeline performs in response. */
  actionType: ActionType,
  enabled: z.boolean(),
});
export type AgentAccountLink = z.infer<typeof AgentAccountLink>;

export const ProviderCredential = z.object({
  id: z.string().uuid(),
  ownerId: z.string().uuid(),
  provider: ProviderKind,
  label: z.string(),
  baseUrl: z.string().nullable(),
  /** Short non-reversible fingerprint so the UI can tell two keys apart. */
  keyFingerprint: z.string().nullable(),
  hasKey: z.boolean(),
  enabled: z.boolean(),
  availableModels: z.array(z.string()),
  defaultModel: z.string().nullable(),
  timeoutMs: z.number().int(),
  lastCheckedAt: z.string().nullable(),
  lastStatus: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ProviderCredential = z.infer<typeof ProviderCredential>;

export const CreateProviderInput = z.object({
  provider: ProviderKind,
  label: z.string().trim().min(1).max(120),
  baseUrl: z.string().trim().max(500).nullable().default(null),
  /** Write-only. Never returned by the API. */
  apiKey: z.string().max(500).nullable().default(null),
  availableModels: z.array(z.string().max(200)).max(500).default([]),
  defaultModel: z.string().max(200).nullable().default(null),
  timeoutMs: z.number().int().min(1_000).max(600_000).default(60_000),
  enabled: z.boolean().default(true),
});
export type CreateProviderInput = z.infer<typeof CreateProviderInput>;

export const ModelConfig = z.object({
  id: z.string().uuid(),
  agentId: z.string().uuid(),
  role: ModelRole,
  providerCredentialId: z.string().uuid(),
  provider: ProviderKind,
  providerLabel: z.string(),
  model: z.string(),
  parameters: z.record(z.unknown()),
  /**
   * What the provider said it offers when it was last tested.
   *
   * Carried so `model` can be checked against it. An agent pointed at a model
   * the provider has retired reads as entirely healthy on every screen and
   * fails every generation, and nothing else in the system notices.
   *
   * Empty means the provider publishes no list, which is not evidence the
   * model is missing.
   */
  providerModels: z.array(z.string()).default([]),
  /**
   * When that list was taken, because a list has an age and the age decides
   * what an absence from it means.
   *
   * Without this the check could only say "not in the list" and had to guess
   * at what that implied. It guessed "retired", and on a live installation it
   * was wrong: see `staleModel`.
   */
  providerCheckedAt: z.string().nullable().default(null),
  providerStatus: z.string().nullable().default(null),
});
export type ModelConfig = z.infer<typeof ModelConfig>;

/**
 * Whether an agent's chosen model is one its provider listed when last asked.
 *
 * Null when there is nothing to say: no list to check against, which is the
 * ordinary case for providers that do not publish one.
 *
 * ## It used to answer a question it could not answer
 *
 * The sentence was "<provider> no longer offers "<model>". This agent cannot
 * generate with it." Both halves are conclusions, and the only fact underneath
 * them is that a name is absent from a stored list.
 *
 * Measured on ai17z-test, where that sentence was shown against four of the
 * seven roles at once. The stored list was `["deepseek-flash",
 * "deepseek-v4-pro"]`, taken five days earlier and never refreshed, and
 * `deepseek-v4-flash` had completed twelve calls in the previous three hours.
 * So the screen told an owner that four working roles were dead, in a place
 * where the obvious response is to go and reconfigure them.
 *
 * The comment on `providerModels` already had the right instinct for the
 * neighbouring case: an empty list "is not evidence the model is missing". A
 * list that is merely old is the same kind of not-evidence, and this now says
 * what it knows and when it knew it rather than what it suspects. The warning
 * is kept, because an agent pointed at a genuinely retired model does read as
 * healthy everywhere and fail every generation. What it may not do is state a
 * cause as a fact.
 */
export function staleModel(
  config: Pick<ModelConfig, 'model' | 'providerModels' | 'providerLabel' | 'providerCheckedAt'>,
): string | null {
  if (config.providerModels.length === 0) return null;
  if (config.providerModels.includes(config.model)) return null;
  const when = asOf(config.providerCheckedAt);
  return (
    `${config.providerLabel} did not list "${config.model}" ${when}. ` +
    'That may mean it was retired, or only that the list is out of date.'
  );
}

/** "when it was last checked, on 15 September", or just the vaguer half. */
function asOf(checkedAt: string | null | undefined): string {
  if (!checkedAt) return 'when it was last checked';
  const at = new Date(checkedAt);
  if (Number.isNaN(at.getTime())) return 'when it was last checked';
  return `when it was last checked, on ${at.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}`;
}

export const ModelParameters = z.object({
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  maxTokens: z.number().int().min(1).max(32_000).optional(),
  frequencyPenalty: z.number().min(-2).max(2).optional(),
  presencePenalty: z.number().min(-2).max(2).optional(),
  stop: z.array(z.string()).max(8).optional(),
  /** Attempts against this one provider before the chain moves on. */
  maxRetries: z.number().int().min(1).max(5).optional(),
  /** Reasoning models only. Ignored by providers that do not accept it. */
  reasoningEffort: z.enum(['low', 'medium', 'high']).optional(),
  /** Optional real prices, per 1k tokens. Cost is only estimated when set. */
  costPer1kPromptUsd: z.number().min(0).max(1000).optional(),
  costPer1kCompletionUsd: z.number().min(0).max(1000).optional(),
});
export type ModelParameters = z.infer<typeof ModelParameters>;

export const SetModelConfigInput = z.object({
  role: ModelRole,
  providerCredentialId: z.string().uuid(),
  model: z.string().trim().min(1).max(200),
  parameters: ModelParameters.default({}),
});
export type SetModelConfigInput = z.infer<typeof SetModelConfigInput>;

export const PipelineNode = z.object({
  key: z.string().max(60),
  kind: PipelineNodeKind,
  label: z.string().max(120),
  config: z.record(z.unknown()).default({}),
  x: z.number().default(0),
  y: z.number().default(0),
});
export type PipelineNode = z.infer<typeof PipelineNode>;

export const PipelineEdge = z.object({
  from: z.string().max(60),
  to: z.string().max(60),
  /** Which outcome of the source node this edge follows. */
  branch: PipelineBranch.default('next'),
  /** Human-readable note shown on the edge. Never evaluated. */
  condition: z.string().max(200).nullable().default(null),
});
export type PipelineEdge = z.infer<typeof PipelineEdge>;

export const PipelineDraft = z.object({
  name: z.string().trim().min(1).max(120),
  nodes: z.array(PipelineNode).min(1).max(100),
  edges: z.array(PipelineEdge).max(200),
  changeNote: z.string().max(500).default(''),
});
export type PipelineDraft = z.infer<typeof PipelineDraft>;

/** One of the three role-bound tabs an account's browser keeps open. */
export const BrowserTabStatus = z.object({
  role: z.enum(['ACTION', 'MENTIONS', 'NOTIFICATIONS', 'RESEARCH']),
  state: z.enum(['READY', 'BUSY', 'MISSING', 'FAILED']),
  url: z.string().nullable().default(null),
  openedAt: z.string().nullable().default(null),
  lastUsedAt: z.string().nullable().default(null),
  lastError: z.string().nullable().default(null),
  /**
   * Why this tab was last replaced, in a sentence somebody can read.
   *
   * Recovery an owner cannot see is indistinguishable from a fault: a renderer
   * running out of memory and being replaced correctly showed up as nothing
   * but a run of failed polls. Defaulted rather than required, so a snapshot
   * published by an older worker still parses.
   */
  recycled: z
    .object({ at: z.string(), because: z.string().max(300) })
    .nullable()
    .default(null),
});
export type BrowserTabStatus = z.infer<typeof BrowserTabStatus>;

export const BrowserSession = z.object({
  id: z.string().uuid(),
  accountId: z.string().uuid(),
  /** Which browser binary. This is the field that decides what runs. */
  engine: BrowserEngine.default('GOOGLE_CHROME'),
  mode: BrowserMode,
  /** Superseded by `engine`; kept so old rows and old clients still read. */
  channel: BrowserChannel,
  profileDir: z.string().nullable(),
  cdpUrl: z.string().nullable(),
  status: z.string(),
  lastCheckedAt: z.string().nullable(),
  lastError: z.string().nullable(),
  /** Evidence of what actually ran, recorded at launch. */
  executablePath: z.string().nullable().default(null),
  browserProduct: z.string().nullable().default(null),
  browserVersion: z.string().nullable().default(null),
  browserPid: z.number().int().nullable().default(null),
  cdpProduct: z.string().nullable().default(null),
  verifiedAt: z.string().nullable().default(null),
  /**
   * What each tab is doing, written by the worker. The API owns no browsers, so
   * this is the only way the account page can tell a dead monitor from a quiet
   * one.
   */
  tabs: z.array(BrowserTabStatus).default([]),
  tabsUpdatedAt: z.string().nullable().default(null),
});
export type BrowserSession = z.infer<typeof BrowserSession>;
