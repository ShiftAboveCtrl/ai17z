import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { listenReachable } from './listen';

/**
 * A Bluesky server on loopback, speaking the XRPC calls the channel makes.
 *
 * No test in this repository reaches the real Bluesky network. This stands in
 * for a PDS and its AppView, with response bodies shaped like the real ones
 * (`com.atproto.server.createSession`, `app.bsky.notification.listNotifications`,
 * `app.bsky.feed.getPostThread`, `com.atproto.repo.createRecord`, and so on) and
 * the same refusals: an unknown token is a 400 `ExpiredToken`, a reply quoting a
 * parent with the wrong CID is rejected, a rate limit is a 429 with
 * `ratelimit-reset`. A channel that passes against this has sent requests a
 * strict server would accept, which a permissive stub would not prove.
 *
 * Every request is recorded, so a test can assert what was sent and, as
 * importantly, what was not: that the app password crossed the wire exactly once
 * per sign-in and never again.
 */

export interface RecordedRequest {
  method: string;
  nsid: string;
  query: URLSearchParams;
  body: unknown;
  authorization: string | null;
}

export interface FakePost {
  uri: string;
  cid: string;
  author: { did: string; handle: string; displayName?: string };
  record: {
    $type: 'app.bsky.feed.post';
    text: string;
    createdAt: string;
    reply?: { root: { uri: string; cid: string }; parent: { uri: string; cid: string } };
    facets?: unknown[];
  };
  indexedAt: string;
  /** The view of what is attached, as the AppView renders it (images, video, a quote, a link card). */
  embed?: unknown;
}

export const ME = { did: 'did:plc:agentagentagentagent', handle: 'agent.test', password: 'abcd-efgh-ijkl-mnop' };
export const ALICE = { did: 'did:plc:alicealicealicealice', handle: 'alice.test', displayName: 'Alice' };

const cidOf = (text: string) => `bafyrei${createHash('sha256').update(text).digest('hex').slice(0, 40)}`;

export class FakeBluesky {
  readonly requests: RecordedRequest[] = [];
  readonly posts = new Map<string, FakePost>();
  readonly likes = new Map<string, string>();
  notifications: unknown[] = [];

  /** Sign-in behaviour. */
  challenge = false;
  takendown = false;
  /** How many requests to answer with a 429 before behaving. */
  rateLimitNext = 0;
  /** Invalidate every access token once, as a server does when one ages out. */
  expireAccessTokens = false;
  /** Store the next post, then cut the connection without answering. */
  dropNextPostResponse = false;
  /** Report likes counts as absent, to prove absent is not zero. */
  omitCounts = false;
  /** Answer reads of a thread's post as deleted. */
  hiddenUris = new Set<string>();

  private server: Server | null = null;
  private port = 0;
  private counter = 0;
  private validAccess = new Set<string>();
  private expiredAccess = new Set<string>();
  private validRefresh = new Set<string>();

  get origin(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  static async start(): Promise<FakeBluesky> {
    const fake = new FakeBluesky();
    fake.server = createServer((req, res) => void fake.handle(req, res));
    fake.port = await listenReachable(fake.server);
    return fake;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
    this.server?.closeAllConnections?.();
  }

  of(nsid: string): RecordedRequest[] {
    return this.requests.filter((request) => request.nsid === nsid);
  }

  // -- Seeding ----------------------------------------------------------------

  /** A post by someone, optionally a reply to one already seeded. */
  seedPost(input: {
    id: string;
    author?: { did: string; handle: string; displayName?: string };
    text: string;
    replyTo?: string;
    createdAt?: string;
    embed?: unknown;
  }): FakePost {
    const author = input.author ?? ALICE;
    const uri = `at://${author.did}/app.bsky.feed.post/${input.id}`;
    const parent = input.replyTo ? this.posts.get(input.replyTo) : undefined;
    if (input.replyTo && !parent) throw new Error(`seed ${input.replyTo} before replying to it`);
    const root = parent?.record.reply?.root ?? (parent ? { uri: parent.uri, cid: parent.cid } : undefined);
    const createdAt = input.createdAt ?? new Date().toISOString();
    const post: FakePost = {
      uri,
      cid: cidOf(`${uri}|${input.text}`),
      author,
      record: {
        $type: 'app.bsky.feed.post',
        text: input.text,
        createdAt,
        ...(parent && root ? { reply: { root, parent: { uri: parent.uri, cid: parent.cid } } } : {}),
      },
      indexedAt: createdAt,
      ...(input.embed === undefined ? {} : { embed: input.embed }),
    };
    this.posts.set(uri, post);
    return post;
  }

  /** Puts a post in the agent's notifications under the given reason. */
  notify(post: FakePost, reason: 'mention' | 'reply' | 'quote' | 'like' | 'follow'): void {
    this.notifications.unshift({
      uri: post.uri,
      cid: post.cid,
      author: { ...post.author, labels: [] },
      reason,
      reasonSubject: reason === 'reply' ? post.record.reply?.parent.uri : undefined,
      record: post.record,
      isRead: false,
      indexedAt: post.indexedAt,
      labels: [],
    });
  }

  postsBy(did: string): FakePost[] {
    return [...this.posts.values()].filter((post) => post.author.did === did);
  }

  // -- The server -------------------------------------------------------------

  private issueSession() {
    this.counter += 1;
    const accessJwt = `access-${this.counter}`;
    const refreshJwt = `refresh-${this.counter}`;
    this.validAccess.add(accessJwt);
    this.validRefresh.add(refreshJwt);
    return { accessJwt, refreshJwt, did: ME.did, handle: ME.handle, active: true, ...(this.takendown ? { status: 'takendown' } : {}) };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.origin);
    const nsid = url.pathname.replace(/^\/xrpc\//, '');
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? JSON.parse(raw) : null;
    const authorization = (req.headers.authorization as string | undefined) ?? null;
    this.requests.push({ method: req.method ?? 'GET', nsid, query: url.searchParams, body, authorization });

    const send = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(payload));
    };
    const refuse = (status: number, error: string, message: string) => send(status, { error, message });

