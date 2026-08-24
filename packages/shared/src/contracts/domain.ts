import { z } from 'zod';
import {
  AccountStatus,
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
});
export type ModelConfig = z.infer<typeof ModelConfig>;

export const ModelParameters = z.object({
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  maxTokens: z.number().int().min(1).max(32_000).optional(),
  frequencyPenalty: z.number().min(-2).max(2).optional(),
  presencePenalty: z.number().min(-2).max(2).optional(),
  stop: z.array(z.string()).max(8).optional(),
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
  /** Reserved for branching. Null means unconditional. */
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

export const BrowserSession = z.object({
  id: z.string().uuid(),
  accountId: z.string().uuid(),
  mode: BrowserMode,
  profileDir: z.string().nullable(),
  cdpUrl: z.string().nullable(),
  status: z.string(),
  lastCheckedAt: z.string().nullable(),
  lastError: z.string().nullable(),
});
export type BrowserSession = z.infer<typeof BrowserSession>;
