import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { ContextPost, NormalizedEvent, ResolvedContext } from '@xbam/shared/contracts';
import { PipelineError, sha256Hex } from '@xbam/shared';
import type {
  ActionRequest,
  ActionResult,
  ChannelAdapter,
  ChannelContext,
  ConnectionResult,
  DiagnosticCapture,
  HealthResult,
  IngestOptions,
  VerificationResult,
} from '../contract';

/**
 * A complete, deterministic channel with no external dependency.
 *
 * Events arrive by explicit injection through the API rather than by polling, so
 * the whole pipeline (context, memory, prompt, model, validation, approval,
 * execution, verification, trace) can be exercised end to end with no network,
 * no credentials, and no risk of touching a real account.
 */
export const mockAdapter: ChannelAdapter = {
  id: 'mock',
  displayName: 'Mock channel',
  capabilities: ['REPLY', 'POST', 'DIRECT_MESSAGE'],
  requiresBrowser: false,
  supportsMedia: true,

  async connect(): Promise<ConnectionResult> {
    return { status: 'CONNECTED', detail: 'Mock channel is always available.' };
  },

  async disconnect(): Promise<void> {
    // Nothing to tear down; the mock channel holds no external resources.
  },

  async healthCheck(): Promise<HealthResult> {
    return { status: 'healthy', detail: 'Deterministic local channel', authenticated: true };
  },

  async ingestEvents(_ctx: ChannelContext, _options: IngestOptions): Promise<NormalizedEvent[]> {
    // Mock events are pushed in from the UI or tests, never polled.
    return [];
  },

  async resolveContext(_ctx: ChannelContext, event: NormalizedEvent): Promise<ResolvedContext> {
    const raw = event.raw as { parentText?: unknown; thread?: unknown };
    const parentText = typeof raw.parentText === 'string' && raw.parentText.trim() ? raw.parentText : null;
    const targetRef = event.remoteMessageId ?? event.remoteEventId;

    // The mock has no page to read, so the branch is whatever the caller stated.
    // Reported as EVENT_ONLY for exactly that reason: a resolver that says it
    // read a thread it never saw is worse than one that admits it did not.
    const incoming: ContextPost = {
      remoteId: targetRef,
      remoteUrl: event.remoteUrl,
      authorHandle: event.remoteAuthorHandle,
      authorDisplayName: event.remoteAuthorDisplayName,
      text: event.text,
      createdAt: event.occurredAt,
      isSelf: false,
      // The mock channel has no notion of a verified account, and saying so is
      // what makes "only answer verified accounts" refuse rather than pass.
      authorVerified: null,
    };
    const parent: ContextPost | null = parentText
      ? {
          remoteId: event.parentRemoteMessageId,
          remoteUrl: null,
          authorHandle: null,
          authorDisplayName: null,
          text: parentText,
          createdAt: null,
          isSelf: false,
          authorVerified: null,
        }
      : null;

    return {
      targetRef,
      targetUrl: event.remoteUrl,
      targetAuthorHandle: event.remoteAuthorHandle,
      conversationRef: event.remoteConversationId ?? event.remoteEventId,
      incomingText: event.text,
      parentText,
      thread: [],
      conversation: {
        incoming,
        parent,
        ancestors: parent ? [parent] : [],
        root: parent,
        quote: null,
        participants: event.remoteAuthorHandle ? [event.remoteAuthorHandle] : [],
        excludedCount: 0,
        method: 'EVENT_ONLY',
        branchConfirmed: false,
        note: parent
          ? 'Mock channel: the parent was supplied with the event, not read from a page.'
          : 'Mock channel: only the incoming message is known.',
      },
      meta: { channel: 'mock', resolvedAt: new Date().toISOString() },
    };
  },

  async verifyAction(_ctx: ChannelContext, request: ActionRequest): Promise<VerificationResult> {
    // A post has no target to verify. The mock lists POST as a capability, and
    // refusing every post for lacking a target meant no post could ever be
    // driven to completion on the one channel tests are allowed to use.
    if (!request.targetRef && request.type === 'POST') {
      return {
        verified: true,
        detail: 'A post has no target; nothing to verify.',
        targetRef: null,
        targetUrl: null,
        targetAuthorHandle: null,
        evidence: { mock: true, post: true },
      };
    }
    if (!request.targetRef) {
      return {
        verified: false,
        detail: 'No target reference was supplied.',
        targetRef: null,
        targetUrl: null,
        targetAuthorHandle: null,
        evidence: {},
      };
    }
    return {
      verified: true,
      detail: `Mock target ${request.targetRef} resolved.`,
      targetRef: request.targetRef,
      targetUrl: `mock://message/${request.targetRef}`,
      targetAuthorHandle: null,
      evidence: { mock: true },
    };
  },

  async executeAction(ctx: ChannelContext, request: ActionRequest): Promise<ActionResult> {
    const verification = await mockAdapter.verifyAction(ctx, request);
    if (!verification.verified) {
      throw PipelineError.review(
        'target_unverified',
        `Mock channel could not verify the target: ${verification.detail}`,
      );
    }
    // What an upload would be given. The mock has no browser, but it still
    // reads each file and compares it with the hash it was handed, so a path
    // that does not lead to the approved bytes fails here the way it would at
    // an uploader, and the evidence names what was carried.
    const media = request.media ?? [];
    const carried: Array<{ kind: string; mime: string; bytes: number; sha256: string }> = [];
    for (const item of media) {
      const bytes = await readFile(item.path).catch(() => null);
      if (!bytes || createHash('sha256').update(bytes).digest('hex') !== item.sha256) {
        throw PipelineError.retryable('media_upload_failed', 'Mock channel could not read an attached file as it was approved.');
      }
      carried.push({ kind: item.kind, mime: item.mime, bytes: item.bytes, sha256: item.sha256.slice(0, 12) });
    }
    if (carried.length > 0) {
      verification.evidence = { ...verification.evidence, media: carried };
    }
    if (request.dryRun) {
      return { status: 'DRY_RUN', remoteActionId: null, remoteActionUrl: null, verification };
    }
    if (carried.length > 0) {
      verification.evidence = { ...verification.evidence, mediaConfirmed: true };
    }
    // Stable id derived from the idempotency key, so replaying a test produces
    // the same remote id and duplicate detection can be asserted.
    const remoteActionId = `mock-${sha256Hex(request.idempotencyKey).slice(0, 16)}`;
    return {
      status: 'EXECUTED',
      remoteActionId,
      remoteActionUrl: `mock://message/${remoteActionId}`,
      verification,
    };
  },

  async captureDiagnostics(_ctx: ChannelContext, reason: string): Promise<DiagnosticCapture | null> {
    return {
      kind: 'mock_diagnostic',
      message: reason,
      url: null,
      screenshotRelPath: null,
      meta: { channel: 'mock' },
    };
  },
};
