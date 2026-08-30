import type {
  Account,
  ActionType,
  ChannelId,
  NormalizedEvent,
  RadarPollResult,
  RadarSourceKind,
  ResolvedContext,
} from '@xbam/shared/contracts';
import type { Logger } from '@xbam/shared';

/** Everything an adapter is given about the account it is acting for. */
export interface ChannelContext {
  account: Account;
  /** Session configuration for channels that drive a browser. */
  session: {
    /** Which binary. Named after the browser, not after the arrangement. */
    engine: 'GOOGLE_CHROME' | 'MICROSOFT_EDGE' | 'PLAYWRIGHT_CHROMIUM' | 'CUSTOM_CDP';
    mode: 'MANAGED' | 'CDP';
    /** Legacy field, kept so existing rows read cleanly. Prefer `engine`. */
    channel: 'chrome' | 'msedge' | 'chromium';
    profileDir: string | null;
    cdpUrl: string | null;
  } | null;
  /** Absolute path for screenshots and other artifacts. */
  storageDir: string;
  logger: Logger;
  /** Correlation id, present when the call belongs to a job. */
  jobId: string | null;
}

export interface ConnectionResult {
  status: Account['status'];
  detail: string;
  remoteAccountId?: string | null;
  handle?: string | null;
}

export interface HealthResult {
  status: 'healthy' | 'degraded' | 'offline' | 'unknown';
  detail: string;
  /** True when the remote considers this session authenticated. */
  authenticated: boolean;
}

/**
 * What an open sign-in window currently shows.
 *
 * Normalised on purpose: the worker drives the waiting loop and must never learn
 * what a particular service's challenge looks like. `CHALLENGE` is terminal for
 * the loop — the window is handed back to the person and nothing further is
 * clicked, typed, or dismissed on their behalf.
 */
/** One thing a channel's browser found on the open web. */
export interface LookedUp {
  title: string;
  snippet: string;
  url: string | null;
}

export interface AuthObservation {
  state: 'SIGNED_IN' | 'AWAITING_LOGIN' | 'AUTHENTICATING' | 'CHALLENGE' | 'UNREACHABLE';
  /** A sentence for the person watching. Never contains challenge content. */
  detail: string;
  /** Which kind of challenge, when state is CHALLENGE. */
  challengeKind?: string | null;
  handle?: string | null;
}

export interface RadarPollRequest {
  kind: RadarSourceKind;
  /** Handle, keyword, query, or own status id, depending on the kind. */
  target: string | null;
  limit: number;
  /** Where the previous poll stopped, when this source keeps a mark. */
  cursor: string | null;
}

export interface IngestOptions {
  /** Remote event ids already recorded; the adapter should skip them. */
  since?: string | null;
  limit: number;
}

export interface ActionRequest {
  type: ActionType;
  /** Canonical identity of the remote object being acted on. */
  targetRef: string | null;
  text: string;
  idempotencyKey: string;
  /**
   * When true the adapter must resolve and verify the target, then stop without
   * changing anything on the remote. This is the dry-run boundary.
   */
  dryRun: boolean;
}

export interface VerificationResult {
  verified: boolean;
  /** Human-readable explanation, stored on the action and shown in the trace. */
  detail: string;
  targetRef: string | null;
  targetUrl: string | null;
  targetAuthorHandle: string | null;
  evidence: Record<string, unknown>;
}

export interface ActionResult {
  status: 'EXECUTED' | 'DRY_RUN';
  remoteActionId: string | null;
  remoteActionUrl: string | null;
  verification: VerificationResult;
}

export interface DiagnosticCapture {
  kind: string;
  message: string;
  url: string | null;
  /** Path relative to the storage directory, when a screenshot was taken. */
  screenshotRelPath: string | null;
  meta: Record<string, unknown>;
}

/**
 * The seam between XBAM and the outside world.
 *
 * Nothing platform-specific may leak past this interface: no selectors, no
 * cookies, no vendor payloads. Memory, prompts, policy and job state all operate
 * exclusively on the normalised shapes above.
 */
export interface ChannelAdapter {
  readonly id: ChannelId;
  readonly displayName: string;
  readonly capabilities: readonly ActionType[];
  /** True when this adapter needs a browser session to function. */
  readonly requiresBrowser: boolean;

  connect(ctx: ChannelContext): Promise<ConnectionResult>;
  disconnect(ctx: ChannelContext): Promise<void>;
  healthCheck(ctx: ChannelContext): Promise<HealthResult>;
  /**
   * Looks at an already-open sign-in window and reports what it shows. Optional:
   * a channel that needs no browser sign-in simply does not implement it.
   */
  /**
   * Looks something up on the open web, using the browser this channel already
   * has open. Optional: a channel with no browser simply cannot, and the
   * research step reports that as a gap rather than pretending.
   */
  lookUp?(ctx: ChannelContext, request: { query: string; kind: 'search' | 'link' }): Promise<LookedUp[]>;

  observeAuth?(ctx: ChannelContext): Promise<AuthObservation>;
  /**
   * Polls one radar source and reports what it saw.
   *
   * Optional. A channel with a single reliable delivery surface has no use for
   * several monitors and simply does not implement this; the account poller
   * still calls ingestEvents.
   */
  pollRadarSource?(ctx: ChannelContext, request: RadarPollRequest): Promise<RadarPollResult>;
  /** Which radar sources this channel can actually run. */
  readonly radarSourceKinds?: readonly RadarSourceKind[];
  ingestEvents(ctx: ChannelContext, options: IngestOptions): Promise<NormalizedEvent[]>;
  resolveContext(ctx: ChannelContext, event: NormalizedEvent): Promise<ResolvedContext>;
  verifyAction(ctx: ChannelContext, request: ActionRequest): Promise<VerificationResult>;
  executeAction(ctx: ChannelContext, request: ActionRequest): Promise<ActionResult>;
  captureDiagnostics(ctx: ChannelContext, reason: string): Promise<DiagnosticCapture | null>;
}
