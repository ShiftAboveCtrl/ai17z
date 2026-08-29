import { z } from 'zod';
import {
  ActionStatus,
  ActionType,
  ApprovalStatus,
  ChannelId,
  ErrorClass,
  EventType,
  JobStatus,
  MemoryScope,
  MemoryType,
  PromptLayerKey,
  ProviderKind,
  TraceEventType,
} from './enums';
import { QuotedPost } from './multimodal';

/**
 * Platform-independent inbound event. Channel adapters normalise into this shape;
 * nothing downstream of ingest is allowed to know what X or Discord look like.
 */
export const NormalizedEvent = z.object({
  channel: ChannelId,
  type: EventType,
  /** Stable id of the event on the remote side. The idempotency anchor. */
  remoteEventId: z.string().min(1).max(300),
  /** The message that triggered this, when the event is about a message. */
  remoteMessageId: z.string().max(300).nullable().default(null),
  remoteAuthorId: z.string().max(300).nullable().default(null),
  remoteAuthorHandle: z.string().max(300).nullable().default(null),
  remoteAuthorDisplayName: z.string().max(300).nullable().default(null),
  /** Thread / conversation grouping key on the remote side. */
  remoteConversationId: z.string().max(300).nullable().default(null),
  parentRemoteMessageId: z.string().max(300).nullable().default(null),
  /** Canonical permalink, when the channel has one. */
  remoteUrl: z.string().max(2_000).nullable().default(null),
  text: z.string().max(50_000).default(''),
  occurredAt: z.string().nullable().default(null),
  /** Raw adapter payload, kept for replay and forensics. Never trusted as input. */
  raw: z.record(z.unknown()).default({}),
});
export type NormalizedEvent = z.infer<typeof NormalizedEvent>;

export const ContextMessage = z.object({
  role: z.enum(['INBOUND', 'OUTBOUND']),
  remoteMessageId: z.string().nullable(),
  authorHandle: z.string().nullable(),
  text: z.string(),
  createdAt: z.string().nullable(),
});
export type ContextMessage = z.infer<typeof ContextMessage>;

/** One post in a conversation, with everything known about who wrote it. */
export const ContextPost = z.object({
  remoteId: z.string().max(300).nullable().default(null),
  remoteUrl: z.string().max(2_000).nullable().default(null),
  authorHandle: z.string().max(300).nullable().default(null),
  authorDisplayName: z.string().max(300).nullable().default(null),
  text: z.string().max(50_000).default(''),
  createdAt: z.string().nullable().default(null),
  /** Written by the account this agent operates. */
  isSelf: z.boolean().default(false),
});
export type ContextPost = z.infer<typeof ContextPost>;

export const BranchResolution = z.enum([
  /** The focal post was located by its own status id on a freshly loaded page. */
  'STATUS_ANCHORED',
  /** Nothing but the event itself was available; there is no branch. */
  'EVENT_ONLY',
]);
export type BranchResolution = z.infer<typeof BranchResolution>;

/**
 * The conversation branch leading to the incoming post.
 *
 * This is context and only context. Nothing in here may ever decide where an
 * action is sent: that is `ResolvedContext.targetRef`, which is anchored to the
 * incoming post's own status id. Confusing the two is how an agent ends up
 * replying to the root of a thread instead of the person who addressed it.
 *
 * `ancestors` is the path from the root down to the direct parent, oldest
 * first. Sibling branches are excluded by construction, not filtered later.
 */
