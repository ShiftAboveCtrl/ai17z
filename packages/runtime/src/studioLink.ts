import { ops, studio as ledger } from '@xbam/database';
import { buildVersion, openSecret, sealSecret } from '@xbam/shared';
import {
  AI17Z_PAYMENT,
  formatBaseUnits,
  prepareMarketplacePurchase,
  type PreparedMarketplacePurchase,
  type StudioPurchaseTerms,
} from '@xbam/shared/contracts';
import { safeFetch } from '@xbam/upstream';
import { z } from 'zod';
import { REGISTRY_URL_KEY } from './plugins';
import { dpopProof, newInstallationKey, verifyEs256, type InstallationKey } from './studioJose';

/**
 * Linking this installation to AI17Z Studio.
 *
 * ## What crosses, and in which direction
 *
 * Only this installation starts a conversation, always outbound over HTTPS.
 * Studio never connects here and has no address to connect to. What is sent:
 * a public key, a name the owner can change ("AI17Z on Windows"), the platform
 * and the AI17Z version. What is never sent: memories, prompts, conversations,
 * provider keys, X sessions, Chrome profiles, the master key, files, Telegram
 * credentials, or anything an agent thought. There is no code path here that
 * could carry them, because nothing here reads them.
 *
 * ## Identity
 *
 * The installation's identity is a P-256 key pair made here. The private half
 * is sealed under the master key and never leaves; Studio holds the public
 * half. Every request carries a DPoP proof from that key (RFC 9449), so a
 * token copied off this machine is useless anywhere else, and there is no
 * bearer secret to steal. The eight-letter code the owner types on Studio is a
 * pairing secret for one link and nothing afterwards.
 *
 * ## Entitlements are a signed lease
 *
 * What the owner may use arrives as a JWS signed with Studio's lease key,
 * bound to this installation's key and expiring with the sync. The key that
 * verifies it is pinned when the link is made and never replaced by a later
 * answer for the same kid. A marketplace Plugin runs only while a lease that
 * verifies says it may, for exactly the version and manifest installed.
 *
 * Honestly: AI17Z is open source and runs on the owner's computer, and
 * somebody willing to change its code can remove this check. What the lease
 * stops is editing a database row. A Plugin that must not run unpaid is sold
 * only through Studio's hosted gateway, where Studio itself decides every
 * call, and Studio refuses to sell any other kind.
 *
 * ## Offline
 *
 * Studio being unreachable never stops AI17Z. The last lease keeps working
 * until it expires, and after that only marketplace Plugins stop; every
 * other capability is untouched.
 */

const KEY_SETTING = 'studio.installation.key';
const LINK_SETTING = 'studio.link';
const PENDING_SETTING = 'studio.link.pending';
const PREVIOUS_SETTING = 'studio.link.previous';
const JWKS_SETTING = 'studio.lease.jwks';
const LEASE_SETTING = 'studio.lease';
const SYNC_SETTING = 'studio.sync';

/**
 * A Studio on this machine or a private network, for development and for
 * proving an installation end to end before Studio is deployed. Named to be
 * alarming, read only from the environment, and shown on the Plugins screen
 * whenever it is set, because an installation linked to a development Studio
 * is not linked to the real one.
 */
export const UNSAFE_DEV_ORIGIN_ENV = 'AI17Z_STUDIO_UNSAFE_DEV_ORIGIN';

export const LEASE_TYPE = 'ai17z-entitlement-lease+jwt';
export const LEASE_AUDIENCE = 'ai17z-installation';
const CLOCK_SKEW_SECONDS = 120;

interface StudioOrigin {
  origin: string;
  unsafeDev: boolean;
}

interface LinkRecord {
  installationId: string;
  origin: string;
  linkedAt: string;
  /** Set when Studio said this installation is no longer linked. */
  revokedAt?: string | null;
}

interface PendingRecord {
  origin: string;
  deviceCodeSealed: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresAt: string;
  interval: number;
  replaces: string | null;
}

interface LeaseRecord {
  lease: string;
  syncedAt: string;
  validUntil: string;
}

interface SyncRecord {
  attemptedAt: string;
  okAt: string | null;
  problem: string | null;
}

interface PinnedKeys {
  origin: string;
  keys: Array<{ kid: string; kty: 'EC'; crv: 'P-256'; x: string; y: string }>;
}

export type StudioProblem = { ok: false; why: string };

/** Where Studio is, or null with the reason. */
export async function studioOrigin(env: NodeJS.ProcessEnv = process.env): Promise<StudioOrigin | null> {
  const dev = env[UNSAFE_DEV_ORIGIN_ENV]?.trim();
  if (dev) {
    try {
      const url = new URL(dev);
      if (url.protocol === 'http:' || url.protocol === 'https:') return { origin: url.origin, unsafeDev: true };
    } catch {
      // A malformed development origin is ignored rather than guessed at.
    }
    return null;
  }
  const raw = (await ops.getSetting<string>(REGISTRY_URL_KEY))?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? { origin: url.origin, unsafeDev: false } : null;
  } catch {
    return null;
  }
}

async function readSealed<T>(key: string): Promise<T | null> {
  const sealed = await ops.getSetting<string>(key);
  if (!sealed) return null;
  try {
    return JSON.parse(openSecret(sealed)) as T;
  } catch {
    // Sealed under a different master key. Unusable, and treated as absent,
    // which fails closed for everything that depends on it.
    return null;
  }
}

async function writeSealed(key: string, value: unknown): Promise<void> {
  await ops.setSetting(key, value === null ? null : sealSecret(JSON.stringify(value)));
}

const installationKey = () => readSealed<InstallationKey>(KEY_SETTING);
const linkRecord = async () => (await ops.getSetting<LinkRecord>(LINK_SETTING)) ?? null;

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/**
 * How a Studio request is made. Replaced only by the contract harness, which
 * drives a real Studio over loopback; nothing in the product passes one.
 */
export interface StudioTransport {
  (url: string, init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string }): Promise<{ status: number; text: string }>;
}
let transportOverride: StudioTransport | null = null;
export function setStudioTransportForTests(transport: StudioTransport | null): void {
  transportOverride = transport;
}

interface StudioAnswer {
  status: number;
  body: Record<string, unknown> | null;
}

