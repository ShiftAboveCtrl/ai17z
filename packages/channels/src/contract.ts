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
  /**
   * Opens the stored sign-in details, for a channel that signs in over an API
   * rather than through a browser.
   *
   * A function, not a value, for the reason `LoginCredentials` is never placed on
   * this object: the plaintext exists only for the length of the call that asks
   * for it, and a context is passed around, logged by accident and kept in
   * closures. Absent for every channel that has a browser session instead.
   */
  credentials?: () => Promise<LoginCredentials | null>;
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
  /**
   * Who the session is actually signed in as, when that can be read.
   *
   * "Signed in" without "as whom" is not enough to act on. Almost everything
   * downstream keys off the account's handle -- mention search runs `@handle`,
   * the engagement heuristic decides "addressed to this account" from it, and
   * own-thread tracking follows it -- so a stored handle that no longer matches
   * the live session produces an agent that searches for somebody else's
   * mentions and never recognises being spoken to. Silently, and for ever.
   */
  handle?: string | null;
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

/**
 * Sign-in details an owner chose to store, handed to an adapter to type in.
 *
 * Plaintext, in memory, for the length of one call. It is never placed on the
 * ChannelContext, never logged, and never written to a browser task's
 * parameters or result -- the worker reads the sealed row itself and passes it
 * straight through to the adapter.
 */
export interface LoginCredentials {
  loginUsername: string;
  loginPassword: string;
}

/**
 * What came of typing them in.
 *
 * `observation` is the same normalised shape the watcher already understands,
 * so a challenge ends this exactly as it ends a hand sign-in. `filled` records
 * which steps were answered -- never the values -- because "X asked for a code
 * after the password went in" and "X asked for a code before anything was
 * typed" are different situations to put in front of an owner.
 */
export interface CredentialSignInResult {
  observation: AuthObservation;
  filled: ('username' | 'password')[];
}

export interface RadarPollRequest {
  kind: RadarSourceKind;
  /** Handle, keyword, query, or own status id, depending on the kind. */
  target: string | null;
  limit: number;
  /** Where the previous poll stopped, when this source keeps a mark. */
  cursor: string | null;
}

/**
 * How much of what was waiting an adapter actually read.
 *
 * `complete: false` means there is more beyond what was returned, and `resume`
 * is the adapter's own token for where to carry on. The caller must not treat
 * what it was handed as everything: moving a "seen up to here" mark past events
 * that were never read is how they are skipped for ever.
 */
export interface IngestProgress {
  complete: boolean;
  /** Opaque, meaningful only to the adapter that issued it. Null when complete. */
  resume: string | null;
  /** True when a stored continuation was refused and the read started again from the newest. */
  restarted?: boolean;
}

export interface IngestOptions {
  /** Remote event ids already recorded; the adapter should skip them. */
  since?: string | null;
  limit: number;
  /**
   * Whether one more read of the remote may happen now. Absent means yes.
   *
   * An adapter that reads several pages in one call asks before each page after
   * the first, so the one read budget is honoured per read and not per call.
   */
  canReadAnother?: () => Promise<boolean>;
  /** Called after each read of the remote, so each one is charged to the budget. */
  onRead?: () => Promise<void>;
  /** Called once, with how much of what was waiting was read. */
  report?: (progress: IngestProgress) => void;
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
  /**
   * Set for a channel that signs in over an API with stored details rather than
   * through a browser. Such an account can still be signed out, which is a thing
   * to tell a person; `requiresBrowser` alone said only the browser channels could.
   */
  readonly signInKind?: 'APP_PASSWORD';

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

  /**
   * Whether this action already happened on the remote.
   *
   * Asked when an action is recovered after the worker performing it died:
   * it may have died before X saw it or after, and only the remote knows.
   * Without this, recovery is a duplicate-post machine.
   */
  wasAlreadyDone?(ctx: ChannelContext, request: ActionRequest): Promise<{
    done: boolean;
    remoteActionId: string | null;
    remoteActionUrl: string | null;
    detail: string;
    /**
     * Set only when `done: false` is proof, not an absence of evidence: the
     * remote was read completely and the action is not there. A scan that
     * failed to read, or a timeline that may simply lag, leaves this unset.
     * Paths that must never send twice resend only on a conclusive answer.
     */
    conclusive?: boolean;
  }>;

  observeAuth?(ctx: ChannelContext): Promise<AuthObservation>;
  /**
   * Types stored sign-in details into the service's own login form.
   *
   * Optional, opt-in, and separate from `observeAuth` on purpose: observing a
   * sign-in and acting on one are different operations and are named
   * differently so neither can become the other by accident. An adapter that
   * implements it is still bound by the same rule -- the moment the service
   * asks for a code, a CAPTCHA, a key, or confirmation that the sign-in was
   * really the owner, it must stop and return `CHALLENGE` with the page
   * untouched. Nothing here answers a security challenge.
   */
  signInWithCredentials?(ctx: ChannelContext, credentials: LoginCredentials): Promise<CredentialSignInResult>;
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