export const ConversationContext = z.object({
  /** The post that addressed the agent. Always the action target. */
  incoming: ContextPost,
  /** What `incoming` is a reply to, when it is a reply at all. */
  parent: ContextPost.nullable().default(null),
  /** Root first, direct parent last. Empty when the incoming post is a root. */
  ancestors: z.array(ContextPost).default([]),
  root: ContextPost.nullable().default(null),
  quote: QuotedPost.nullable().default(null),
  /** Handles seen anywhere on the branch, in the order they first appear. */
  participants: z.array(z.string().max(300)).default([]),
  /** Posts on the page that belong to other branches and were left out. */
  excludedCount: z.number().int().min(0).default(0),
  method: BranchResolution.default('EVENT_ONLY'),
  /**
   * Whether the platform's own "replying to" line agrees with the parent this
   * resolver picked. False is not an error; X truncates that line. It means the
   * branch rests on render order alone.
   */
  branchConfirmed: z.boolean().default(false),
  /** Why the branch came out the way it did, in a sentence a person can read. */
  note: z.string().max(500).default(''),
});
export type ConversationContext = z.infer<typeof ConversationContext>;

/** What the channel adapter could establish about the situation. */
export const ResolvedContext = z.object({
  /**
   * ACTION TARGET. Canonical, normalised identity of the post that will receive
   * the reply — never an ancestor, never the root, never something inferred
   * from the conversation. Derived from the incoming post's own status id.
   */
  targetRef: z.string().max(2_000).nullable().default(null),
  targetUrl: z.string().max(2_000).nullable().default(null),
  targetAuthorHandle: z.string().max(300).nullable().default(null),
  conversationRef: z.string().max(300).nullable().default(null),
  incomingText: z.string().default(''),
  parentText: z.string().nullable().default(null),
  /** Prior turns the adapter could see, oldest first. */
  thread: z.array(ContextMessage).default([]),
  /** SEMANTIC CONTEXT. Structured branch, for prompts and for the debug view. */
  conversation: ConversationContext.nullable().default(null),
  /** Adapter-specific extras, surfaced in the trace but not in the prompt. */
  meta: z.record(z.unknown()).default({}),
});
export type ResolvedContext = z.infer<typeof ResolvedContext>;

export const RetrievedMemory = z.object({
  memoryId: z.string().uuid(),
  scope: MemoryScope,
  memoryType: MemoryType,
  content: z.string(),
  summary: z.string().nullable(),
  importance: z.number(),
  /** Human-readable justification, shown verbatim in the trace UI. */
  reason: z.string(),
  score: z.number(),
  rank: z.number().int(),
  createdAt: z.string().nullable(),
});
export type RetrievedMemory = z.infer<typeof RetrievedMemory>;

export const PromptLayer = z.object({
  key: PromptLayerKey,
  title: z.string(),
  role: z.enum(['system', 'user']),
  content: z.string(),
  /** Where this layer came from, e.g. "persona v3", "policy v1", "memory". */
  source: z.string(),
});
export type PromptLayer = z.infer<typeof PromptLayer>;

/** An image sent alongside a message, for models that can read one. */
export const ChatImage = z.object({
  /** Publicly reachable URL, or a data: URI when the bytes were retained. */
  url: z.string().max(2_000_000),
  /** Shown to the model so it knows which image is being referred to. */
  label: z.string().max(200).nullable().default(null),
});
export type ChatImage = z.infer<typeof ChatImage>;

export const ChatMessage = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string(),
  /**
   * Images attached to this turn. Providers that cannot read them ignore the
   * field; the gateway refuses to route a request carrying images to a model
   * not configured for vision, rather than silently dropping them.
   */
  images: z.array(ChatImage).max(8).optional(),
});
export type ChatMessage = z.infer<typeof ChatMessage>;

export const JobRecord = z.object({
  id: z.string().uuid(),
  eventId: z.string().uuid(),
  agentId: z.string().uuid(),
  accountId: z.string().uuid().nullable(),
  channel: ChannelId,
  actionType: ActionType,
  status: JobStatus,
  attemptCount: z.number().int(),
  maxAttempts: z.number().int(),
  dryRun: z.boolean(),
  requiresBrowser: z.boolean(),
  priority: z.number().int(),
  runAt: z.string(),
  lockedBy: z.string().nullable(),
  lockExpiresAt: z.string().nullable(),
  idempotencyKey: z.string(),
  conversationId: z.string().uuid().nullable(),
  personaVersionId: z.string().uuid().nullable(),
  policyVersionId: z.string().uuid().nullable(),
  pipelineVersionId: z.string().uuid().nullable(),
  promptTemplateVersionId: z.string().uuid().nullable(),
  currentNodeKey: z.string().nullable(),
  resolvedContext: ResolvedContext.nullable(),
  generatedOutput: z.string().nullable(),
  validatedOutput: z.string().nullable(),
  errorClass: ErrorClass.nullable(),
  lastError: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  contextResolvedAt: z.string().nullable(),
  memoryResolvedAt: z.string().nullable(),
  generatedAt: z.string().nullable(),
  validatedAt: z.string().nullable(),
  approvedAt: z.string().nullable(),
  executedAt: z.string().nullable(),
});
export type JobRecord = z.infer<typeof JobRecord>;

