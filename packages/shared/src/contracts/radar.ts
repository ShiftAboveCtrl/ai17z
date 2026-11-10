import { z } from 'zod';

/**
 * The ways AI17Z can notice that something happened.
 *
 * Each is independent. The point of having several is that none of them is
 * trusted to be complete: X notifications drop things, search misses things,
 * and a thread can collect replies that produce no notification at all.
 */
export const RADAR_SOURCE_KINDS = [
  /** The platform's own notifications surface. One source, not the truth. */
  'notifications',
  /** Searching for the account's handle, to catch mentions notifications lost. */
  'mention_search',
  /** Searching for replies addressed to the account. */
  'reply_search',
  /** Walking the agent's own recent posts and reading what is underneath them. */
  'own_threads',
  /** Watching a specific account. Watching is not permission to reply to it. */
  'tracked_account',
  /** Watching a keyword, phrase, ticker, or custom query. */
  'tracked_keyword',
  /**
   * The agent going looking on its own, from its persona's topics. One search
   * per growth session, filtered by engagement and ranked by audience.
   */
  'persona_discovery',
  /** Owner-pinned, read-only chain observations. Never an X read. */
  'market_signal',
] as const;
export const RadarSourceKind = z.enum(RADAR_SOURCE_KINDS);
export type RadarSourceKind = (typeof RADAR_SOURCE_KINDS)[number];

/** Kinds that need a target; the rest watch the account itself. */
export const RADAR_KINDS_NEEDING_TARGET: readonly RadarSourceKind[] = ['tracked_account', 'tracked_keyword'];

export const RADAR_STATUSES = ['UNKNOWN', 'HEALTHY', 'DEGRADED', 'FAILING', 'DISABLED'] as const;
export const RadarStatus = z.enum(RADAR_STATUSES);
export type RadarStatus = (typeof RADAR_STATUSES)[number];

/** Decode identity length rather than accepting arbitrary base58-looking text. */
function exactSignalAddress(address: string): boolean {
  if (/^0x[0-9a-fA-F]{40}$/.test(address)) return true;
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return false;
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let value = 0n;
  for (const char of address) value = value * 58n + BigInt(alphabet.indexOf(char));
  const leading = address.match(/^1*/)?.[0].length ?? 0;
  const bytes = value === 0n ? 0 : Math.ceil(value.toString(16).length / 2);
  return leading + bytes === 32;
}

export const SignalWatch = z.object({
  chain: z.string().trim().regex(/^[a-z0-9_]{1,30}$/),
  address: z.string().trim().max(120).refine(exactSignalAddress, 'Use an exact mint or address, never a ticker.'),
  predicate: z.enum(['liquidity_below', 'concentration_above', 'new_pool', 'wallet_transaction']),
  threshold: z.number().finite().nonnegative().max(1e15).optional(),
  /** Studio's index metrics are distinct from the native pool and RPC metrics. */
  studioMetric: z.enum(['LIQUIDITY_BELOW', 'TOP_HOLDERS_ABOVE', 'DEVELOPER_SHARE_ABOVE']).optional(),
}).strict().superRefine((watch, ctx) => {
  if (watch.chain === 'solana' && watch.address.startsWith('0x')) ctx.addIssue({ code: 'custom', message: 'A Solana mint must be a Solana address.' });
  if (watch.studioMetric && (watch.chain !== 'solana' || watch.predicate !== (watch.studioMetric === 'LIQUIDITY_BELOW' ? 'liquidity_below' : 'concentration_above'))) ctx.addIssue({ code: 'custom', message: 'The Studio index metric must match its condition.' });
  if (watch.predicate === 'liquidity_below' || watch.predicate === 'concentration_above') {
    if (watch.threshold === undefined || (watch.predicate === 'concentration_above' && watch.threshold > 100)) {
      ctx.addIssue({ code: 'custom', message: 'Set a threshold in USD, or a concentration percentage from 0 to 100.' });
    }
  }
});
export type SignalWatch = z.infer<typeof SignalWatch>;
export const SignalUniverse = z.array(SignalWatch).min(1).max(12).refine(
  watches => new Set(watches.map(w => JSON.stringify(w))).size === watches.length,
  'Each pin and predicate must be unique.',
);

