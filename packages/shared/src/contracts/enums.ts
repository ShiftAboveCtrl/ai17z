import { z } from 'zod';

/** Build a zod enum from a readonly tuple, keeping the literal union type. */
function enumOf<const T extends readonly [string, ...string[]]>(values: T) {
  return { values, schema: z.enum(values) };
}

export const AGENT_STATES = ['DRAFT', 'ACTIVE', 'PAUSED', 'ERROR'] as const;
export const AgentState = enumOf(AGENT_STATES).schema;
export type AgentState = (typeof AGENT_STATES)[number];

/**
 * How the agent identity relates to a real entity. Drives disclosure behaviour in
 * the prompt engine and the validator. Deliberately explicit: the platform never
 * hard-codes "behave as a real person and never deny it" the way AI4CZ did.
 */
export const IDENTITY_KINDS = [
  'FICTIONAL',
  'INSPIRED_BY',
  'BRAND',
  'REAL_PERSON_AUTHORIZED',
  'DISCLOSED_AI',
] as const;
export const IdentityKind = enumOf(IDENTITY_KINDS).schema;
export type IdentityKind = (typeof IDENTITY_KINDS)[number];

export const DISCLOSURE_MODES = ['NONE', 'ON_REQUEST', 'ALWAYS'] as const;
export const DisclosureMode = enumOf(DISCLOSURE_MODES).schema;
export type DisclosureMode = (typeof DISCLOSURE_MODES)[number];

/**
 * What an agent is permitted to do on its own.
 *
 * OFF          nothing: no polling, no ingest, no work
 * MONITOR_ONLY events are recorded, but no job is created and nothing generates
 * MANUAL_ONLY  work happens only when a person triggers it
 * REVIEW_BEFORE_ACTION generates, then waits for a person before acting
 * AUTONOMOUS   acts within the policy limits
 */
export const AUTOMATION_MODES = [
  'OFF',
  'MONITOR_ONLY',
  'MANUAL_ONLY',
  'REVIEW_BEFORE_ACTION',
  'AUTONOMOUS',
] as const;
export const AutomationMode = enumOf(AUTOMATION_MODES).schema;
export type AutomationMode = (typeof AUTOMATION_MODES)[number];

export const CHANNELS = ['mock', 'x', 'discord', 'telegram', 'slack', 'email', 'http'] as const;
export const ChannelId = enumOf(CHANNELS).schema;
export type ChannelId = (typeof CHANNELS)[number];

export const ACCOUNT_STATUSES = ['DISCONNECTED', 'CONNECTING', 'CONNECTED', 'NEEDS_AUTH', 'ERROR'] as const;
export const AccountStatus = enumOf(ACCOUNT_STATUSES).schema;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const BROWSER_MODES = ['MANAGED', 'CDP'] as const;
export const BrowserMode = enumOf(BROWSER_MODES).schema;
export type BrowserMode = (typeof BROWSER_MODES)[number];

export const EVENT_TYPES = [
  'MENTION',
  'REPLY',
  'DIRECT_MESSAGE',
  'NEW_MESSAGE',
  'KEYWORD_MATCH',
  'WEBHOOK',
  'SCHEDULED_TRIGGER',
  'MANUAL_TRIGGER',
] as const;
export const EventType = enumOf(EVENT_TYPES).schema;
export type EventType = (typeof EVENT_TYPES)[number];

export const ACTION_TYPES = [
  'REPLY',
  'POST',
  'DIRECT_MESSAGE',
  'LIKE',
  'REACT',
  'CALL_TOOL',
  'CALL_API',
  'NONE',
] as const;
export const ActionType = enumOf(ACTION_TYPES).schema;
export type ActionType = (typeof ACTION_TYPES)[number];

/**
 * Job lifecycle. `*_ING` states are held under a worker lease; the recovery sweep
 * returns expired leases to the settled state that precedes them.
 */
export const JOB_STATUSES = [
  'RECEIVED',
  'CONTEXT_RESOLVING',
  'CONTEXT_RESOLVED',
  'MEMORY_RETRIEVING',
  'MEMORY_RESOLVED',
  'GENERATING',
  'GENERATED',
  'VALIDATING',
  'VALIDATED',
  'WAITING_FOR_APPROVAL',
  'EXECUTING',
  'EXECUTED',
  'DRY_RUN_COMPLETED',
  'RETRYABLE_FAILURE',
  'PERMANENT_FAILURE',
  'REVIEW_REQUIRED',
  'CANCELLED',
] as const;
export const JobStatus = enumOf(JOB_STATUSES).schema;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** Settled states a worker may claim and advance. */
export const CLAIMABLE_JOB_STATUSES: readonly JobStatus[] = [
  'RECEIVED',
  'CONTEXT_RESOLVED',
  'MEMORY_RESOLVED',
  'GENERATED',
  'VALIDATED',
  'RETRYABLE_FAILURE',
];

export const IN_FLIGHT_JOB_STATUSES: readonly JobStatus[] = [
  'CONTEXT_RESOLVING',
  'MEMORY_RETRIEVING',
  'GENERATING',
  'VALIDATING',
  'EXECUTING',
];

export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = [
  'EXECUTED',
  'DRY_RUN_COMPLETED',
  'PERMANENT_FAILURE',
  'CANCELLED',
];