async function send(
  where: StudioOrigin,
  path: string,
  init: { method: 'GET' | 'POST'; headers?: Record<string, string>; json?: unknown; form?: Record<string, string> },
): Promise<StudioAnswer> {
  const url = `${where.origin}${path}`;
  const headers: Record<string, string> = {
    accept: 'application/json',
    'x-ai17z-version': buildVersion().version,
    ...(init.headers ?? {}),
  };
  let body: string | undefined;
  if (init.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(init.json);
  } else if (init.form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(init.form).toString();
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = transportOverride
      ? await transportOverride(url, { method: init.method, headers, ...(body === undefined ? {} : { body }) })
      : await safeFetch(url, {
          signal: controller.signal,
          method: init.method,
          headers,
          ...(body === undefined ? {} : { body }),
          maxBytes: 1024 * 1024,
          // Every request here may carry this installation's token and proof.
          noRedirects: true,
          ...(where.unsafeDev ? { allowPrivate: true } : {}),
        });
    let parsed: Record<string, unknown> | null = null;
    try {
      const value = JSON.parse(response.text) as unknown;
      parsed = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
    } catch {
      parsed = null;
    }
    return { status: response.status, body: parsed };
  } finally {
    clearTimeout(timer);
  }
}

function describe(answer: StudioAnswer): string {
  const text = typeof answer.body?.error_description === 'string' ? answer.body.error_description : null;
  return text ? `Studio answered ${answer.status}: ${text.slice(0, 300)}` : `Studio answered ${answer.status}.`;
}

// ---------------------------------------------------------------------------
// Access tokens
// ---------------------------------------------------------------------------

let accessCache: { token: string; expiresAt: number; installationId: string } | null = null;
const toolCache = new Map<string, { token: string; expiresAt: number }>();

function forgetTokens(): void {
  accessCache = null;
  toolCache.clear();
}

async function accessToken(where: StudioOrigin, key: InstallationKey, link: LinkRecord): Promise<string | StudioProblem> {
  if (accessCache && accessCache.installationId === link.installationId && accessCache.expiresAt > Date.now() + 30_000) {
    return accessCache.token;
  }
  const answer = await send(where, '/api/v1/token', {
    method: 'POST',
    headers: { dpop: dpopProof(key, 'POST', `${where.origin}/api/v1/token`) },
    form: { grant_type: 'urn:ai17z:params:oauth:grant-type:installation-key' },
  });
  if (answer.status === 400 && answer.body?.error === 'invalid_grant') {
    await markRevoked('Studio says this installation is no longer linked. Link it again from the Plugins screen.');
    return { ok: false, why: 'Studio says this installation is no longer linked.' };
  }
  const token = answer.body?.access_token;
  if (answer.status !== 200 || typeof token !== 'string') return { ok: false, why: describe(answer) };
  const ttl = typeof answer.body?.expires_in === 'number' ? answer.body.expires_in : 300;
  accessCache = { token, expiresAt: Date.now() + ttl * 1000, installationId: link.installationId };
  return token;
}

/** A request as this linked installation: access token plus a proof bound to it. */
async function authed(
  path: string,
  init: { method: 'GET' | 'POST'; json?: unknown },
): Promise<StudioAnswer | StudioProblem> {
  const ready = await linkedContext();
  if ('ok' in ready) return ready;
  const token = await accessToken(ready.where, ready.key, ready.link);
  if (typeof token !== 'string') return token;
  const answer = await send(ready.where, path, {
    method: init.method,
    headers: {
      authorization: `DPoP ${token}`,
      dpop: dpopProof(ready.key, init.method, `${ready.where.origin}${path.split('?')[0]}`, token),
    },
    ...(init.json === undefined ? {} : { json: init.json }),
  });
  if (answer.status === 401) {
    forgetTokens();
    // One retry with a fresh token, because an access token can expire
    // between the cache check and Studio reading it. A second 401 is Studio
    // meaning it.
    const again = await accessToken(ready.where, ready.key, ready.link);
    if (typeof again !== 'string') return again;
    const retried = await send(ready.where, path, {
      method: init.method,
      headers: {
        authorization: `DPoP ${again}`,
        dpop: dpopProof(ready.key, init.method, `${ready.where.origin}${path.split('?')[0]}`, again),
      },
      ...(init.json === undefined ? {} : { json: init.json }),
    });
    if (retried.status === 401) {
      await markRevoked('Studio no longer accepts this installation. Link it again from the Plugins screen.');
      return { ok: false, why: 'Studio no longer accepts this installation.' };
    }
    return retried;
  }
  return answer;
}

async function linkedContext(): Promise<{ where: StudioOrigin; key: InstallationKey; link: LinkRecord } | StudioProblem> {
  const where = await studioOrigin();
  if (!where) return { ok: false, why: 'No Studio address is configured.' };
  const link = await linkRecord();
  if (!link || link.revokedAt) return { ok: false, why: 'This installation is not linked to Studio.' };
  if (link.origin !== where.origin) {
    return { ok: false, why: `This installation is linked to ${link.origin}, and the configured Studio is ${where.origin}.` };
  }
  const key = await installationKey();
  if (!key) return { ok: false, why: 'The key this installation was linked with cannot be read. Link it again.' };
  return { where, key, link };
}

async function markRevoked(why: string): Promise<void> {
  const link = await linkRecord();
  forgetTokens();
  if (link && !link.revokedAt) await ops.setSetting(LINK_SETTING, { ...link, revokedAt: new Date().toISOString() });
  // Fails closed at once: without a lease no marketplace Plugin runs.
  await ops.setSetting(LEASE_SETTING, null);
  await noteSync(why);
}

async function noteSync(problem: string | null): Promise<void> {
  const now = new Date().toISOString();
  const before = (await ops.getSetting<SyncRecord>(SYNC_SETTING)) ?? { attemptedAt: now, okAt: null, problem: null };
  await ops.setSetting(SYNC_SETTING, { attemptedAt: now, okAt: problem ? before.okAt : now, problem });
}

// ---------------------------------------------------------------------------
// Linking
// ---------------------------------------------------------------------------

function platformName(): 'windows' | 'macos' | 'ubuntu' | 'linux' | 'docker' {
  if (process.env.AI17Z_IN_CONTAINER === '1') return 'docker';
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'macos';
  return 'linux';
}

const PLATFORM_LABEL: Record<string, string> = { windows: 'Windows', macos: 'macOS', ubuntu: 'Ubuntu', linux: 'Linux', docker: 'Docker' };

