import type {
  Account,
  ActionType,
  ChannelId,
  NormalizedEvent,
  ResolvedContext,
} from '@xbam/shared/contracts';
import type { Logger } from '@xbam/shared';

/** Everything an adapter is given about the account it is acting for. */
export interface ChannelContext {
  account: Account;
  /** Session configuration for channels that drive a browser. */
  session: {
    mode: 'MANAGED' | 'CDP';
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
  ingestEvents(ctx: ChannelContext, options: IngestOptions): Promise<NormalizedEvent[]>;
  resolveContext(ctx: ChannelContext, event: NormalizedEvent): Promise<ResolvedContext>;
  verifyAction(ctx: ChannelContext, request: ActionRequest): Promise<VerificationResult>;
  executeAction(ctx: ChannelContext, request: ActionRequest): Promise<ActionResult>;
  captureDiagnostics(ctx: ChannelContext, reason: string): Promise<DiagnosticCapture | null>;
}
