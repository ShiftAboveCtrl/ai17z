import { z } from 'zod';
import { AutomationMode, DisclosureMode } from './enums';
import { MediaPolicy } from './multimodal';

export const IdentityPolicy = z.object({
  disclosure: DisclosureMode.default('ON_REQUEST'),
  /**
   * Whether the agent is permitted to assert it is not an AI. Default false.
   * AI4CZ hard-coded "never deny your identity" into the prompt; XBAM makes that
   * an explicit, auditable policy choice instead of a platform default.
   */
  mayDenyBeingAI: z.boolean().default(false),
  /** Sentence used when disclosure is required or requested. */
  disclosureStatement: z.string().max(500).default('I am an AI agent.'),
  /** Named real person or organisation this agent is authorised to represent. */
  representedEntity: z.string().max(200).default(''),
});
export type IdentityPolicy = z.infer<typeof IdentityPolicy>;

export const OutputPolicy = z.object({
  maxCharacters: z.number().int().positive().max(20_000).default(280),
  minCharacters: z.number().int().min(0).max(1_000).default(1),
  forbidHashtags: z.boolean().default(false),
  forbidLinks: z.boolean().default(false),
  forbidMentionsOfOthers: z.boolean().default(false),
  stripSurroundingQuotes: z.boolean().default(true),
  /** Reject output containing any of these (case-insensitive substring match). */
  bannedPhrases: z.array(z.string().max(200)).max(500).default([]),
});
export type OutputPolicy = z.infer<typeof OutputPolicy>;

export const ContentPolicy = z.object({
  blockedTopics: z.array(z.string().max(200)).max(500).default([]),
  blockedRemoteHandles: z.array(z.string().max(120)).max(2_000).default([]),
  /** When non-empty, only these remote handles may be replied to. */
  allowedRemoteHandles: z.array(z.string().max(120)).max(2_000).default([]),
  /** Handles belonging to the agent itself. Never act on our own content. */
  selfHandles: z.array(z.string().max(120)).max(50).default([]),
});
export type ContentPolicy = z.infer<typeof ContentPolicy>;

export const RatePolicy = z.object({
  maxActionsPerHour: z.number().int().min(0).max(10_000).default(20),
  maxActionsPerDay: z.number().int().min(0).max(100_000).default(200),
  minSecondsBetweenActions: z.number().int().min(0).max(86_400).default(30),
  workingHours: z
    .object({
      enabled: z.boolean().default(false),
      timezone: z.string().max(64).default('UTC'),
      startHour: z.number().int().min(0).max(23).default(8),
      endHour: z.number().int().min(0).max(23).default(23),
    })
    .default({}),
});
export type RatePolicy = z.infer<typeof RatePolicy>;

export const SafetyPolicy = z.object({
  /** Refuse to act unless the adapter positively identified the remote target. */
  requireTargetVerification: z.boolean().default(true),
  /** Send failed validations to a human instead of retrying blindly. */
  reviewOnValidationFailure: z.boolean().default(true),
  maxAttempts: z.number().int().min(1).max(20).default(5),
  /** After this many retryable failures, escalate to REVIEW_REQUIRED. */
  reviewAfterAttempts: z.number().int().min(1).max(20).default(3),
});
export type SafetyPolicy = z.infer<typeof SafetyPolicy>;

export const BudgetPolicy = z.object({
  maxModelCallsPerJob: z.number().int().min(1).max(50).default(4),
  maxCostUsdPerDay: z.number().min(0).max(10_000).nullable().default(null),
});
export type BudgetPolicy = z.infer<typeof BudgetPolicy>;

const ScopeRetrieval = z.object({
  enabled: z.boolean().default(true),
  limit: z.number().int().min(0).max(200).default(10),
});

export const MemoryPolicy = z.object({
  retrieval: z
    .object({
      thread: ScopeRetrieval.default({ enabled: true, limit: 12 }),
      user: ScopeRetrieval.default({ enabled: true, limit: 8 }),
      persona: ScopeRetrieval.default({ enabled: true, limit: 6 }),
      account: ScopeRetrieval.default({ enabled: false, limit: 4 }),
      knowledge: ScopeRetrieval.default({ enabled: true, limit: 6 }),
      episodic: ScopeRetrieval.default({ enabled: false, limit: 3 }),
      /** Hard ceiling on the rendered RETRIEVED_MEMORY layer. */
      totalCharBudget: z.number().int().min(200).max(200_000).default(6_000),
    })
    .default({}),
  write: z
    .object({
      /** Persist both sides of every exchange as THREAD memory. */
      thread: z.object({ enabled: z.boolean().default(true) }).default({}),
      user: z
        .object({
          enabled: z.boolean().default(true),
          /** heuristic = deterministic pattern extractor; model = classifier call. */
          extractor: z.enum(['off', 'heuristic', 'model']).default('heuristic'),
          minImportance: z.number().min(0).max(1).default(0.5),
          ttlDays: z.number().int().min(1).max(3_650).nullable().default(null),
        })
        .default({}),
      persona: z.object({ enabled: z.boolean().default(false) }).default({}),
    })
    .default({}),
});
export type MemoryPolicy = z.infer<typeof MemoryPolicy>;

export const ToolPolicy = z.object({
  /** Tool keys this agent may call. Empty means no tools. */
  allowed: z.array(z.string().max(120)).max(200).default([]),
});
export type ToolPolicy = z.infer<typeof ToolPolicy>;

/** The complete, versioned policy document attached to an agent. */
export const PolicyConfig = z.object({
  automation: z
    .object({
      mode: AutomationMode.default('REVIEW_BEFORE_ACTION'),
      /** When true, the pipeline runs end-to-end but never touches the remote. */
      dryRunDefault: z.boolean().default(true),
    })
    .default({}),
  identity: IdentityPolicy.default({}),
  output: OutputPolicy.default({}),
  content: ContentPolicy.default({}),
  rate: RatePolicy.default({}),
  safety: SafetyPolicy.default({}),
  budget: BudgetPolicy.default({}),
  memory: MemoryPolicy.default({}),
  tools: ToolPolicy.default({}),
  /** What the agent looks at besides the text: images, quotes, links. */
  media: MediaPolicy.default({}),
});
export type PolicyConfig = z.infer<typeof PolicyConfig>;

export const DEFAULT_POLICY: PolicyConfig = PolicyConfig.parse({});

export const PolicyDraft = z.object({
  config: PolicyConfig,
  changeNote: z.string().max(500).default(''),
});
export type PolicyDraft = z.infer<typeof PolicyDraft>;
