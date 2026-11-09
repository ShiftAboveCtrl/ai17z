import { PipelineError } from '@xbam/shared';
import type { BlueskyPost, BlueskyProfile, BlueskyThread } from '@xbam/shared/contracts';
import type { ChannelContext } from '../contract';
import {
  BlueskyApiError,
  authed,
  classifyBlueskyError,
  serviceTargetFor,
  xrpc,
  type ServiceTarget,
} from './client';
import {
  branchFromThread,
  THREAD_GAP_NOTES,
  parsePostViews,
  toBlueskyPost,
  toBlueskyProfile,
  type PostView,
  type ThreadBranch,
} from './normalise';
import { isDid, isHandle, normaliseHandle, parsePostReference, POST_COLLECTION } from './uri';

/**
 * Reading Bluesky: the half of the channel that never changes anything.
 *
 * Each function takes a `ChannelContext` and answers in the normalised shapes, so
 * a capability or a pipeline step can ask what a post says without learning that
 * it came from an XRPC call. They are also where read errors become classified
 * failures: a missing post is permanent, a rate limit carries the wait the server
 * stated, and silence is retryable.
 */

/** How far up a thread is read. Past this the branch says it stopped short. */
export const MAX_ANCESTORS = 12;

export function targetOf(ctx: ChannelContext): ServiceTarget {
  return serviceTargetFor(ctx.account.settings);
}

/** Resolves a handle to a DID, or null when there is no such handle. */
export async function resolveHandle(ctx: ChannelContext, handle: string): Promise<string | null> {
  const wanted = normaliseHandle(handle);
  if (isDid(wanted)) return wanted;
  if (!isHandle(wanted)) return null;
  try {
    const body = await xrpc<{ did?: unknown }>(targetOf(ctx), 'com.atproto.identity.resolveHandle', {
      params: { handle: wanted },
    });
    return typeof body.did === 'string' && isDid(body.did) ? body.did : null;
  } catch (error) {
    // "No such handle" is an answer. Anything else is a failure to ask.
    if (error instanceof BlueskyApiError && error.status === 400) return null;
    throw classifyBlueskyError(error, `looking up @${wanted}`);
  }
}

/**
 * Turns whatever names a post into its at:// URI.
 *
 * Only a bsky.app address needs the network (its author is a handle). A
 * reference that is not a post at all is refused with a sentence, because the
 * mistake worth catching is a model passing the handle it was talking about.
 */
export async function resolvePostUri(ctx: ChannelContext, reference: string): Promise<string> {
  const parsed = parsePostReference(reference);
  if (!parsed) {
    throw PipelineError.permanent(
      'bluesky_bad_reference',
      'That is not a Bluesky post. Give an at:// post URI or a bsky.app post address, not a handle.',
    );
  }
  if (parsed.kind === 'uri') return parsed.uri;
  const did = await resolveHandle(ctx, parsed.actor);
  if (!did) {
    throw PipelineError.permanent('bluesky_not_found', `There is no Bluesky account called ${parsed.actor}.`);
  }
  return `at://${did}/${POST_COLLECTION}/${parsed.rkey}`;
}

/** Up to 25 posts by URI. Posts that no longer exist are simply absent. */
export async function fetchPostViews(ctx: ChannelContext, uris: string[]): Promise<PostView[]> {
  if (uris.length === 0) return [];
  if (uris.length > 25) throw new RangeError('Bluesky returns at most 25 posts per call.');
  try {
    const body = await authed<unknown>(ctx, targetOf(ctx), 'app.bsky.feed.getPosts', { params: { uris } });
    return parsePostViews(body);
  } catch (error) {
    throw classifyBlueskyError(error, 'reading a post');
  }
}

export async function threadBranchOf(ctx: ChannelContext, uri: string): Promise<ThreadBranch> {
  try {
    const body = await authed<unknown>(ctx, targetOf(ctx), 'app.bsky.feed.getPostThread', {
      params: { uri, depth: 0, parentHeight: MAX_ANCESTORS + 1 },
    });
    return branchFromThread(body, MAX_ANCESTORS);
  } catch (error) {
    // The thread endpoint reports a missing post as an error, not as a node.
    if (error instanceof BlueskyApiError && (error.code === 'NotFound' || error.code === 'RecordNotFound')) {
      return { found: false, reason: 'NOT_FOUND' };
    }
    throw classifyBlueskyError(error, 'reading a thread');
  }
}

export async function readPost(ctx: ChannelContext, reference: string): Promise<BlueskyPost> {
  const uri = await resolvePostUri(ctx, reference);
  const [view] = await fetchPostViews(ctx, [uri]);
  if (!view) throw PipelineError.permanent('bluesky_not_found', 'That post was not found. It may have been deleted.');
  return toBlueskyPost(view);
}

export async function readThread(ctx: ChannelContext, reference: string): Promise<BlueskyThread> {
  const uri = await resolvePostUri(ctx, reference);
  const branch = await threadBranchOf(ctx, uri);
  if (!branch.found) {
    if (branch.reason === 'UNREADABLE') {
      throw PipelineError.retryable('bluesky_unreadable', 'Bluesky answered with a thread that could not be read.');
    }
    throw PipelineError.permanent(
      'bluesky_post_unavailable',
      branch.reason === 'BLOCKED' ? 'That post is blocked or hidden from this account.' : 'That post was not found.',
    );
  }
  return {
    focal: toBlueskyPost(branch.focal),
    ancestors: branch.ancestors.map(toBlueskyPost),
    ...(branch.truncated ? { note: THREAD_GAP_NOTES[branch.truncated] } : {}),
  };
}

export async function readProfile(ctx: ChannelContext, actor: string): Promise<BlueskyProfile> {
  const wanted = normaliseHandle(actor);
  if (!isDid(wanted) && !isHandle(wanted)) {
    throw PipelineError.permanent('bluesky_bad_reference', `"${actor.slice(0, 80)}" is not a Bluesky handle.`);
  }
  try {
    const body = await authed<unknown>(ctx, targetOf(ctx), 'app.bsky.actor.getProfile', { params: { actor: wanted } });
    const profile = toBlueskyProfile(body);
    if (!profile) throw PipelineError.retryable('bluesky_unreadable', 'Bluesky answered with a profile that could not be read.');
    return profile;
  } catch (error) {
    if (error instanceof BlueskyApiError && error.status === 400) {
      throw PipelineError.permanent('bluesky_not_found', `There is no Bluesky account called ${wanted}.`);
    }
    throw classifyBlueskyError(error, 'reading a profile');
  }
}