/**
 * Starts linking. The owner then types the code shown on Studio's /connect
 * page, where they decide whether this replaces an installation they had
 * before; `replacePrevious` only suggests the one this installation remembers.
 */
export async function beginStudioLink(options: { replacePrevious?: boolean } = {}): Promise<
  | { ok: true; userCode: string; verificationUri: string; verificationUriComplete: string; expiresAt: string }
  | StudioProblem
> {
  const where = await studioOrigin();
  if (!where) return { ok: false, why: 'Set the AI17Z Studio address first.' };
  const link = await linkRecord();
  if (link && !link.revokedAt) return { ok: false, why: 'This installation is already linked. Disconnect it first to link again.' };

  const previous = (await ops.getSetting<{ installationId: string; origin: string }>(PREVIOUS_SETTING)) ?? null;
  const replaces =
    options.replacePrevious !== false
      ? previous && previous.origin === where.origin
        ? previous.installationId
        : link?.revokedAt && link.origin === where.origin
          ? link.installationId
          : null
      : null;

  // A fresh key for every link. Studio refuses to link a key it has seen
  // before, so a key never outlives the link it was made for.
  const key = newInstallationKey();
  const platform = platformName();
  const instance = (process.env.AI17Z_INSTANCE_NAME ?? '').trim();
  const answer = await send(where, '/api/v1/device/authorize', {
    method: 'POST',
    json: {
      client_name: `AI17Z on ${PLATFORM_LABEL[platform]}`,
      platform,
      ai17z_version: buildVersion().version,
      ...(instance ? { instance_label: instance.slice(0, 80) } : {}),
      public_key: key.publicJwk,
      ...(replaces ? { replaces_installation_id: replaces } : {}),
    },
  }).catch((error: Error) => ({ status: 0, body: { error_description: error.message } }) as StudioAnswer);
  const body = answer.body ?? {};
  if (answer.status !== 200 || typeof body.device_code !== 'string' || typeof body.user_code !== 'string') {
    return { ok: false, why: answer.status === 0 ? `Studio could not be reached: ${String(body.error_description)}` : describe(answer) };
  }
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 600;
  const pending: PendingRecord = {
    origin: where.origin,
    deviceCodeSealed: sealSecret(body.device_code),
    userCode: body.user_code,
    verificationUri: String(body.verification_uri ?? `${where.origin}/connect`),
    verificationUriComplete: String(body.verification_uri_complete ?? `${where.origin}/connect`),
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    interval: typeof body.interval === 'number' ? body.interval : 5,
    replaces,
  };
  await writeSealed(KEY_SETTING, key);
  await ops.setSetting(PENDING_SETTING, pending);
  if (link?.revokedAt) await ops.setSetting(LINK_SETTING, null);
  return {
    ok: true,
    userCode: pending.userCode,
    verificationUri: pending.verificationUri,
    verificationUriComplete: pending.verificationUriComplete,
    expiresAt: pending.expiresAt,
  };
}

const PinnedJwks = z.object({
  keys: z
    .array(z.object({ kid: z.string().min(1).max(64), kty: z.literal('EC'), crv: z.literal('P-256'), x: z.string(), y: z.string() }).passthrough())
    .min(1)
    .max(10),
});

/**
 * Pins Studio's lease keys. A kid already pinned keeps the key it was pinned
 * with, whatever a later answer claims, so a Studio answer can add a rotated
 * key but never swap one out from under a lease.
 */
async function pinLeaseKeys(where: StudioOrigin): Promise<PinnedKeys | StudioProblem> {
  const answer = await send(where, '/api/v1/lease-keys', { method: 'GET' });
  const parsed = PinnedJwks.safeParse(answer.body);
  if (answer.status !== 200 || !parsed.success) return { ok: false, why: `Studio's lease keys could not be read. ${describe(answer)}` };
  const existing = await readSealed<PinnedKeys>(JWKS_SETTING);
  const keys = existing && existing.origin === where.origin ? [...existing.keys] : [];
  for (const offered of parsed.data.keys) {
    if (keys.some((k) => k.kid === offered.kid)) continue;
    keys.push({ kid: offered.kid, kty: 'EC', crv: 'P-256', x: offered.x, y: offered.y });
  }
  const pinned = { origin: where.origin, keys: keys.slice(-10) };
  await writeSealed(JWKS_SETTING, pinned);
  return pinned;
}

/** Asks Studio whether the owner approved yet, and finishes linking when they have. */
export async function pollStudioLink(): Promise<
  { state: 'LINKED'; installationId: string } | { state: 'PENDING'; userCode: string; expiresAt: string } | { state: 'NONE' } | { state: 'FAILED'; why: string }