export interface SignalObservation {
  value: number | string | string[] | null;
  source: string;
  observedAt: string;
  definition: string;
  /** Individual upstream reads when a metric combines multiple observations. */
  reads?: { source: string; observedAt: string }[];
  /** Pool creation times from the provider, keyed by exact pool address. */
  poolCreatedAt?: Record<string, string>;
}
export interface SignalState {
  baseline: SignalObservation;
  latest: SignalObservation;
  active: boolean;
  generation: number;
}

/**
 * Where a radar source came from. Computed from the config the writer alone
 * sets, never from the label: a label is text an owner may type.
 *
 * `STUDIO_RISK_WATCH` and `PLAYBOOK` are both sources a sync recreates, so
 * neither can be switched off or removed by hand: the next tick would undo it.
 */
export type RadarSourceProvenance = 'OWNER' | 'STUDIO_RISK_WATCH' | 'PLAYBOOK';

/**
 * Whether a config marks a Studio risk source: a present, non-null object.
 *
 * This is the one rule. The SQL twin is `jsonb_typeof(config->'studioRisk') =
 * 'object'` in `signals.ts`, and an integration test feeds both the same
 * configs. The two used to differ: `config ? 'studioRisk'` is true for a JSON
 * null, a boolean or a string, which `config?.studioRisk` treated as truthy or
 * falsy by a different rule again.
 */
export function hasStudioRiskMark(config: { studioRisk?: unknown } | null | undefined): boolean {
  const mark = config?.studioRisk;
  return typeof mark === 'object' && mark !== null && !Array.isArray(mark);
}

export function radarSourceProvenance(config: { studioRisk?: unknown; playbookAgentId?: unknown } | null | undefined): RadarSourceProvenance {
  if (hasStudioRiskMark(config)) return 'STUDIO_RISK_WATCH';
  // Present and not JSON null, as the playbook sync reads it with jsonb_typeof.
  return config?.playbookAgentId != null ? 'PLAYBOOK' : 'OWNER';
}

export interface SignalRadarData {
  receipts?: SignalReceipt[];
  baselines: { sourceId: string; watchKey: string; watch: SignalWatch; state: SignalState | null; lastRead: SignalObservation | null; reason: string; provenance: RadarSourceProvenance }[];
  candidates: {
    id: string; sourceId: string; provenance: RadarSourceProvenance;
    evidence: { watch: SignalWatch; before: SignalObservation; after: SignalObservation };
    reason: string; ideaStatus: string | null; ideaError: string | null;
    jobStatus: string | null; jobError: string | null;
    postingEnabled?: boolean | null; postingReason?: string | null;
  }[];
}

export interface SignalReceipt {
  id: string; actionId: string; windowHours: number; dueAt: string;
  evidence: { watch: SignalWatch; before: SignalObservation; after: SignalObservation };
  nowRead: SignalObservation | null; verdict: 'changed' | 'unchanged' | 'unavailable' | null;
  status: string; reason: string; jobStatus: string | null; jobError: string | null;
  ideaStatus: string | null; ideaError: string | null; publishedActionId: string | null;
}

