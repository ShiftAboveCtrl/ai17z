import { DEFAULT_TRIGGER_EVENT_TYPES } from '@xbam/shared/contracts';
import type { PreflightResult, StartResult } from '@xbam/shared/contracts';
import { get, post, put } from './api';

/**
 * The writes both setup paths perform, in one place.
 *
 * Easy and Advanced ask different questions and lay themselves out differently,
 * and that is deliberate -- but underneath they create the same agent, attach
 * the same kind of model, connect the same kind of account and answer the same
 * question about whether it can run. Those four were written twice, and the
 * copies had already drifted: Advanced never asked whether the agent was ready
 * before sending somebody to it, so an agent could be created in AUTONOMOUS
 * with no model and nothing said so until its first job failed.
 *
 * What belongs here: the request, its shape, and the reason a field is what it
 * is. What does not: which questions a wizard asks, or how it arranges them.
 */

/** The agent itself. Persona and policy are whatever the caller collected. */
export interface AgentSeed {
  name: string;
  description?: string;
  avatarUrl?: string | null;
  persona?: Record<string, unknown>;
  policy?: Record<string, unknown>;
}

/**
 * Creates the agent and returns its id.
 *
 * The name is trimmed here rather than at each call site, because a trailing
 * space in a display name is invisible in the field and obvious in a reply.
 */
export async function createAgent(seed: AgentSeed): Promise<string> {
  const name = seed.name.trim();
  const agent = await post<{ id: string }>('/api/agents', {
    name,
    description: seed.description?.trim() ?? '',
    avatarUrl: seed.avatarUrl?.trim() || null,
    avatarMode: 'PORTRAIT_25D',
    persona: { displayName: name, ...seed.persona },
    policy: seed.policy ?? {},
  });
  return agent.id;
}

/**
 * Attaches a model to a role.
 *
 * `PUT` upserts on (agent, role), so calling this again with the same values is
 * a no-op and calling it from two places in one flow is safe. That matters:
 * the model is written both when a provider is tested and when the step is
 * left, because testing the key first and choosing the model after is the
 * obvious order and used to discard the model silently.
 */
export async function saveModel(
  agentId: string,
  input: { role: string; providerCredentialId: string; model: string; parameters?: Record<string, unknown> },
): Promise<void> {
  await put(`/api/agents/${agentId}/models`, {
    role: input.role,
    providerCredentialId: input.providerCredentialId,
    model: input.model.trim(),
    parameters: input.parameters ?? {},
  });
}

/**
 * Creates an account on a channel and links it to the agent.
 *
 * The link carries `DEFAULT_TRIGGER_EVENT_TYPES` rather than a list written out
 * here. Defaulting it to `["MENTION"]` alone once meant two of the four radar
 * monitors had every REPLY they found dropped at ingest, and the default lives
 * in `contracts/enums.ts` and nowhere else for exactly that reason.
 */
export async function connectAccount(
  agentId: string,
  input: { channel: string; handle: string; displayName: string; actionType?: string },
): Promise<{ id: string; status: string }> {
  // The API returns the existing account when this handle is already
  // connected, so reconnecting one is not an error -- and its status is what
  // tells the caller whether a sign-in window is needed at all.
  const account = await post<{ id: string; status: string }>('/api/accounts', {
    channel: input.channel,
    handle: input.handle.trim().replace(/^@/, ''),
    displayName: input.displayName,
  });
  await post(`/api/agents/${agentId}/accounts`, {
    accountId: account.id,
    triggerEventTypes: [...DEFAULT_TRIGGER_EVENT_TYPES],
    actionType: input.actionType ?? 'REPLY',
  });
  return account;
}

/** Whether this agent could run right now. A read: it changes nothing. */
export async function preflightAgent(agentId: string, signal?: AbortSignal): Promise<PreflightResult> {
  return get<PreflightResult>(`/api/agents/${agentId}/preflight`, signal);
}

/**
 * Starts the agent, or says what is stopping it.
 *
 * `started: false` is not an error and must not be rendered as one -- it is the
 * check having done its job before the agent went ACTIVE and failed on its
 * first job.
 */
export async function startAgent(agentId: string): Promise<StartResult> {
  return post<StartResult>(`/api/agents/${agentId}/start`, {});
}
