import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { LeagueEntryRequest, LeagueFillReport, type LeagueFill } from '@xbam/shared/contracts';
import { canonicalJson, leagueRulesHash } from '@xbam/runtime';
import { listenReachable } from './listen';

/**
 * A server that speaks the Studio side of `docs/architecture/STUDIO_LEAGUE_BRIDGE.md`.
 *
 * Studio's website is not in this workspace, so without this the client would be
 * tested against a mock of itself. This is a real HTTP server implementing the
 * contract, strictly:
 *
 * - every league request needs `Authorization: DPoP <token>` and a DPoP proof
 *   for that exact method, address and token. Bearer, a missing proof, a proof
 *   from another key, a replayed proof and a proof for another address are each
 *   refused;
 * - a request body must parse as the contract's strict schema (an unknown field
 *   is a 422);
 * - an entry is idempotent by `entry_key`, closed at the lock, one per
 *   installation per season, and refused if the rules hash is not the season's;
 * - a fill is idempotent by `fill_key`; the same key with different content is
 *   `CONTENT_CHANGED`, never an edit; a fill outside the season window or after
 *   the report deadline is rejected, never backfilled.
 *
 * It keeps its own clock (`setNow`) so a test can move through a season without
 * waiting for one. What it answers with is the test's to choose, including
 * answers the real Studio must never send, so the client's refusals are proved.
 */

export interface LeagueRequestLog {
  method: string;
  path: string;
  scheme: string | null;
  proofValid: boolean;
  why: string | null;
  body: unknown;
}

export interface StoredFill {
  fill: LeagueFill;
  hash: string;
  acceptedAt: string;
}

export interface LeagueStudio {
  url: string;
  /** Every league request, in order. */
  requests: LeagueRequestLog[];
  /** The clock the server's documents and rules use. */
  setNow(date: Date): void;
  now(): Date;
  /** The season published as `slug`, rebuilt at each request from these and the clock. */
  rules: Record<string, unknown>;
  times: SeasonTimes;
  /** Merged over the `season` object of the document (a changed status, say). */
  seasonPatch: Record<string, unknown>;
  /** Replace the season document wholesale for the next requests (hostile payloads). */
  seasonOverride: ((slug: string) => { status?: number; body: unknown }) | null;
  /** Replace the standing answer wholesale (hostile payloads). */
  standingOverride: (() => { status?: number; body: unknown }) | null;
  /** Replace the answer to a fill report. Receives the keys that were sent. */
  fillAnswerOverride: ((keys: string[]) => { status?: number; body: unknown }) | null;
  /** Make the next N fill reports fail with this status, to prove retries. */
  failFillReports: { times: number; status: number };
  /** Make the next N entry requests fail with this status, before the entry is stored. */
  failEntries: { times: number; status: number; error?: string };
  /** Entries by entry_key, as Studio holds them. */
  entries: Map<string, { entryId: string; alias: string; enteredAt: string }>;
  /** Fills by fill_key, as Studio holds them. */
  fills: Map<string, StoredFill>;
  goDown(): void;
  goUp(): void;
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

export const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const TOKEN_MINT = 'So11111111111111111111111111111111111111112';

/** The rules of a season this installation can honour. Overrides replace whole top-level fields. */
export function leagueRules(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    paperOnly: true,
    quote: { symbol: 'USDC', network: 'solana', address: USDC, decimals: 6 },
    capital: 1000,
    universe: { kind: 'SOLANA_MEMECOINS', lists: ['trending', 'organic'] },
    strategies: [{ id: 'momentum', title: 'Momentum', summary: 'Buys strength and sells weakness.' }],
    risks: ['CONSERVATIVE', 'BALANCED'],
    costs: { feeBps: 30, model: 'A flat fee on every simulated fill.' },
    bounds: { maxOpenPositions: 3, maxTradePct: 25, minLiquidityUsd: 50_000 },
    sampling: { readEverySeconds: 3600, maxMarkAgeSeconds: 7200 },
    minEntrants: 2,
    tieBreaks: ['RETURN_BPS', 'MAX_DRAWDOWN_BPS', 'LOCKED_AT'],
    standingLoss: 'STOP_NEW_ACTIVITY_KEEP_RESULTS',
    withdrawal: 'KEEP_RESULTS_UNRANKED',
    missingValuation: 'UNRANKED_UNTIL_VALUED',
    ...overrides,
  };
}