/** States that need a human before anything else can happen. */
export const HUMAN_GATED_JOB_STATUSES: readonly JobStatus[] = ['WAITING_FOR_APPROVAL', 'REVIEW_REQUIRED'];

/** Maps an in-flight state back to the settled state a recovered job resumes from. */
export const IN_FLIGHT_RESUME: Readonly<Record<string, JobStatus>> = {
  CONTEXT_RESOLVING: 'RECEIVED',
  MEMORY_RETRIEVING: 'CONTEXT_RESOLVED',
  GENERATING: 'MEMORY_RESOLVED',
  VALIDATING: 'GENERATED',
  EXECUTING: 'VALIDATED',
};

export const ERROR_CLASSES = ['RETRYABLE', 'PERMANENT', 'REVIEW_REQUIRED'] as const;
export const ErrorClass = enumOf(ERROR_CLASSES).schema;
export type ErrorClass = (typeof ERROR_CLASSES)[number];

export const MEMORY_SCOPES = ['THREAD', 'USER', 'PERSONA', 'ACCOUNT', 'KNOWLEDGE', 'EPISODIC'] as const;
export const MemoryScope = enumOf(MEMORY_SCOPES).schema;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export const MEMORY_TYPES = [
  'CONVERSATION_TURN',
  'FACT',
  'PREFERENCE',
  'COMMITMENT',
  'STYLE_EXAMPLE',
  'DOCUMENT',
  'SUMMARY',
  'EVENT_ARCHIVE',
] as const;
export const MemoryType = enumOf(MEMORY_TYPES).schema;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export const PROVIDER_KINDS = [
  'openai',
  'anthropic',
  'openrouter',
  'deepseek',
  'ollama',
  'openai_compatible',
  'mock',
] as const;
export const ProviderKind = enumOf(PROVIDER_KINDS).schema;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export const MODEL_ROLES = ['primary', 'fallback_1', 'fallback_2', 'classifier'] as const;
export const ModelRole = enumOf(MODEL_ROLES).schema;
export type ModelRole = (typeof MODEL_ROLES)[number];

export const PIPELINE_NODE_KINDS = [
  'TRIGGER',
  'RESOLVE_CONTEXT',
  'RETRIEVE_MEMORY',
  'ASSEMBLE_PERSONA',
  'GENERATE',
  'VALIDATE',
  'APPROVAL_GATE',
  'EXECUTE_ACTION',
  'PERSIST',
] as const;
export const PipelineNodeKind = enumOf(PIPELINE_NODE_KINDS).schema;
export type PipelineNodeKind = (typeof PIPELINE_NODE_KINDS)[number];

export const PROMPT_LAYER_KEYS = [
  'SYSTEM_RULES',
  'IDENTITY',
  'PERSONA_FACTS',
  'STYLE',
  'SAFETY_DISCLOSURE',
  'RETRIEVED_MEMORY',
  'IMMEDIATE_CONTEXT',
  'TOOLS',
  'TASK',
  'OUTPUT_CONTRACT',
] as const;
export const PromptLayerKey = enumOf(PROMPT_LAYER_KEYS).schema;
export type PromptLayerKey = (typeof PROMPT_LAYER_KEYS)[number];

export const TRACE_EVENT_TYPES = [
  'JOB_CREATED',
  'JOB_CLAIMED',
  'CONTEXT_RESOLVED',
  'MEMORY_SELECTED',
  'PROMPT_ASSEMBLED',
  'MODEL_REQUEST_STARTED',
  'MODEL_REQUEST_COMPLETED',
  'MODEL_REQUEST_FAILED',
  'VALIDATION_PASSED',
  'VALIDATION_FAILED',
  'APPROVAL_REQUESTED',
  'APPROVAL_DECIDED',
  'ACTION_STARTED',
  'TARGET_VERIFIED',
  'TARGET_VERIFICATION_FAILED',
  'ACTION_COMPLETED',
  'ACTION_FAILED',
  'ACTION_SKIPPED_DUPLICATE',
  'DRY_RUN_STOPPED',
  'MEMORY_WRITTEN',
  'JOB_RETRY_SCHEDULED',
  'JOB_FAILED_PERMANENT',
  'JOB_RECOVERED',
  'JOB_CANCELLED',
  'DIAGNOSTIC_CAPTURED',
] as const;
export const TraceEventType = enumOf(TRACE_EVENT_TYPES).schema;
export type TraceEventType = (typeof TRACE_EVENT_TYPES)[number];

export const ACTION_STATUSES = ['PENDING', 'EXECUTING', 'EXECUTED', 'DRY_RUN', 'FAILED', 'SKIPPED_DUPLICATE'] as const;
export const ActionStatus = enumOf(ACTION_STATUSES).schema;
export type ActionStatus = (typeof ACTION_STATUSES)[number];

export const APPROVAL_STATUSES = ['PENDING', 'APPROVED', 'REJECTED'] as const;
export const ApprovalStatus = enumOf(APPROVAL_STATUSES).schema;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const AVATAR_MODES = ['IMAGE', 'PORTRAIT_25D', 'MODEL_3D'] as const;
export const AvatarMode = enumOf(AVATAR_MODES).schema;
export type AvatarMode = (typeof AVATAR_MODES)[number];