    if (this.rateLimitNext > 0) {
      this.rateLimitNext -= 1;
      send(429, { error: 'RateLimitExceeded', message: 'Rate Limit Exceeded' }, { 'ratelimit-reset': String(Math.floor(Date.now() / 1000) + 90) });
      return;
    }

    if (nsid === 'com.atproto.server.createSession') {
      if (this.challenge) return refuse(401, 'AuthFactorTokenRequired', 'A sign in code has been sent to your email address');
      if (body?.password !== ME.password || ![ME.handle, 'agent@example.test'].includes(body?.identifier)) {
        return refuse(401, 'AuthenticationRequired', 'Invalid identifier or password');
      }
      return send(200, this.issueSession());
    }

    if (nsid === 'com.atproto.server.refreshSession') {
      const token = authorization?.replace(/^Bearer /, '') ?? '';
      if (!this.validRefresh.has(token)) return refuse(400, 'ExpiredToken', 'Token has expired');
      this.validRefresh.delete(token);
      return send(200, this.issueSession());
    }

    if (nsid === 'com.atproto.server.deleteSession') return send(200, {});

    if (nsid === 'com.atproto.identity.resolveHandle') {
      const handle = url.searchParams.get('handle');
      if (handle === ALICE.handle) return send(200, { did: ALICE.did });
      if (handle === ME.handle) return send(200, { did: ME.did });
      return refuse(400, 'InvalidRequest', 'Unable to resolve handle');
    }

    // Everything below needs a live access token.
    if (this.expireAccessTokens) {
      this.expireAccessTokens = false;
      for (const token of this.validAccess) this.expiredAccess.add(token);
      this.validAccess.clear();
    }
    const bearer = authorization?.replace(/^Bearer /, '') ?? '';
    if (!this.validAccess.has(bearer)) {
      return this.expiredAccess.has(bearer)
        ? refuse(400, 'ExpiredToken', 'Token has expired')
        : refuse(401, 'AuthenticationRequired', 'Authentication Required');
    }