> {
  const pending = await ops.getSetting<PendingRecord>(PENDING_SETTING);
  if (!pending) {
    const link = await linkRecord();
    return link && !link.revokedAt ? { state: 'LINKED', installationId: link.installationId } : { state: 'NONE' };
  }
  const where = await studioOrigin();
  const key = await installationKey();
  if (!where || where.origin !== pending.origin || !key) {
    await ops.setSetting(PENDING_SETTING, null);
    return { state: 'FAILED', why: 'The Studio address changed while linking. Start again.' };
  }
  if (Date.parse(pending.expiresAt) <= Date.now()) {
    await ops.setSetting(PENDING_SETTING, null);
    return { state: 'FAILED', why: 'The code expired before it was approved. Start again.' };
  }
  let deviceCode: string;
  try {
    deviceCode = openSecret(pending.deviceCodeSealed);
  } catch {
    await ops.setSetting(PENDING_SETTING, null);
    return { state: 'FAILED', why: 'The pending link cannot be read. Start again.' };
  }
  const answer = await send(where, '/api/v1/token', {
    method: 'POST',
    headers: { dpop: dpopProof(key, 'POST', `${where.origin}/api/v1/token`) },
    form: { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: deviceCode },
  }).catch((error: Error) => ({ status: 0, body: { error: 'unreachable', error_description: error.message } }) as StudioAnswer);

  const error = answer.body?.error;
  if (answer.status === 200 && typeof answer.body?.installation_id === 'string' && typeof answer.body.access_token === 'string') {
    const installationId = answer.body.installation_id;
    const link: LinkRecord = { installationId, origin: where.origin, linkedAt: new Date().toISOString(), revokedAt: null };
    await ops.setSetting(LINK_SETTING, link);
    await ops.setSetting(PENDING_SETTING, null);
    await ops.setSetting(PREVIOUS_SETTING, null);
    const ttl = typeof answer.body.expires_in === 'number' ? answer.body.expires_in : 300;
    accessCache = { token: answer.body.access_token, expiresAt: Date.now() + ttl * 1000, installationId };
    const pinned = await pinLeaseKeys(where);
    if ('ok' in pinned) await noteSync(pinned.why);
    else await syncStudio();
    return { state: 'LINKED', installationId };
  }
  if (error === 'authorization_pending' || error === 'slow_down' || error === 'unreachable') {
    if (typeof answer.body?.interval === 'number') await ops.setSetting(PENDING_SETTING, { ...pending, interval: answer.body.interval });
    return { state: 'PENDING', userCode: pending.userCode, expiresAt: pending.expiresAt };
  }
  // Somebody else polling may have finished it a moment ago, in which case
  // the link is what to report.
  const link = await linkRecord();
  if (link && !link.revokedAt) return { state: 'LINKED', installationId: link.installationId };
  if (error === 'invalid_grant') {
    // Also what the loser of two pollers hears while the winner is still
    // writing the link down. The key is left alone, because it is the one the
    // link is being made with; the code simply runs out if nobody finishes.
    return { state: 'PENDING', userCode: pending.userCode, expiresAt: pending.expiresAt };
  }
  await ops.setSetting(PENDING_SETTING, null);
  return {
    state: 'FAILED',
    why: error === 'access_denied' ? 'The link was denied on Studio.' : 'The code is no longer valid. Start again.',
  };
}

/**
 * Disconnects. Studio is told first, so the old key stops working there and
 * its seats are released for the next link to carry; if Studio cannot be
 * reached the local link is still removed, and the screen says Studio was not
 * told. Purchases belong to the account and are untouched either way.
 */
export async function disconnectStudio(): Promise<{ ok: true; studioTold: boolean; why?: string }> {
  const link = await linkRecord();
  let studioTold = false;
  let why: string | undefined;
  if (link && !link.revokedAt) {
    const answer = await authed('/api/v1/installation/revoke', { method: 'POST' }).catch((error: Error) => ({ ok: false as const, why: error.message }));
    if ('status' in answer && answer.status === 200) studioTold = true;
    else why = 'ok' in answer ? answer.why : describe(answer);
  } else if (link?.revokedAt) {
    studioTold = true;
  }
  if (link) await ops.setSetting(PREVIOUS_SETTING, { installationId: link.installationId, origin: link.origin });
  forgetTokens();
  for (const setting of [LINK_SETTING, PENDING_SETTING, KEY_SETTING, LEASE_SETTING, JWKS_SETTING, SYNC_SETTING]) {
    await ops.setSetting(setting, null);
  }
  return why ? { ok: true, studioTold, why } : { ok: true, studioTold };
}

// ---------------------------------------------------------------------------
// Entitlement sync and the lease
// ---------------------------------------------------------------------------

export interface LeaseEntitlement {
  entitlement_id: string;
  plugin_id: string;
  revision: number;
  usable: boolean;
  reason: string | null;
  delivery_mode: string | null;
  version: string | null;
  manifest_sha256: string | null;
  capability_ids: string[];
}

const LeasePayload = z.object({
  iss: z.string(),
  aud: z.union([z.string(), z.array(z.string())]),
  sub: z.string(),
  iat: z.number(),
  exp: z.number(),
  jti: z.string(),
  cnf: z.object({ jkt: z.string() }),
  entitlements: z
    .array(
      z.object({
        entitlement_id: z.string(),
        plugin_id: z.string(),
        revision: z.number(),
        usable: z.boolean(),
        reason: z.string().nullable(),
        delivery_mode: z.string().nullable(),
        version: z.string().nullable(),
        manifest_sha256: z.string().nullable(),
        capability_ids: z.array(z.string()),
      }),
    )
    .max(1000),
});

export type LeaseVerdict =
  | { ok: true; expiresAt: Date; issuedAt: Date; entitlements: LeaseEntitlement[] }
  | { ok: false; why: string };

/**
 * Whether a lease says what it claims, for this installation, now. Pure apart
 * from the clock, so every branch is a test.
 */
export function verifyLease(
  jws: string,
  expect: { origin: string; installationId: string; thumbprint: string; keys: PinnedKeys['keys'] },
  now: Date = new Date(),
): LeaseVerdict {
  const checked = verifyEs256(jws, expect.keys);
  if (!checked.ok) return { ok: false, why: `The entitlement lease is not genuine: ${checked.why}.` };
  if (checked.value.header.typ !== LEASE_TYPE) return { ok: false, why: 'The entitlement lease is the wrong kind of token.' };
  const payload = LeasePayload.safeParse(checked.value.payload);
  if (!payload.success) return { ok: false, why: 'The entitlement lease is in a shape this version does not understand.' };
  const lease = payload.data;
  const audience = Array.isArray(lease.aud) ? lease.aud : [lease.aud];
  if (lease.iss !== expect.origin) return { ok: false, why: 'The entitlement lease was issued by a different Studio.' };
  if (!audience.includes(LEASE_AUDIENCE)) return { ok: false, why: 'The entitlement lease is not addressed to an installation.' };
  if (lease.sub !== expect.installationId) return { ok: false, why: 'The entitlement lease belongs to a different installation.' };
  if (lease.cnf.jkt !== expect.thumbprint) return { ok: false, why: "The entitlement lease is bound to a different installation key." };
  const seconds = Math.floor(now.getTime() / 1000);
  if (lease.iat > seconds + CLOCK_SKEW_SECONDS) return { ok: false, why: 'The entitlement lease is dated in the future.' };
  if (lease.exp <= seconds) {
    return {
      ok: false,
      why: `The last entitlement check with Studio was valid until ${new Date(lease.exp * 1000).toISOString()}. Marketplace Plugins pause until Studio can be reached again; nothing else is affected.`,
    };
  }
  return { ok: true, expiresAt: new Date(lease.exp * 1000), issuedAt: new Date(lease.iat * 1000), entitlements: lease.entitlements };
}

