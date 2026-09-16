import { createLogger } from '@xbam/shared';
import { accounts as accountsRepo } from '@xbam/database';
import { xIntelligence, type XPostRecord } from '@xbam/channels';
import { buildChannelContext, rehearse, type RehearsalSubject } from '@xbam/runtime';

const log = createLogger('rehearsal-post');

/**
 * Reading one real post, so an agent can be tried against it.
 *
 * The Response Lab's only contact with X. Everything after this is the ordinary
 * pipeline running as a dry run, which is the point: an owner is asking what
 * their agent would say to *this*, and a typed approximation of the post
 * answers a different and easier question.
 *
 * ### Read-only, structurally
 *
 * It calls the X intelligence layer, whose contract has no post, like, follow,
 * repost or message in it and must never grow one. There is no branch here that
 * publishes, and the job it queues is checked to be a dry run before anything
 * runs it.
 *
 * ### Why the thread as well as the post
 *
 * A reply on its own frequently means nothing -- "same" or "what did he
 * roundtrip on?" is answerable only from what is above it -- and the whole
 * value of rehearsing against a real post is that the real context comes with
 * it. The ancestors are what the agent would see on a status page, so they are
 * what it is given here.
 */

/** A status id, from a link or typed on its own. */
export function postIdFrom(input: string): string | null {
  const text = input.trim();
  if (/^\d{5,25}$/.test(text)) return text;
  const match = text.match(/\/status(?:es)?\/(\d{5,25})/);
  return match?.[1] ?? null;
}

export interface RehearsalReadResult {
  outcome: string;
  detail: string;
  jobId: string | null;
  /** Which reader answered, so a fallback is visible rather than silent. */
  backend: string;
  gaps: string[];
  subject: RehearsalSubject | null;
}

function subjectFrom(post: XPostRecord, parent: XPostRecord | null, gaps: string[]): RehearsalSubject {
  return {
    channel: 'x',
    remoteId: post.postId,
    url: post.url ?? null,
    authorHandle: post.authorHandle ?? 'someone',
    authorId: post.authorId ?? null,
    authorName: null,
    text: post.text ?? '',
    parentText: parent?.text ?? null,
    parentRemoteId: parent?.postId ?? null,
    // The conversation, where X said what it is. Falling back to the post keeps
    // a rehearsal self-contained rather than inventing an ancestry.
    conversationRef: post.conversationId ?? post.postId,
    occurredAt: post.createdAt ?? null,
    gaps,
  };
}

/**
 * Read the post, then rehearse against it.
 *
 * A refusal is returned rather than thrown, for the same reason an account read
 * records one: "nobody could read that post" and "the agent decided not to
 * answer" are different things to be told, and a thrown error collapses them
 * into a red box that says neither.
 */
export async function rehearseAgainstPost(input: {
  /** The account whose browser does the reading, and whose agent is on trial. */
  readerAccountId: string;
  agentId: string;
  postRef: string;
  requestedBy: string | null;
}): Promise<RehearsalReadResult> {
  const postId = postIdFrom(input.postRef);
  if (!postId) {
    return {
      outcome: 'NOT_FOUND',
      detail: 'That is not a link to a post. Paste the address of one, or its numeric id.',
      jobId: null,
      backend: 'none',
      gaps: [],
      subject: null,
    };
  }

  const account = await accountsRepo.requireAccount(input.readerAccountId);
  const channel = await buildChannelContext(account, null);

  /*
    LIVE, unlike an account read.

    A profile card can be an hour old without misleading anybody. A rehearsal is
    about what the agent would say to a post *now*, and answering it from
    something read this morning would rehearse against a conversation that has
    since moved on.
  */
  const read = await xIntelligence.getPost(postId, { channel, freshness: 'LIVE' });
  if (read.outcome !== 'OK' || !read.data) {
    return {
      outcome: read.outcome,
      detail: read.detail || 'That post could not be read.',
      jobId: null,
      backend: read.provenance.backend,
      gaps: read.provenance.gaps,
      subject: null,
    };
  }

  const post = read.data;
  const gaps = [...read.provenance.gaps];

  // The post above it, when this is a reply. A failure here is a gap and never
  // a stop: a rehearsal against a root post has no ancestor and that is normal.
  let parent: XPostRecord | null = null;
  if (post.replyToPostId) {
    const thread = await xIntelligence.getThread(post.postId, { channel, freshness: 'LIVE' });
    if (thread.outcome === 'OK') {
      parent = thread.data.find((row) => row.postId === post.replyToPostId) ?? null;
      gaps.push(...thread.provenance.gaps);
    }
    if (!parent) {
      gaps.push('This is a reply and the post above it could not be read, so the agent is answering it blind.');
    }
  }

  const subject = subjectFrom(post, parent, gaps);
  const run = await rehearse({
    agentId: input.agentId,
    accountId: account.id,
    subject,
    requestedBy: input.requestedBy,
  });

  log.info('rehearsing against a real post', { agentId: input.agentId, postId, jobId: run.jobId });
  return {
    outcome: 'OK',
    detail: `Read @${subject.authorHandle}'s post and queued a rehearsal. Nothing will be published.`,
    jobId: run.jobId,
    backend: read.provenance.backend,
    gaps,
    subject,
  };
}