    switch (nsid) {
      case 'com.atproto.server.getSession':
        return send(200, { did: ME.did, handle: ME.handle, active: true, ...(this.takendown ? { status: 'takendown' } : {}) });

      case 'app.bsky.notification.listNotifications': {
        // Paged as the real one is: newest first, `limit` at a time, with an
        // opaque cursor that is absent on the last page.
        const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), 100);
        const start = Number(url.searchParams.get('cursor') ?? 0);
        const page = this.notifications.slice(start, start + limit);
        const next = start + limit < this.notifications.length ? String(start + limit) : undefined;
        return send(200, { notifications: page, ...(next ? { cursor: next } : {}) });
      }

      case 'app.bsky.feed.getPosts': {
        const found = url.searchParams
          .getAll('uris')
          .map((uri) => this.posts.get(uri))
          .filter((post): post is FakePost => Boolean(post) && !this.hiddenUris.has(post!.uri));
        return send(200, { posts: found.map((post) => this.view(post)) });
      }

      case 'app.bsky.feed.getPostThread': {
        const uri = url.searchParams.get('uri') ?? '';
        const post = this.posts.get(uri);
        if (!post || this.hiddenUris.has(uri)) return refuse(400, 'NotFound', `Post not found: ${uri}`);
        return send(200, { thread: this.node(post, Number(url.searchParams.get('parentHeight') ?? 0)) });
      }

      case 'app.bsky.actor.getProfile': {
        const actor = url.searchParams.get('actor');
        if (actor !== ALICE.handle && actor !== ALICE.did) return refuse(400, 'InvalidRequest', 'Profile not found');
        return send(200, {
          did: ALICE.did,
          handle: ALICE.handle,
          displayName: ALICE.displayName,
          description: 'Writes about birds.',
          ...(this.omitCounts ? {} : { followersCount: 12, followsCount: 3, postsCount: 40 }),
        });
      }

      case 'com.atproto.repo.listRecords': {
        const mine = this.postsBy(ME.did)
          .sort((a, b) => b.record.createdAt.localeCompare(a.record.createdAt))
          .map((post) => ({ uri: post.uri, cid: post.cid, value: post.record }));
        return send(200, { records: mine });
      }

      case 'com.atproto.repo.createRecord':
        return this.createRecord(body, res, send, refuse);

      default:
        return refuse(501, 'MethodNotImplemented', `${nsid} is not part of this fixture`);
    }
  }

  private createRecord(
    body: { repo?: string; collection?: string; record?: Record<string, unknown> } | null,
    res: ServerResponse,
    send: (status: number, payload: unknown) => void,
    refuse: (status: number, error: string, message: string) => void,
  ): void {
    if (body?.repo !== ME.did) return refuse(400, 'InvalidRequest', 'Repo does not match the signed-in account');
    this.counter += 1;
    const rkey = `3kfake${String(this.counter).padStart(6, '0')}`;

    if (body.collection === 'app.bsky.feed.like') {
      const subject = body.record?.subject as { uri?: string; cid?: string } | undefined;
      const target = subject?.uri ? this.posts.get(subject.uri) : undefined;
      if (!target || target.cid !== subject?.cid) return refuse(400, 'InvalidRequest', 'Like subject does not match');
      const uri = `at://${ME.did}/app.bsky.feed.like/${rkey}`;
      this.likes.set(target.uri, uri);
      return send(200, { uri, cid: cidOf(uri), validationStatus: 'valid' });
    }

    if (body.collection !== 'app.bsky.feed.post') return refuse(400, 'InvalidRequest', 'Unsupported collection');
    const record = body.record as FakePost['record'];
    if (record.reply) {
      // A strict server's view of a reply: both refs must name real posts at the
      // CID they have, or the thread the reply lands in is broken.
      for (const ref of [record.reply.parent, record.reply.root]) {
        const known = this.posts.get(ref.uri);
        if (!known || known.cid !== ref.cid) return refuse(400, 'InvalidRequest', `Reply ref does not match: ${ref.uri}`);
      }
    }
    if ([...record.text].length > 300) return refuse(400, 'InvalidRequest', 'Record text is too long');
    const uri = `at://${ME.did}/app.bsky.feed.post/${rkey}`;
    const post: FakePost = { uri, cid: cidOf(`${uri}|${record.text}`), author: { did: ME.did, handle: ME.handle }, record, indexedAt: record.createdAt };
    this.posts.set(uri, post);

    if (this.dropNextPostResponse) {
      // The write happened; the answer never arrives.
      this.dropNextPostResponse = false;
      res.socket?.destroy();
      return;
    }
    send(200, { uri, cid: post.cid, commit: { cid: cidOf(`commit|${uri}`), rev: 'rev1' }, validationStatus: 'valid' });
  }

  private view(post: FakePost) {
    const likeUri = this.likes.get(post.uri);
    return {
      uri: post.uri,
      cid: post.cid,
      author: { ...post.author, labels: [], viewer: { muted: false } },
      record: post.record,
      indexedAt: post.indexedAt,
      ...(post.embed === undefined ? {} : { embed: post.embed }),
      ...(this.omitCounts ? {} : { replyCount: 0, repostCount: 0, likeCount: 2, quoteCount: 0 }),
      labels: [],
      viewer: likeUri ? { like: likeUri } : {},
    };
  }

  private node(post: FakePost, parentHeight: number): unknown {
    const parentRef = post.record.reply?.parent.uri;
    let parent: unknown;
    if (parentRef && parentHeight > 0) {
      const above = this.posts.get(parentRef);
      parent =
        above && !this.hiddenUris.has(above.uri)
          ? this.node(above, parentHeight - 1)
          : { $type: 'app.bsky.feed.defs#notFoundPost', uri: parentRef, notFound: true };
    }
    return {
      $type: 'app.bsky.feed.defs#threadViewPost',
      post: this.view(post),
      ...(parent ? { parent } : {}),
      replies: [],
    };
  }
}