/** The current lease, verified. */
export async function currentLease(now: Date = new Date()): Promise<LeaseVerdict> {
  // The link first: a revoked installation has no lease either, and "none yet"
  // would send its owner to wait for something that is not coming.
  const link = await linkRecord();
  if (!link) return { ok: false, why: 'This installation is not linked to AI17Z Studio.' };
  if (link.revokedAt) return { ok: false, why: 'Studio says this installation is no longer linked. Link it again from the Plugins screen.' };
  const record = await ops.getSetting<LeaseRecord>(LEASE_SETTING);
  if (!record?.lease) return { ok: false, why: 'This installation has no entitlements from Studio yet.' };
  const key = await installationKey();
  const pinned = await readSealed<PinnedKeys>(JWKS_SETTING);
  if (!key || !pinned || pinned.origin !== link.origin) return { ok: false, why: "Studio's lease keys are not pinned on this installation. Sync again." };
  return verifyLease(record.lease, { origin: link.origin, installationId: link.installationId, thumbprint: key.thumbprint, keys: pinned.keys }, now);
}

/**
 * Asks Studio what this installation may use, and keeps the answer only if
 * the lease that came with it verifies. A failed sync keeps the last good
 * lease, which runs out on its own.
 */
export async function syncStudio(): Promise<{ ok: true; entitlements: LeaseEntitlement[]; validUntil: string } | StudioProblem> {
  const ready = await linkedContext();
  if ('ok' in ready) return ready;
  const answer = await authed('/api/v1/installation/entitlements', { method: 'GET' }).catch(
    (error: Error) => ({ ok: false as const, why: `Studio could not be reached: ${error.message}` }),
  );
  if ('ok' in answer) {
    await noteSync(answer.why);
    return answer;
  }
  const lease = answer.body?.lease;
  if (answer.status !== 200 || typeof lease !== 'string') {
    const why = describe(answer);
    await noteSync(why);
    return { ok: false, why };
  }
  let pinned = await readSealed<PinnedKeys>(JWKS_SETTING);
  const kid = (() => {
    try {
      return (JSON.parse(Buffer.from(lease.split('.')[0] ?? '', 'base64url').toString('utf8')) as { kid?: string }).kid;
    } catch {
      return undefined;
    }
  })();
  if (!pinned || pinned.origin !== ready.link.origin || !pinned.keys.some((k) => k.kid === kid)) {
    const repinned = await pinLeaseKeys(ready.where);
    if ('ok' in repinned) {
      await noteSync(repinned.why);
      return repinned;
    }
    pinned = repinned;
  }
  const verdict = verifyLease(lease, {
    origin: ready.link.origin,
    installationId: ready.link.installationId,
    thumbprint: ready.key.thumbprint,
    keys: pinned.keys,
  });
  if (!verdict.ok) {
    await noteSync(verdict.why);
    return { ok: false, why: verdict.why };
  }
  await ops.setSetting(LEASE_SETTING, {
    lease,
    syncedAt: new Date().toISOString(),
    validUntil: verdict.expiresAt.toISOString(),
  } satisfies LeaseRecord);
  await noteSync(null);
  await refreshLedgerFromStudio().catch(() => undefined);
  return { ok: true, entitlements: verdict.entitlements, validUntil: verdict.expiresAt.toISOString() };
}

// ---------------------------------------------------------------------------
// The gate every marketplace capability passes
// ---------------------------------------------------------------------------

export interface GovernedPlugin {
  id: string;
  version: string;
  manifestSha256: string;
  requiresEntitlement: boolean;
  /** Hosts the Plugin's capabilities reach. */
  hosts: readonly string[];
}

/**
 * Which Plugins answer to Studio: any the registry listed as needing an
 * entitlement, and any whose capabilities reach Studio's gateway however it
 * was installed. The second is not a flag anybody can clear: the gateway
 * decides every call itself.
 */
export async function isMarketplacePlugin(plugin: Pick<GovernedPlugin, 'requiresEntitlement' | 'hosts'>): Promise<boolean> {
  if (plugin.requiresEntitlement) return true;
  const where = await studioOrigin();
  if (!where) return false;
  const host = new URL(where.origin).hostname;
  return plugin.hosts.includes(host);
}

/** Pure: what a verified lease says about one capability of one installed Plugin. */
export function entitlementDecision(
  entitlements: readonly LeaseEntitlement[],
  plugin: Pick<GovernedPlugin, 'id' | 'version' | 'manifestSha256'>,
  capabilityId: string,
): { ok: true } | { ok: false; why: string } {
  const entry = entitlements.find((e) => e.plugin_id === plugin.id);
  if (!entry) return { ok: false, why: `Your Studio account has no entitlement for ${plugin.id}.` };
  if (!entry.usable) {
    const reasons: Record<string, string> = {
      NO_SEAT_FOR_THIS_INSTALLATION: 'it is not assigned to this installation. Assign it on Studio under My Tools',
      ENTITLEMENT_REVOKED: 'the entitlement was revoked',
      ENTITLEMENT_EXPIRED: 'the entitlement expired',
      PUBLISHER_SUSPENDED: 'its publisher is suspended',
      NO_PUBLISHED_VERSION: 'no version of it is published right now',
    };
    const reason = entry.reason ?? 'UNKNOWN';
    return { ok: false, why: `${plugin.id} cannot run here: ${reasons[reason] ?? reason.toLowerCase().replace(/_/g, ' ')}.` };
  }
  if (entry.version !== plugin.version || entry.manifest_sha256 !== plugin.manifestSha256) {
    return {
      ok: false,
      why: `The installed ${plugin.id} ${plugin.version} is not the version Studio publishes (${entry.version ?? 'none'}). Update it from the Plugins screen.`,
    };
  }
  if (!entry.capability_ids.includes(capabilityId)) {
    return { ok: false, why: `${capabilityId} is not part of what your entitlement for ${plugin.id} covers.` };
  }
  return { ok: true };
}

/**
 * Checked in readiness and again at the start of every run, so a Plugin whose
 * entitlement lapsed while a job was queued stops rather than finishing.
 */
export async function marketplaceGate(plugin: GovernedPlugin, capabilityId: string): Promise<{ ok: true } | { ok: false; why: string }> {
  if (!(await isMarketplacePlugin(plugin))) return { ok: true };
  const lease = await currentLease();
  if (!lease.ok) return lease;
  return entitlementDecision(lease.entitlements, plugin, capabilityId);
}