export const ActionRecord = z.object({
  id: z.string().uuid(),
  jobId: z.string().uuid(),
  agentId: z.string().uuid(),
  accountId: z.string().uuid().nullable(),
  channel: ChannelId,
  type: ActionType,
  status: ActionStatus,
  dryRun: z.boolean(),
  payload: z.record(z.unknown()),
  targetRef: z.string().nullable(),
  remoteActionId: z.string().nullable(),
  remoteActionUrl: z.string().nullable(),
  verification: z.record(z.unknown()).nullable(),
  idempotencyKey: z.string(),
  errorClass: ErrorClass.nullable(),
  lastError: z.string().nullable(),
  createdAt: z.string(),
  executedAt: z.string().nullable(),
});
export type ActionRecord = z.infer<typeof ActionRecord>;

export const ModelCallRecord = z.object({
  id: z.string().uuid(),
  jobId: z.string().uuid().nullable(),
  agentId: z.string().uuid().nullable(),
  purpose: z.string(),
  provider: ProviderKind,
  model: z.string(),
  modelRole: z.string().nullable(),
  attempt: z.number().int(),
  status: z.enum(['STARTED', 'COMPLETED', 'FAILED']),
  parameters: z.record(z.unknown()),
  promptLayers: z.array(PromptLayer).nullable(),
  promptText: z.string().nullable(),
  rawOutput: z.string().nullable(),
  requestId: z.string().nullable(),
  latencyMs: z.number().int().nullable(),
  promptTokens: z.number().int().nullable(),
  completionTokens: z.number().int().nullable(),
  estimatedCostUsd: z.number().nullable(),
  errorClass: ErrorClass.nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
});
export type ModelCallRecord = z.infer<typeof ModelCallRecord>;

export const TraceEvent = z.object({
  id: z.string(),
  jobId: z.string().uuid().nullable(),
  agentId: z.string().uuid().nullable(),
  type: TraceEventType,
  level: z.enum(['debug', 'info', 'warn', 'error']),
  message: z.string(),
  data: z.record(z.unknown()),
  at: z.string(),
});
export type TraceEvent = z.infer<typeof TraceEvent>;

export const Approval = z.object({
  id: z.string().uuid(),
  jobId: z.string().uuid(),
  status: ApprovalStatus,
  originalOutput: z.string(),
  editedOutput: z.string().nullable(),
  note: z.string().nullable(),
  requestedAt: z.string(),
  decidedAt: z.string().nullable(),
  decidedBy: z.string().uuid().nullable(),
});
export type Approval = z.infer<typeof Approval>;

export const MemoryRecord = z.object({
  id: z.string().uuid(),
  agentId: z.string().uuid(),
  scope: MemoryScope,
  memoryType: MemoryType,
  accountId: z.string().uuid().nullable(),
  conversationId: z.string().uuid().nullable(),
  remoteUserId: z.string().nullable(),
  remoteHandle: z.string().nullable(),
  content: z.string(),
  summary: z.string().nullable(),
  importance: z.number(),
  confidence: z.number(),
  pinned: z.boolean(),
  sourceEventId: z.string().uuid().nullable(),
  sourceJobId: z.string().uuid().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastAccessedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
});
export type MemoryRecord = z.infer<typeof MemoryRecord>;