export interface SeasonTimes {
  entryClosesAt: Date;
  startsAt: Date;
  endsAt: Date;
  fillsAcceptedUntil: Date;
}

/** A season published at `now`: entry closes in an hour, it starts in two and runs three days. */
export function seasonTimes(now: Date): SeasonTimes {
  const h = 3_600_000;
  const endsAt = new Date(now.getTime() + 2 * h + 3 * 24 * h);
  return { entryClosesAt: new Date(now.getTime() + h), startsAt: new Date(now.getTime() + 2 * h), endsAt, fillsAcceptedUntil: new Date(endsAt.getTime() + 24 * h) };
}

export function seasonDocument(
  slug: string,
  now: Date,
  times: SeasonTimes,
  rules: Record<string, unknown>,
  extra: { season?: Record<string, unknown>; top?: Record<string, unknown> } = {},
): Record<string, unknown> {
  const status = now < times.entryClosesAt ? 'OPEN' : now < times.startsAt ? 'LOCKED' : now <= times.endsAt ? 'RUNNING' : 'FINALIZED';
  return {
    protocol: 1,
    simulated: true,
    source: 'ai17z-studio',
    generated_at: now.toISOString(),
    season: {
      slug,
      title: 'Weekly holder paper league',
      status,
      entry_closes_at: times.entryClosesAt.toISOString(),
      starts_at: times.startsAt.toISOString(),
      ends_at: times.endsAt.toISOString(),
      fills_accepted_until: times.fillsAcceptedUntil.toISOString(),
      max_entrants: 50,
      rules_hash: leagueRulesHash(rules as never),
      rules,
      ...(extra.season ?? {}),
    },
    local_agents: { allowed: true, note: null },
    ...(extra.top ?? {}),
  };
}