// ---------------------------------------------------------------------------
// Hosted gateway and registry authentication
// ---------------------------------------------------------------------------

/**
 * Headers for one call to Studio's hosted gateway: a short-lived tool token
 * for this capability and a DPoP proof for this exact request. Refused for
 * any URL not on the linked Studio, so these never travel anywhere else.
 */
export async function studioGatewayHeaders(
  pluginId: string,
  capabilityName: string,
  url: string,
  method: 'GET' | 'POST',
): Promise<{ ok: true; headers: Record<string, string>; allowPrivate: boolean } | StudioProblem> {
  const ready = await linkedContext();
  if ('ok' in ready) return ready;
  const target = new URL(url);
  if (target.origin !== ready.where.origin || !target.pathname.startsWith('/api/gateway/v1/')) {
    return { ok: false, why: 'Refused to send Studio credentials to an address that is not the linked Studio gateway.' };
  }
  const cacheKey = `${pluginId}\u0000${capabilityName}`;
  let tool = toolCache.get(cacheKey);
  if (!tool || tool.expiresAt <= Date.now() + 20_000) {
    const answer = await authed('/api/v1/tool-authorizations', { method: 'POST', json: { plugin: pluginId, capabilities: [capabilityName] } });
    if ('ok' in answer) return answer;
    const token = answer.body?.tool_token;
    if (answer.status !== 200 || typeof token !== 'string') return { ok: false, why: describe(answer) };
    const ttl = typeof answer.body?.expires_in === 'number' ? answer.body.expires_in : 60;
    tool = { token, expiresAt: Date.now() + ttl * 1000 };
    toolCache.set(cacheKey, tool);
  }
  return {
    ok: true,
    headers: {
      authorization: `DPoP ${tool.token}`,
      dpop: dpopProof(ready.key, method, `${target.origin}${target.pathname}`, tool.token),
    },
    allowPrivate: ready.where.unsafeDev,
  };
}

/**
 * Authentication for a registry request, when the registry is the linked
 * Studio: the installation's own token and proof rather than a stored key.
 * Null when not linked, so the caller falls back to what it had.
 */
export async function studioRegistryHeaders(base: string, path: string): Promise<Record<string, string> | null> {
  const ready = await linkedContext();
  if ('ok' in ready || ready.where.origin !== base) return null;
  const token = await accessToken(ready.where, ready.key, ready.link);
  if (typeof token !== 'string') return null;
  return { authorization: `DPoP ${token}`, dpop: dpopProof(ready.key, 'GET', `${base}${path.split('?')[0]}`, token) };
}

// ---------------------------------------------------------------------------
// Purchases completed here
// ---------------------------------------------------------------------------

const PurchaseList = z.object({
  protocol: z.literal(1),
  purchases: z
    .array(
      z.object({
        intent_id: z.string(),
        plugin_id: z.string(),
        plugin_name: z.string(),
        status: z.string(),
        chain_id: z.number(),
        token_address: z.string(),
        token_decimals: z.number(),
        payer_address: z.string(),
        recipient_address: z.string(),
        amount_base_units: z.string(),
        expires_at: z.string(),
        submitted_tx_hash: z.string().nullable(),
        failure_reason: z.string().nullable(),
        publisher: z.string().optional(),
        plugin_version: z.string().optional(),
        created_at: z.string().optional(),
      }),
    )
    .max(50),
});
export type StudioPurchase = z.infer<typeof PurchaseList>['purchases'][number];

export async function studioPurchases(): Promise<{ ok: true; purchases: StudioPurchase[] } | StudioProblem> {
  const answer = await authed('/api/v1/installation/purchases', { method: 'GET' }).catch(
    (error: Error) => ({ ok: false as const, why: `Studio could not be reached: ${error.message}` }),
  );
  if ('ok' in answer) return answer;
  const parsed = PurchaseList.safeParse(answer.body);
  if (answer.status !== 200 || !parsed.success) return { ok: false, why: describe(answer) };
  return { ok: true, purchases: parsed.data.purchases };
}

async function refreshLedgerFromStudio(): Promise<void> {
  const listed = await studioPurchases();
  if (!listed.ok) return;
  for (const purchase of listed.purchases) {
    const known = await ledger.getPurchase(purchase.intent_id);
    if (known) await ledger.noteStudioStatus(purchase.intent_id, purchase.status, purchase.failure_reason);
  }
}

/**
 * Builds the one transfer a purchase allows, from terms read from Studio at
 * this moment rather than from anything the page sent, and records that the
 * wallet is about to be asked. Owner control plane only: an API route an
 * owner's button calls, never a capability.
 */
export async function prepareStudioPurchase(intentId: string): Promise<{ ok: true; purchase: PreparedMarketplacePurchase } | StudioProblem> {
  const listed = await studioPurchases();
  if (!listed.ok) return listed;
  const terms = listed.purchases.find((p) => p.intent_id === intentId);
  if (!terms) return { ok: false, why: 'Studio has no purchase with that id waiting for this installation.' };
  const prepared = prepareMarketplacePurchase(terms as StudioPurchaseTerms);
  if (!prepared.ok) return prepared;
  // Again here, whatever the page already showed: the page is not what decides.
  const preflight = await preflightPurchase(prepared.purchase);
  if (!preflight.ok) {
    const failed = preflight.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);
    return { ok: false, why: `The chain does not agree this transfer can go ahead (${failed.join('; ')}), so your wallet was not asked.` };
  }
  const p = prepared.purchase;
  const claimed = await ledger.claimPrepare({
    intentId: p.intentId,
    pluginId: p.pluginId,
    pluginName: p.pluginName,
    chainId: p.chainId,
    tokenAddress: p.token,
    payerAddress: p.payer,
    recipientAddress: p.recipient,
    amountBaseUnits: p.amountBaseUnits,
  });
  if (!claimed.ok) return { ok: false, why: claimed.why };
  return prepared;
}

/**
 * The wallet returned a transaction hash: recorded here first, so it is
 * never lost and the purchase is never prepared again, then reported to
 * Studio, which grants nothing until it has read the chain itself.
 */
