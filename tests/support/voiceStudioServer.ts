import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { VoicePublishRequest } from '@xbam/shared/contracts';
import { listenReachable } from './listen';

/**
 * A server that speaks the Studio side of `docs/architecture/STUDIO_VOICE_PUBLISH.md`.
 *
 * Studio's website is not in this workspace, so without this the client would
 * be tested against a mock of itself. This is a real HTTP server implementing
 * the contract strictly:
 *
 *   - it links an installation by device code and mints an access token bound
 *     to the installation's key;
 *   - every `/api/v1/installation/voices*` request must carry
 *     `Authorization: DPoP <token>` and a DPoP proof for that exact method,
 *     address and token. A bearer header, a missing proof, a proof from another
 *     key, a replayed proof and a proof for another address are each refused;
 *   - a publish must parse as the strict `VoicePublishRequest`, and its
 *     `document_sha256` must be the sha256 of the canonical JSON of the
 *     document, recomputed here by code of this file's own and not by the
 *     client's;
 *   - versions are immutable: a version's bytes are stored once and served
 *     unchanged, a changed document is the next version, an unchanged one is
 *     the version it already is, and an idempotency key replays its answer or
 *     conflicts;
 *   - the public pages (`/api/v1/voices/...`) answer without any credential,
 *     and the server records whether one was sent anyway.
 *
 * What it answers with is the test's to bend through the `override` hooks,
 * including answers the real Studio must never send, so the client's refusals
 * are proved rather than assumed.
 */

export interface AuthedLog {
  method: string;
  path: string;
  scheme: string | null;
  proofValid: boolean;
  why: string | null;
}

export interface PublicLog {
  path: string;
  hadAuthorization: boolean;
  hadDpop: boolean;
}

interface StoredVersion {
  version: number;
  sha: string;
  /** Serialised once, at publish, and served as-is thereafter. */
  documentJson: string;
  publishedAt: string;
}

interface StoredListing {
  id: string;
  status: 'PUBLISHED' | 'UNPUBLISHED';
  versions: StoredVersion[];
}

export interface VoiceStudio {
  url: string;
  authed: AuthedLog[];
  publicReads: PublicLog[];
  listings: Map<string, StoredListing>;
  /** Bends the next answer of each kind. Return the answer unchanged to leave it. */
  override: {
    publish?: (answer: { status: number; body: Record<string, unknown> }) => { status: number; body: unknown };
    version?: (answer: { status: number; body: Record<string, unknown> }) => { status: number; body: unknown };
    listing?: (answer: { status: number; body: Record<string, unknown> }) => { status: number; body: unknown };
  };
  /** Publishes a version straight into the store, bypassing the wire, for install tests. */
  seed(document: unknown, listingId?: string): { listingId: string; version: number };
  /** Refuses every request at the socket. `goDown(false)` brings it back. */
  goDown(down?: boolean): void;
  close(): Promise<void>;
}

const b64 = (value: string) => Buffer.from(value, 'base64url');

function thumbprint(jwk: { crv: string; kty: string; x: string; y: string }): string {
  return createHash('sha256').update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })).digest('base64url');
}

