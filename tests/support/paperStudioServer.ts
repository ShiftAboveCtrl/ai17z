import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { listenReachable } from './listen';

/**
 * A server that speaks the Studio side of `docs/architecture/STUDIO_PAPER_RECORD.md`.
 *
 * Studio's website is not in this workspace, so without this the client would
 * be tested against a mock of itself. This is a real HTTP server implementing
 * the contract, strictly: it links an installation by device code, mints an
 * access token bound to the installation's key, and answers the paper record
 * only to a request that carries `Authorization: DPoP <token>` and a DPoP proof
 * for that exact method, address and token. A `Bearer` header, a missing proof,
 * a proof signed by another key, a replayed proof and a proof for a different
 * address are each refused, because a test server more forgiving than the
 * specification hides the bugs it exists to catch.
 *
 * What it answers with is the test's to choose, including answers the real
 * Studio must never send (an extra field, an off-origin link), so the client's
 * refusals are proved rather than assumed.
 */

export interface PaperRequestLog {
  path: string;
  /** The scheme of the Authorization header, lower-cased, or null. */
  scheme: string | null;
  /** Whether a valid DPoP proof for this request came with it. */
  proofValid: boolean;
  why: string | null;
}

export interface PaperStudio {
  url: string;
  /** Every request to the paper record endpoint, in order. */
  paperRequests: PaperRequestLog[];
  /** What the paper record endpoint answers next. Receives the window asked for. */
  respond: (window: string, origin: string) => { status?: number; body: unknown };
  /** Stops answering; every request is refused at the socket. */
  goDown(): void;
  close(): Promise<void>;
}

const b64 = (value: string) => Buffer.from(value, 'base64url');

function thumbprint(jwk: { crv: string; kty: string; x: string; y: string }): string {
  return createHash('sha256').update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })).digest('base64url');
}

async function bodyOf(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** A complete, traded window, with a link on the given origin. */
export function tradedRecord(window: string, origin: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const end = new Date();
  const start = new Date(end.getTime() - (window === '7d' ? 7 : window === '30d' ? 30 : 90) * 86_400_000);
  return {
    protocol: 1,
    simulated: true,
    source: 'ai17z-studio',
    generated_at: new Date().toISOString(),
    window: { label: window, start: start.toISOString(), end: end.toISOString(), complete: true },
    state: 'TRADED',
    reason: null,
    totals: { trades: 12, closed_trades: 10, winning_trades: 6, losing_trades: 4, net_pnl_usd: '-42.50', return_pct: '-4.25', max_drawdown_pct: '9.10' },
    costs: { fee_bps: 30, slippage_bps: 50, note: 'Fees and slippage as Studio assumes them for every paper fill.' },
    open_positions: { count: 2, treatment: 'MARKED_TO_MARKET', note: 'Marked at the last pool price.' },
    decisions: [{ id: 'dec_1', at: start.toISOString(), summary: 'Opened a simulated long after a liquidity check.', url: `${origin}/paper/decisions/dec_1` }],
    ...overrides,
  };
}

export async function startPaperStudio(): Promise<PaperStudio> {
  const installation = { id: `inst_${randomUUID().slice(0, 8)}`, jwk: null as null | { kty: string; crv: string; x: string; y: string } };
  const tokens = new Set<string>();
  const seenProofs = new Set<string>();
  const paperRequests: PaperRequestLog[] = [];
  let down = false;
  let baseUrl = '';

  /** Verifies a DPoP proof; returns the signing key's thumbprint or a reason. */
  const checkProof = (
    proof: string | undefined,
    method: string,
    path: string,
    token: string | null,
  ): { ok: true; jwk: { kty: string; crv: string; x: string; y: string } } | { ok: false; why: string } => {
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
    return { ok: true, jwk: header.jwk };
  };

  const server: Server = createServer(async (request, response) => {
    if (down) {
      request.socket.destroy();
      return;
    }
    const url = new URL(request.url ?? '/', baseUrl || 'http://localhost');
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    const method = request.method ?? 'GET';

    if (method === 'POST' && url.pathname === '/api/v1/device/authorize') {
      const body = JSON.parse((await bodyOf(request)) || '{}') as { public_key?: { kty: string; crv: string; x: string; y: string } };
      installation.jwk = body.public_key ?? null;
      send(200, {
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
        send(400, { error: 'invalid_dpop_proof', error_description: proof.why });
        return;
      }
      const grant = form.get('grant_type');
      const device = grant === 'urn:ietf:params:oauth:grant-type:device_code' && form.get('device_code') === 'device-code-for-the-test';
      const known = grant === 'urn:ai17z:params:oauth:grant-type:installation-key';
      if (!device && !known) {
        send(400, { error: 'invalid_grant' });
        return;
      }
      const access = `tok_${randomUUID()}`;
      tokens.add(access);
      send(200, { access_token: access, token_type: 'DPoP', expires_in: 300, installation_id: installation.id });
      return;
    }

    if (method === 'GET' && url.pathname === '/api/v1/installation/paper-record') {
      const authorization = request.headers.authorization ?? '';
      const [scheme, token] = authorization.split(' ');
      const entry: PaperRequestLog = { path: url.pathname + url.search, scheme: scheme ? scheme.toLowerCase() : null, proofValid: false, why: null };
      paperRequests.push(entry);
      if (scheme !== 'DPoP' || !token || !tokens.has(token)) {
        entry.why = scheme === 'Bearer' ? 'a bearer token is not accepted' : 'no valid DPoP access token';
        send(401, { error: 'invalid_token' });
        return;
      }
      const proof = checkProof(request.headers.dpop as string | undefined, 'GET', url.pathname, token);
      if (!proof.ok) {
        entry.why = proof.why;
        send(401, { error: 'invalid_dpop_proof', error_description: proof.why });
        return;
      }
      entry.proofValid = true;
      const answer = studio.respond(url.searchParams.get('window') ?? '', baseUrl);
      send(answer.status ?? 200, answer.body);
      return;
    }

    send(404, { error: 'not_found' });
  });

  const port = await listenReachable(server);
  baseUrl = `http://127.0.0.1:${port}`;

  const studio: PaperStudio = {
    url: baseUrl,
    paperRequests,
    respond: (window, origin) => ({ body: tradedRecord(window, origin) }),
    goDown: () => {
      down = true;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  return studio;
}