export async function recordStudioPurchaseSent(
  intentId: string,
  txHash: string,
): Promise<{ ok: true; studioStatus: string | null; studioProblem?: string } | StudioProblem> {
  const marked = await ledger.markSent(intentId, txHash);
  if (!marked.ok) return marked;
  const answer = await authed(`/api/v1/installation/purchases/${encodeURIComponent(intentId)}/transaction`, {
    method: 'POST',
    json: { tx_hash: marked.row.txHash },
  }).catch((error: Error) => ({ ok: false as const, why: `Studio could not be reached: ${error.message}` }));
  if ('ok' in answer) return { ok: true, studioStatus: null, studioProblem: `${answer.why} The transaction is recorded here and will be reported on the next sync.` };
  if (answer.status !== 200) return { ok: true, studioStatus: null, studioProblem: describe(answer) };
  const status = typeof answer.body?.status === 'string' ? answer.body.status : null;
  if (status) await ledger.noteStudioStatus(intentId, status, null);
  return { ok: true, studioStatus: status };
}

/** Reports any transaction recorded here that Studio has not acknowledged yet. */
export async function reportUnacknowledgedPurchases(): Promise<void> {
  const rows = await ledger.listPurchases(50);
  for (const row of rows) {
    if (row.state !== 'SENT' || !row.txHash || row.studioStatus) continue;
    await recordStudioPurchaseSent(row.intentId, row.txHash).catch(() => undefined);
  }
}

export async function abandonStudioPurchase(intentId: string): Promise<{ ok: boolean; why?: string }> {
  return ledger.markAbandoned(intentId);
}

// ---------------------------------------------------------------------------
// Linking a wallet from here
// ---------------------------------------------------------------------------

/**
 * What a Studio wallet challenge must say before it is put in front of the
 * owner's wallet. Studio writes the message; this checks it is the kind of
 * message it claims to be, for the wallet it names, so a Studio that sent
 * something else to be signed is refused here rather than signed.
 */
export function isWalletLinkChallenge(message: string, address: string): boolean {
  if (typeof message !== 'string' || message.length > 2000) return false;
  const lines = message.split('\n');
  const wallet = lines.find((line) => line.startsWith('Wallet: '))?.slice('Wallet: '.length).trim().toLowerCase();
  return (
    wallet === address.toLowerCase() &&
    message.includes('Link this wallet to my AI17Z Studio account') &&
    message.includes(`Chain: ${AI17Z_PAYMENT.chainName} (${AI17Z_PAYMENT.chainId})`) &&
    message.includes('Signing this message does not send a transaction, grant any allowance, or cost gas.') &&
    /^Nonce: \S+$/m.test(message) &&
    /^Expires: \S+$/m.test(message)
  );
}

export async function studioWallets(): Promise<{ ok: true; wallets: Array<{ address: string; chain_id: number; verified_at: string }> } | StudioProblem> {
  const answer = await authed('/api/v1/installation/wallets', { method: 'GET' }).catch(
    (error: Error) => ({ ok: false as const, why: `Studio could not be reached: ${error.message}` }),
  );
  if ('ok' in answer) return answer;
  const wallets = answer.body?.wallets;
  if (answer.status !== 200 || !Array.isArray(wallets)) return { ok: false, why: describe(answer) };
  return { ok: true, wallets: wallets as Array<{ address: string; chain_id: number; verified_at: string }> };
}

/** A one-time message for the owner's wallet to sign, checked before it is shown. */
export async function studioWalletChallenge(address: string): Promise<{ ok: true; challengeId: string; message: string } | StudioProblem> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return { ok: false, why: 'That is not a wallet address.' };
  const answer = await authed('/api/v1/installation/wallets/challenges', { method: 'POST', json: { address } }).catch(
    (error: Error) => ({ ok: false as const, why: `Studio could not be reached: ${error.message}` }),
  );
  if ('ok' in answer) return answer;
  const message = answer.body?.message;
  const challengeId = answer.body?.challenge_id;
  if (answer.status !== 200 || typeof message !== 'string' || typeof challengeId !== 'string') return { ok: false, why: describe(answer) };
  if (!isWalletLinkChallenge(message, address)) {
    return { ok: false, why: 'Studio asked for a signature that is not a wallet-link message for this wallet, so it was not shown to your wallet.' };
  }
  return { ok: true, challengeId, message };
}

export async function studioLinkWallet(challengeId: string, signature: string): Promise<{ ok: true } | StudioProblem> {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) return { ok: false, why: 'That is not a wallet signature.' };
  const answer = await authed('/api/v1/installation/wallets', { method: 'POST', json: { challenge_id: challengeId, signature } }).catch(
    (error: Error) => ({ ok: false as const, why: `Studio could not be reached: ${error.message}` }),
  );
  if ('ok' in answer) return answer;
  return answer.status === 200 ? { ok: true } : { ok: false, why: describe(answer) };
}

// ---------------------------------------------------------------------------
// Reading the chain before a wallet is asked
// ---------------------------------------------------------------------------

export interface PreflightCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface JsonRpc {
  (method: string, params: unknown[]): Promise<unknown>;
}

async function publicRpc(method: string, params: unknown[]): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await safeFetch(AI17Z_PAYMENT.rpcUrl, {
      signal: controller.signal,
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      maxBytes: 256 * 1024,
      noRedirects: true,
    });
    const body = JSON.parse(response.text) as { result?: unknown; error?: { message?: string } };
    if (body.error) throw new Error(body.error.message ?? 'the node refused the call');
    return body.result;
  } finally {
    clearTimeout(timer);
  }
}

let rpcOverride: JsonRpc | null = null;
export function setPaymentRpcForTests(rpc: JsonRpc | null): void {
  rpcOverride = rpc;
}

const SELECTOR = { decimals: '0x313ce567', symbol: '0x95d89b41', balanceOf: '0x70a08231' } as const;