/** This file's own canonical JSON. Deliberately not the client's. */
function canon(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`;
  const keys = Object.keys(value as object).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canon((value as Record<string, unknown>)[k])}`).join(',')}}`;
}
const sha = (value: unknown) => createHash('sha256').update(canon(value)).digest('hex');

async function bodyOf(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const slug = () => `voice_${randomUUID().replace(/-/g, '').slice(0, 10)}`;

export async function startVoiceStudio(): Promise<VoiceStudio> {
  const installation = { id: `inst_${randomUUID().slice(0, 8)}`, jwk: null as null | { kty: string; crv: string; x: string; y: string } };
  const tokens = new Set<string>();
  const seenProofs = new Set<string>();
  const listings = new Map<string, StoredListing>();
  const replays = new Map<string, { requestSha: string; status: number; body: Record<string, unknown> }>();
  const authed: AuthedLog[] = [];
  const publicReads: PublicLog[] = [];
  let down = false;
  let baseUrl = '';

  const checkProof = (
    proof: string | undefined,
    method: string,
    path: string,
    token: string | null,
  ): { ok: true } | { ok: false; why: string } => {
    if (!proof) return { ok: false, why: 'no DPoP proof' };
    const parts = proof.split('.');
    if (parts.length !== 3) return { ok: false, why: 'not a compact JWS' };
    let header: Record<string, any>;
    let payload: Record<string, any>;
    try {
      header = JSON.parse(b64(parts[0]!).toString('utf8'));
      payload = JSON.parse(b64(parts[1]!).toString('utf8'));
    } catch {
      return { ok: false, why: 'unreadable proof' };
    }
    if (header.typ !== 'dpop+jwt' || header.alg !== 'ES256' || !header.jwk) return { ok: false, why: 'wrong proof header' };
    let good = false;
    try {
      good = verify(
        'sha256',
        Buffer.from(`${parts[0]}.${parts[1]}`),
        { key: createPublicKey({ key: header.jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' },
        b64(parts[2]!),
      );
    } catch {
      good = false;
    }
    if (!good) return { ok: false, why: 'signature does not verify' };
    if (payload.htm !== method) return { ok: false, why: 'proof is for another method' };
    if (payload.htu !== `${baseUrl}${path}`) return { ok: false, why: 'proof is for another address' };
    if (Math.abs(Date.now() / 1000 - Number(payload.iat)) > 60) return { ok: false, why: 'proof is not fresh' };
    if (typeof payload.jti !== 'string' || seenProofs.has(payload.jti)) return { ok: false, why: 'proof was used before' };
    seenProofs.add(payload.jti);
    if (token && payload.ath !== createHash('sha256').update(token).digest('base64url')) return { ok: false, why: 'proof is not bound to this token' };
    if (installation.jwk && thumbprint(installation.jwk as never) !== thumbprint(header.jwk)) return { ok: false, why: 'proof is from another key' };
    return { ok: true };
  };

  const versionBody = (listing: StoredListing, v: StoredVersion) => ({
    protocol: 1,
    listing_id: listing.id,
    version: v.version,
    status: 'PUBLISHED',
    published_at: v.publishedAt,
    document_sha256: v.sha,
    document: JSON.parse(v.documentJson) as unknown,
  });

  const server: Server = createServer(async (request, response) => {
    if (down) {
      request.socket.destroy();
      return;
    }
    const url = new URL(request.url ?? '/', baseUrl || 'http://localhost');
    const method = request.method ?? 'GET';
    const reply = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };

    if (method === 'POST' && url.pathname === '/api/v1/device/authorize') {
      const body = JSON.parse((await bodyOf(request)) || '{}') as { public_key?: { kty: string; crv: string; x: string; y: string } };
      installation.jwk = body.public_key ?? null;
      reply(200, {
        device_code: 'device-code-for-the-test',
        user_code: 'ABCD-EFGH',
        verification_uri: `${baseUrl}/connect`,
        verification_uri_complete: `${baseUrl}/connect?code=ABCD-EFGH`,
        expires_in: 600,
        interval: 1,
      });
      return;
    }

    if (method === 'POST' && url.pathname === '/api/v1/token') {
      const form = new URLSearchParams(await bodyOf(request));
      const proof = checkProof(request.headers.dpop as string | undefined, 'POST', '/api/v1/token', null);
      if (!proof.ok) {
        reply(400, { error: 'invalid_dpop_proof', error_description: proof.why });
        return;
      }
      const grant = form.get('grant_type');
      const device = grant === 'urn:ietf:params:oauth:grant-type:device_code' && form.get('device_code') === 'device-code-for-the-test';
      const known = grant === 'urn:ai17z:params:oauth:grant-type:installation-key';
      if (!device && !known) {
        reply(400, { error: 'invalid_grant' });
        return;
      }
      const access = `tok_${randomUUID()}`;
      tokens.add(access);
      reply(200, { access_token: access, token_type: 'DPoP', expires_in: 300, installation_id: installation.id });
      return;
    }

    // ----- public pages: no credential, none expected -----------------------
    const publicMatch = /^\/api\/v1\/voices\/([^/]+)(?:\/versions\/(\d+))?$/.exec(url.pathname);
    if (method === 'GET' && publicMatch) {
      publicReads.push({
        path: url.pathname,
        hadAuthorization: Boolean(request.headers.authorization),
        hadDpop: Boolean(request.headers.dpop),
      });
      const listing = listings.get(publicMatch[1]!);
      let answer: { status: number; body: Record<string, unknown> };
      if (!listing) answer = { status: 404, body: { error: 'not_found' } };
      else if (listing.status === 'UNPUBLISHED') answer = { status: 410, body: { error: 'gone' } };
      else if (publicMatch[2] === undefined) {
        const latest = listing.versions[listing.versions.length - 1]!;
        const document = JSON.parse(latest.documentJson) as { title: string; summary: string };
        answer = {
          status: 200,
          body: {
            protocol: 1,
            listing_id: listing.id,
            status: 'PUBLISHED',
            title: document.title,
            summary: document.summary,
            latest_version: latest.version,
            versions: listing.versions.map((v) => ({ version: v.version, document_sha256: v.sha, published_at: v.publishedAt })),
            url: `${baseUrl}/voices/${listing.id}`,
          },
        };
        if (studio.override.listing) answer = studio.override.listing(answer) as typeof answer;
      } else {
        const v = listing.versions.find((candidate) => candidate.version === Number(publicMatch[2]));
        answer = v ? { status: 200, body: versionBody(listing, v) } : { status: 404, body: { error: 'not_found' } };
        if (v && studio.override.version) answer = studio.override.version(answer) as typeof answer;
      }
      reply(answer.status, answer.body);
      return;
    }

    // ----- the owner's own listings: DPoP only ------------------------------
    if (url.pathname.startsWith('/api/v1/installation/voices')) {
      const authorization = request.headers.authorization ?? '';
      const [scheme, token] = authorization.split(' ');
      const entry: AuthedLog = { method, path: url.pathname, scheme: scheme ? scheme.toLowerCase() : null, proofValid: false, why: null };
      authed.push(entry);
      if (scheme !== 'DPoP' || !token || !tokens.has(token)) {
        entry.why = scheme === 'Bearer' ? 'a bearer token is not accepted' : 'no valid DPoP access token';
        reply(401, { error: 'invalid_token' });
        return;
      }
      const proof = checkProof(request.headers.dpop as string | undefined, method, url.pathname, token);
      if (!proof.ok) {
        entry.why = proof.why;
        reply(401, { error: 'invalid_dpop_proof', error_description: proof.why });
        return;
      }
      entry.proofValid = true;

      if (method === 'GET' && url.pathname === '/api/v1/installation/voices') {
        reply(200, {
          protocol: 1,
          listings: [...listings.values()].map((listing) => ({
            listing_id: listing.id,
            status: listing.status,
            title: (JSON.parse(listing.versions[listing.versions.length - 1]!.documentJson) as { title: string }).title,
            url: `${baseUrl}/voices/${listing.id}`,
            versions: listing.versions.map((v) => ({ version: v.version, document_sha256: v.sha, published_at: v.publishedAt })),
          })),
        });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/v1/installation/voices') {
        let raw: unknown;
        try {
          raw = JSON.parse(await bodyOf(request));
        } catch {
          reply(400, { error: 'invalid_request', error_description: 'not JSON' });
          return;
        }
        const parsed = VoicePublishRequest.safeParse(raw);
        if (!parsed.success) {
          reply(422, { error: 'invalid_voice', error_description: parsed.error.issues[0]?.message ?? 'does not match the contract' });
          return;
        }
        const body = parsed.data;
        const requestSha = sha(raw);
        const replay = replays.get(body.idempotency_key);
        if (replay) {
          if (replay.requestSha !== requestSha) {
            reply(409, { error: 'idempotency_conflict', error_description: 'that key was used for a different request' });
            return;
          }
          const replayed = studio.override.publish ? (studio.override.publish({ status: 200, body: replay.body }) as { status: number; body: unknown }) : { status: 200, body: replay.body };
          reply(replayed.status, replayed.body);
          return;
        }
        if (sha(body.document) !== body.document_sha256) {
          reply(422, { error: 'digest_mismatch', error_description: 'document_sha256 is not the digest of the document' });
          return;
        }
        let listing: StoredListing;
        if (body.listing_id === null) {
          listing = { id: slug(), status: 'PUBLISHED', versions: [] };
          listings.set(listing.id, listing);
        } else {
          const existing = listings.get(body.listing_id);
          if (!existing) {
            reply(404, { error: 'not_found' });
            return;
          }
          if (existing.status === 'UNPUBLISHED') {
            reply(409, { error: 'listing_unpublished', error_description: 'that listing was unpublished; start a new one' });
            return;
          }
          listing = existing;
        }
        const same = listing.versions.find((v) => v.sha === body.document_sha256);
        let stored = same;
        let status = 200;
        if (!stored) {
          stored = {
            version: listing.versions.length + 1,
            sha: body.document_sha256,
            documentJson: JSON.stringify(body.document),
            publishedAt: new Date().toISOString(),
          };
          listing.versions.push(stored);
          status = 201;
        }
        const answer = {
          protocol: 1,
          listing_id: listing.id,
          version: stored.version,
          document_sha256: stored.sha,
          status: 'PUBLISHED',
          published_at: stored.publishedAt,
          url: `${baseUrl}/voices/${listing.id}`,
        };
        replays.set(body.idempotency_key, { requestSha, status, body: answer });
        const out = studio.override.publish ? (studio.override.publish({ status, body: answer }) as { status: number; body: unknown }) : { status, body: answer };
        reply(out.status, out.body);
        return;
      }

      const unpublishMatch = /^\/api\/v1\/installation\/voices\/([^/]+)\/unpublish$/.exec(url.pathname);
      if (method === 'POST' && unpublishMatch) {
        const raw = JSON.parse((await bodyOf(request)) || '{}') as { protocol?: number; idempotency_key?: string };
        const listing = listings.get(unpublishMatch[1]!);
        if (raw.protocol !== 1 || typeof raw.idempotency_key !== 'string') {
          reply(422, { error: 'invalid_request' });
          return;
        }
        if (!listing) {
          reply(404, { error: 'not_found' });
          return;
        }
        listing.status = 'UNPUBLISHED';
        reply(200, { protocol: 1, listing_id: listing.id, status: 'UNPUBLISHED', unpublished_at: new Date().toISOString() });
        return;
      }
    }

    reply(404, { error: 'not_found' });
  });

  const port = await listenReachable(server);
  baseUrl = `http://127.0.0.1:${port}`;

  const studio: VoiceStudio = {
    url: baseUrl,
    authed,
    publicReads,
    listings,
    override: {},
    seed(document, listingId) {
      const listing = (listingId ? listings.get(listingId) : undefined) ?? { id: listingId ?? slug(), status: 'PUBLISHED' as const, versions: [] };
      listings.set(listing.id, listing);
      const version: StoredVersion = {
        version: listing.versions.length + 1,
        sha: sha(document),
        documentJson: JSON.stringify(document),
        publishedAt: new Date().toISOString(),
      };
      listing.versions.push(version);
      return { listingId: listing.id, version: version.version };
    },
    goDown: (value = true) => {
      down = value;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  return studio;
}