export async function startLeagueStudio(initial: { slug?: string; now?: Date; rules?: Record<string, unknown> } = {}): Promise<LeagueStudio> {
  const slug = initial.slug ?? 'week-45';
  let clock = initial.now ?? new Date();
  const times = seasonTimes(clock);
  const rules = initial.rules ?? leagueRules();
  const installation = { id: `inst_${randomUUID().slice(0, 8)}`, jwk: null as null | { kty: string; crv: string; x: string; y: string } };
  const tokens = new Set<string>();
  const seenProofs = new Set<string>();
  let down = false;
  let baseUrl = '';
  const entriesByKey = new Map<string, { entryId: string; alias: string; enteredAt: string }>();
  const fills = new Map<string, StoredFill>();

  const checkProof = (
    proof: string | undefined,
    method: string,
    path: string,
    token: string | null,
  ): { ok: true } | { ok: false; why: string } => {
    if (!proof) return { ok: false, why: 'no DPoP proof' };
    const parts = proof.split('.');
    if (parts.length !== 3) return { ok: false, why: 'not a compact JWS' };
    let header: { typ?: string; alg?: string; jwk?: { kty: string; crv: string; x: string; y: string } };
    let payload: { htm?: string; htu?: string; iat?: number; jti?: string; ath?: string };
    try {
      header = JSON.parse(b64(parts[0]!).toString('utf8'));
      payload = JSON.parse(b64(parts[1]!).toString('utf8'));
    } catch {
      return { ok: false, why: 'unreadable proof' };
    }
    if (header.typ !== 'dpop+jwt' || header.alg !== 'ES256' || !header.jwk) return { ok: false, why: 'wrong proof header' };
    let good = false;
    try {
      good = verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), { key: createPublicKey({ key: header.jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, b64(parts[2]!));
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

    const league = /^\/api\/v1\/installation\/league\/seasons\/([^/]+)(\/entry(?:\/fills)?)?$/.exec(url.pathname);
    if (!league) {
      send(404, { error: 'not_found' });
      return;
    }
    const raw = await bodyOf(request);
    const log: LeagueRequestLog = {
      method,
      path: url.pathname + url.search,
      scheme: (request.headers.authorization ?? '').split(' ')[0]?.toLowerCase() || null,
      proofValid: false,
      why: null,
      body: raw ? safeJson(raw) : null,
    };
    studio.requests.push(log);
    const [scheme, token] = (request.headers.authorization ?? '').split(' ');
    if (scheme !== 'DPoP' || !token || !tokens.has(token)) {
      log.why = scheme === 'Bearer' ? 'a bearer token is not accepted' : 'no valid DPoP access token';
      send(401, { error: 'invalid_token' });
      return;
    }
    const proof = checkProof(request.headers.dpop as string | undefined, method, url.pathname, token);
    if (!proof.ok) {
      log.why = proof.why;
      send(401, { error: 'invalid_dpop_proof', error_description: proof.why });
      return;
    }
    log.proofValid = true;

    const askedSlug = league[1]!;
    const tail = league[2] ?? '';
    const now = clock;
    const doc = () => seasonDocument(slug, now, studio.times, studio.rules, { season: studio.seasonPatch });

    if (askedSlug !== slug) {
      send(404, { error: 'not_found', error_description: 'No such season.' });
      return;
    }

    // GET the season.
    if (tail === '' && method === 'GET') {
      const answer = studio.seasonOverride ? studio.seasonOverride(askedSlug) : { body: doc() };
      send(answer.status ?? 200, answer.body);
      return;
    }

    // POST an entry.
    if (tail === '/entry' && method === 'POST') {
      if (studio.failEntries.times > 0) {
        studio.failEntries.times -= 1;
        send(studio.failEntries.status, { error: studio.failEntries.error ?? 'temporarily_unavailable' });
        return;
      }
      const parsed = LeagueEntryRequest.safeParse(log.body);
      if (!parsed.success) {
        send(422, { error: 'invalid_request', error_description: `The entry is not valid: ${parsed.error.issues[0]?.path.join('.') || 'document'}.` });
        return;
      }
      const d = doc() as { season: { status: string; rules_hash: string; entry_closes_at: string } };
      const replay = entriesByKey.get(parsed.data.entry_key);
      if (replay) {
        send(200, { protocol: 1, entry_id: replay.entryId, season_slug: slug, status: 'ACTIVE', entered_at: replay.enteredAt });
        return;
      }
      if (d.season.status !== 'OPEN' || now.getTime() >= Date.parse(d.season.entry_closes_at)) {
        send(409, { error: 'season_closed', error_description: 'Entry has closed. An entry is not taken after the lock.' });
        return;
      }
      if (parsed.data.rules_hash !== d.season.rules_hash) {
        send(409, { error: 'rules_changed', error_description: 'The rules are not the ones published.' });
        return;
      }
      if (entriesByKey.size > 0) {
        send(409, { error: 'already_entered', error_description: 'This installation is already entered in this season.' });
        return;
      }
      const created = { entryId: `ent_${randomUUID().slice(0, 8)}`, alias: parsed.data.alias, enteredAt: now.toISOString() };
      entriesByKey.set(parsed.data.entry_key, created);
      send(201, { protocol: 1, entry_id: created.entryId, season_slug: slug, status: 'ACTIVE', entered_at: created.enteredAt });
      return;
    }

    const entry = [...entriesByKey.values()][0] ?? null;

    // GET own standing.
    if (tail === '/entry' && method === 'GET') {
      if (studio.standingOverride) {
        const answer = studio.standingOverride();
        send(answer.status ?? 200, answer.body);
        return;
      }
      if (!entry) {
        send(404, { error: 'not_found', error_description: 'No entry.' });
        return;
      }
      const started = now >= studio.times.startsAt;
      const counted = fills.size;
      send(200, {
        protocol: 1,
        simulated: true,
        source: 'ai17z-studio',
        generated_at: now.toISOString(),
        season_slug: slug,
        entry_id: entry.entryId,
        season_status: (doc() as { season: { status: string } }).season.status,
        entry_status: 'ACTIVE',
        basis: 'REPORTED_BY_ENTRANT',
        standing: !started
          ? { state: 'NOT_STARTED', rank: null, of: null, return_bps: null, max_drawdown_bps: null, fills_counted: 0, last_mark_at: null, reason: null }
          : counted === 0
            ? { state: 'PENDING', rank: null, of: null, return_bps: null, max_drawdown_bps: null, fills_counted: 0, last_mark_at: null, reason: 'Studio has no usable valuation for it yet' }
            : { state: 'RANKED', rank: 3, of: 12, return_bps: -125, max_drawdown_bps: 480, fills_counted: counted, last_mark_at: now.toISOString(), reason: null },
      });
      return;
    }

    // POST fills.
    if (tail === '/entry/fills' && method === 'POST') {
      if (studio.failFillReports.times > 0) {
        studio.failFillReports.times -= 1;
        send(studio.failFillReports.status, { error: 'temporarily_unavailable' });
        return;
      }
      const parsed = LeagueFillReport.safeParse(log.body);
      if (!parsed.success) {
        send(422, { error: 'invalid_request', error_description: `The report is not valid: ${parsed.error.issues[0]?.path.join('.') || 'document'}.` });
        return;
      }
      if (!entry || parsed.data.entry_id !== entry.entryId) {
        send(404, { error: 'not_found', error_description: 'No such entry.' });
        return;
      }
      const keys = parsed.data.fills.map((f) => f.fill_key);
      if (studio.fillAnswerOverride) {
        const answer = studio.fillAnswerOverride(keys);
        send(answer.status ?? 200, answer.body);
        return;
      }
      const accepted: string[] = [];
      const duplicates: string[] = [];
      const rejected: Array<{ fill_key: string; reason: string }> = [];
      for (const fill of parsed.data.fills) {
        const hash = createHash('sha256').update(canonicalJson(fill)).digest('hex');
        const held = fills.get(fill.fill_key);
        if (held) {
          if (held.hash === hash) duplicates.push(fill.fill_key);
          else rejected.push({ fill_key: fill.fill_key, reason: 'CONTENT_CHANGED' });
          continue;
        }
        if (now.getTime() > studio.times.fillsAcceptedUntil.getTime()) rejected.push({ fill_key: fill.fill_key, reason: 'AFTER_REPORT_DEADLINE' });
        else if (Date.parse(fill.filled_at) < studio.times.startsAt.getTime() || Date.parse(fill.filled_at) > studio.times.endsAt.getTime()) rejected.push({ fill_key: fill.fill_key, reason: 'OUTSIDE_SEASON' });
        else {
          fills.set(fill.fill_key, { fill, hash, acceptedAt: now.toISOString() });
          accepted.push(fill.fill_key);
        }
      }
      send(200, { protocol: 1, simulated: true, accepted, duplicates, rejected });
      return;
    }

    send(404, { error: 'not_found' });
  });

  const port = await listenReachable(server);
  baseUrl = `http://127.0.0.1:${port}`;

  const studio: LeagueStudio = {
    url: baseUrl,
    requests: [],
    setNow: (date) => {
      clock = date;
    },
    now: () => clock,
    rules,
    times,
    seasonPatch: {},
    seasonOverride: null,
    standingOverride: null,
    fillAnswerOverride: null,
    failFillReports: { times: 0, status: 503 },
    failEntries: { times: 0, status: 503 },
    entries: entriesByKey,
    fills,
    goDown: () => {
      down = true;
    },
    goUp: () => {
      down = false;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  return studio;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