function decodeString(hex: string): string | null {
  try {
    const data = hex.replace(/^0x/, '');
    const length = Number.parseInt(data.slice(64, 128), 16);
    return Buffer.from(data.slice(128, 128 + length * 2), 'hex').toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Asks the chain itself, read only, whether the transfer about to be signed is
 * the one it looks like: the chain the node serves, the token at the pinned
 * address answering with the pinned decimals and symbol, enough $AI17Z in the
 * paying wallet, and a gas estimate for the exact call, which a transfer that
 * would revert does not get. Nothing here sends or signs anything.
 */
export async function preflightPurchase(purchase: PreparedMarketplacePurchase): Promise<{ ok: boolean; checks: PreflightCheck[] }> {
  const rpc = rpcOverride ?? publicRpc;
  const checks: PreflightCheck[] = [];
  const check = async (name: string, run: () => Promise<{ ok: boolean; detail: string }>) => {
    try {
      checks.push({ name, ...(await run()) });
    } catch (error) {
      checks.push({ name, ok: false, detail: `could not be read: ${(error as Error).message}` });
    }
  };
  await check('Chain', async () => {
    const id = String(await rpc('eth_chainId', []));
    return { ok: id.toLowerCase() === purchase.chainIdHex, detail: `the node serves chain ${Number.parseInt(id, 16)}` };
  });
  await check('Token decimals', async () => {
    const value = Number.parseInt(String(await rpc('eth_call', [{ to: purchase.token, data: SELECTOR.decimals }, 'latest'])), 16);
    return { ok: value === AI17Z_PAYMENT.decimals, detail: `the contract reports ${value}` };
  });
  await check('Token symbol', async () => {
    const symbol = decodeString(String(await rpc('eth_call', [{ to: purchase.token, data: SELECTOR.symbol }, 'latest'])));
    return { ok: symbol?.toLowerCase() === AI17Z_PAYMENT.symbol.toLowerCase(), detail: `the contract reports "${symbol ?? '?'}"` };
  });
  await check('Balance', async () => {
    const raw = String(await rpc('eth_call', [{ to: purchase.token, data: `${SELECTOR.balanceOf}${purchase.payer.slice(2).padStart(64, '0')}` }, 'latest']));
    const balance = BigInt(raw === '0x' ? '0x0' : raw);
    const enough = balance >= BigInt(purchase.amountBaseUnits);
    return { ok: enough, detail: `${formatBaseUnits(balance.toString())} AI17Z in the paying wallet` };
  });
  await check('Would succeed', async () => {
    const gas = BigInt(String(await rpc('eth_estimateGas', [{ from: purchase.payer, to: purchase.token, data: purchase.transaction.data, value: '0x0' }])));
    return { ok: gas > 0n, detail: `the node estimates ${gas} gas for exactly this transfer` };
  });
  await check('Gas money', async () => {
    const native = BigInt(String(await rpc('eth_getBalance', [purchase.payer, 'latest'])));
    return { ok: native > 0n, detail: native > 0n ? 'the paying wallet holds ETH for gas' : 'the paying wallet holds no ETH to pay gas with' };
  });
  return { ok: checks.every((c) => c.ok), checks };
}

/** Everything the owner is shown before they choose to ask their wallet, with nothing claimed or recorded. */
export async function reviewStudioPurchase(
  intentId: string,
): Promise<{ ok: true; purchase: PreparedMarketplacePurchase; terms: StudioPurchase; preflight: { ok: boolean; checks: PreflightCheck[] } } | StudioProblem> {
  const listed = await studioPurchases();
  if (!listed.ok) return listed;
  const terms = listed.purchases.find((p) => p.intent_id === intentId);
  if (!terms) return { ok: false, why: 'Studio has no purchase with that id waiting for this installation.' };
  const prepared = prepareMarketplacePurchase(terms as StudioPurchaseTerms);
  if (!prepared.ok) return prepared;
  return { ok: true, purchase: prepared.purchase, terms, preflight: await preflightPurchase(prepared.purchase) };
}

// ---------------------------------------------------------------------------
// What the Plugins screen shows
// ---------------------------------------------------------------------------

export interface StudioStatus {
  origin: string | null;
  unsafeDev: boolean;
  state: 'NOT_CONFIGURED' | 'NOT_LINKED' | 'PENDING' | 'LINKED' | 'REVOKED';
  installationId: string | null;
  linkedAt: string | null;
  pending: { userCode: string; verificationUri: string; verificationUriComplete: string; expiresAt: string } | null;
  lease: { ok: true; validUntil: string; issuedAt: string; entitlements: LeaseEntitlement[] } | { ok: false; why: string } | null;
  sync: SyncRecord | null;
  canRelink: boolean;
  payment: { chainId: number; chainName: string; token: string; decimals: number };
}

export async function studioStatus(): Promise<StudioStatus> {
  const where = await studioOrigin();
  const link = await linkRecord();
  const pending = await ops.getSetting<PendingRecord>(PENDING_SETTING);
  const sync = await ops.getSetting<SyncRecord>(SYNC_SETTING);
  const previous = await ops.getSetting<{ installationId: string; origin: string }>(PREVIOUS_SETTING);
  const state: StudioStatus['state'] = !where
    ? 'NOT_CONFIGURED'
    : pending
      ? 'PENDING'
      : link?.revokedAt
        ? 'REVOKED'
        : link
          ? 'LINKED'
          : 'NOT_LINKED';
  const verdict = link && !link.revokedAt ? await currentLease() : null;
  return {
    origin: where?.origin ?? null,
    unsafeDev: where?.unsafeDev ?? false,
    state,
    installationId: link?.installationId ?? null,
    linkedAt: link?.linkedAt ?? null,
    pending: pending
      ? { userCode: pending.userCode, verificationUri: pending.verificationUri, verificationUriComplete: pending.verificationUriComplete, expiresAt: pending.expiresAt }
      : null,
    lease: verdict
      ? verdict.ok
        ? { ok: true, validUntil: verdict.expiresAt.toISOString(), issuedAt: verdict.issuedAt.toISOString(), entitlements: verdict.entitlements }
        : { ok: false, why: verdict.why }
      : null,
    sync,
    canRelink: Boolean((previous && where && previous.origin === where.origin) || link?.revokedAt),
    payment: { chainId: AI17Z_PAYMENT.chainId, chainName: AI17Z_PAYMENT.chainName, token: AI17Z_PAYMENT.tokenChecksum, decimals: AI17Z_PAYMENT.decimals },
  };
}

/** Whether a periodic sync is due: linked, and the last attempt long enough ago. */
export async function studioSyncDue(intervalMs: number, now: Date = new Date()): Promise<boolean> {
  const link = await linkRecord();
  const pending = await ops.getSetting<PendingRecord>(PENDING_SETTING);
  if (pending) return true;
  if (!link || link.revokedAt) return false;
  const sync = await ops.getSetting<SyncRecord>(SYNC_SETTING);
  return !sync || now.getTime() - Date.parse(sync.attemptedAt) >= intervalMs;
}