export const RadarSourceConfig = z.object({
  /** Internal playbook source: the worker rotates exact mints from the current pin. */
  playbookAgentId: z.string().uuid().optional(),
  playbookPinId: z.string().uuid().optional(),
  /** Base gap between polls of this source. */
  intervalSeconds: z.number().int().min(20).max(86_400).default(180),
  /** Results pulled per poll. */
  limit: z.number().int().min(1).max(100).default(20),
  /**
   * Whether candidates from this source may create jobs, or only inform context.
   * Watching an account is not permission to reply to it (§8).
   */
  mayTrigger: z.boolean().default(true),
  /** Higher runs sooner when several sources are due at once. */
  priority: z.number().int().min(0).max(100).default(50),
  /**
   * For persona discovery: search terms the owner pinned. When present they
   * are used alone, in turn; when absent the persona's topics are.
   */
  queries: z.array(z.string().min(1).max(200)).max(20).optional(),
  /**
   * For persona discovery: the fewest likes a post needs before X returns it.
   * Applied by X itself, so a post nobody has responded to costs nothing.
   */
  minFaves: z.number().int().min(0).max(100_000).optional(),
  /** Exact owner pins; this source is opt-in and bounded independently of X. */
  watches: SignalUniverse.optional(),
  /** Set only by the locally opted-in Studio watch bridge. */
  studioRisk: z.object({ bindingId: z.string().uuid(), agentId: z.string().uuid(), watchId: z.string().uuid(), watchRevision: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
});
export type RadarSourceConfig = z.infer<typeof RadarSourceConfig>;

/**
 * One thing a monitor noticed.
 *
 * Deliberately not an event: a candidate is what a single source saw. The
 * reconciler decides whether several candidates are the same post, and only then
 * does an event exist.
 */
export const RadarCandidate = z.object({
  /**
   * The post's own identity on the remote side — a status id for X. This is what
   * makes the same post seen through three monitors one event rather than three.
   */
  remoteId: z.string().min(1).max(300),
  remoteUrl: z.string().max(2_000).nullable().default(null),
  authorHandle: z.string().max(300).nullable().default(null),
  authorId: z.string().max(300).nullable().default(null),
  authorDisplayName: z.string().max(300).nullable().default(null),
  text: z.string().max(50_000).default(''),
  /** The post this one replies to, when the source could see it. */
  parentRemoteId: z.string().max(300).nullable().default(null),
  conversationRemoteId: z.string().max(300).nullable().default(null),
  occurredAt: z.string().nullable().default(null),
  /** What kind of thing this looked like where it was found. */
  eventType: z.string().max(50).default('MENTION'),
  raw: z.record(z.string(), z.unknown()).prefault({}),
});
export type RadarCandidate = z.infer<typeof RadarCandidate>;

/** What one poll of one source produced. */
export const RadarPollResult = z.object({
  candidates: z.array(RadarCandidate).default([]),
  /** New high-water mark, when the source has one. */
  cursor: z.string().max(300).nullable().default(null),
  /** Set when the source could not be read. */
  error: z.string().nullable().default(null),
  /**
   * The public counts on the post this source was pointed at.
   *
   * Only `own_threads` sets it, and only because it is already standing on the
   * page: checking one of the agent's own posts for replies means loading the
   * post, and the numbers underneath it are right there. Recording them here
   * is what makes measurement a by-product of work already being done rather
   * than a second loop asking X how a post is doing.
   *
   * Absent when X did not render them. Absent is not zero.
   */
  targetCounts: z
    .object({
      replies: z.number().int().nonnegative().optional(),
      reposts: z.number().int().nonnegative().optional(),
      likes: z.number().int().nonnegative().optional(),
      bookmarks: z.number().int().nonnegative().optional(),
      views: z.number().int().nonnegative().optional(),
    })
    .optional(),
});
export type RadarPollResult = z.infer<typeof RadarPollResult>;

/** Health of one source, for the UI. */
export const RadarSourceHealth = z.object({
  id: z.string().uuid(),
  kind: RadarSourceKind,
  target: z.string().nullable(),
  label: z.string(),
  enabled: z.boolean(),
  status: RadarStatus,
  lastPollAt: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
  lastResultAt: z.string().nullable(),
  lastError: z.string().nullable(),
  consecutiveFailures: z.number().int(),
  nextPollAt: z.string().nullable(),
});
export type RadarSourceHealth = z.infer<typeof RadarSourceHealth>;
