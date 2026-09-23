import { ops, plugins as pluginsRepo } from '@xbam/database';
import { openSecret, sealSecret } from '@xbam/shared';
import { z } from 'zod';
import { safeFetch } from '@xbam/upstream';
import { REGISTRY_KEY_KEY, REGISTRY_URL_KEY, installPlugin, manifestDigest, readManifest } from './plugins';

/**
 * The client for an official AI17Z Plugin Registry.
 *
 * ## Why there is no address written here
 *
 * This workspace has no official website or backend source in it, and the
 * registry has not been deployed. Inventing a hostname would produce a client
 * that looks finished and points at nothing, and the first symptom would be an
 * owner being told their internet was broken. So the address is configuration
 * with no default: until somebody sets it, the Plugins area says the registry
 * is not configured, which is true, and installing from a file still works.
 *
 * What is finished here is the contract and the client. The server contract is
 * versioned and written down in `docs/architecture/PLUGIN_REGISTRY.md`, and
 * `tests/support/registryServer.ts` implements it, so the client is tested
 * against a real server speaking the real protocol rather than against mocks
 * of itself.
 *
 * ## Why a key is optional
 *
 * A public catalogue is public. Requiring a key to browse would make an API
 * key a thing every installation needs, which is how a narrowly scoped
 * credential turns into a general machine identity. The key is for the things
 * that genuinely need an account: private Plugins, entitlements, and whatever
 * paid distribution eventually means. Everything else works without one.
 */

/** The protocol version this client speaks. Sent, and checked in the answer. */
export const REGISTRY_PROTOCOL = 1;

const RegistryListing = z
  .object({
    id: z.string().min(3).max(64),
    name: z.string().min(2).max(120),
    summary: z.string().max(300),
    publisher: z.string().min(2).max(120),
    version: z.string(),
    /** Set when the catalogue says this one needs an entitlement. */
    entitled: z.boolean().default(false),
    homepage: z.string().url().optional(),
  })
  .strict();
export type RegistryListing = z.infer<typeof RegistryListing>;

const CatalogResponse = z
  .object({
    protocol: z.literal(REGISTRY_PROTOCOL),
    plugins: z.array(RegistryListing).max(500),
  })
  .strict();

const DetailResponse = z
  .object({
    protocol: z.literal(REGISTRY_PROTOCOL),
    plugin: RegistryListing,
    /** The manifest, as the exact text whose hash is published beside it. */
    manifest: z.string().min(2).max(200_000),
    manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export interface RegistryProblem {
  ok: false;
  why: string;
  /** True when the answer would differ with a key, so the UI can say so. */
  needsKey?: boolean;
}

/** The registry address an owner configured, or null when none is set. */
export async function registryAddress(): Promise<string | null> {
  const raw = (await ops.getSetting<string>(REGISTRY_URL_KEY))?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    // Only https, because a catalogue fetched over http is a catalogue
    // somebody on the path chooses.
    return url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

export async function setRegistryAddress(value: string | null): Promise<void> {
  await ops.setSetting(REGISTRY_URL_KEY, value?.trim() || null);
}

/**
 * Whether a key is stored, and its last four characters.
 *
 * Never the key. The last four are what lets somebody recognise which key is
 * in there without the value being readable from a screen, which is the same
 * arrangement the provider keys use.
 */
export async function registryKeyState(): Promise<{ present: boolean; hint: string | null }> {
  const sealed = await ops.getSetting<string>(REGISTRY_KEY_KEY);
  if (!sealed) return { present: false, hint: null };
  try {
    const value = openSecret(sealed);
    return { present: true, hint: value.length > 4 ? value.slice(-4) : null };
  } catch {
    // Sealed by a different master key. Present, and unusable, and saying so
    // beats showing it as working.
    return { present: true, hint: null };
  }
}

export async function setRegistryKey(value: string | null): Promise<void> {
  await ops.setSetting(REGISTRY_KEY_KEY, value ? sealSecret(value) : null);
}

/** Opened only here, only to build one request. Never returned or logged. */
async function keyHeader(): Promise<Record<string, string>> {
  const sealed = await ops.getSetting<string>(REGISTRY_KEY_KEY);
  if (!sealed) return {};
  try {
    return { authorization: `Bearer ${openSecret(sealed)}` };
  } catch {
    return {};
  }
}

/**
 * How a registry request is actually made.
 *
 * Swapped in tests for the same reason `safeFetch` takes a transport: the
 * server this has to be proved against runs on loopback, which `safeFetch`
 * refuses on purpose and which the https rule above refuses again. Both of
 * those are worth keeping, so the seam is here rather than an exception in
 * either of them. Nothing in the product passes this.
 */
export interface RegistryTransport {
  (url: string, headers: Record<string, string>): Promise<{ status: number; text: string }>;
}

export interface RegistryOptions {
  transport?: RegistryTransport;
  /** Used with a transport, since the https rule is about configuration. */
  base?: string;
}

async function get(path: string, options: RegistryOptions = {}): Promise<{ ok: true; body: unknown } | RegistryProblem> {
  const base = options.base ?? (await registryAddress());
  if (!base) {
    return {
      ok: false,
      why: 'No Plugin registry is configured, so there is nothing to browse. A Plugin file can still be installed directly.',
    };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  const headers = {
    accept: 'application/json',
    'x-ai17z-protocol': String(REGISTRY_PROTOCOL),
    ...(await keyHeader()),
  };
  try {
    const response = options.transport
      ? await options.transport(`${base}${path}`, headers)
      : await safeFetch(`${base}${path}`, {
          signal: controller.signal,
          method: 'GET',
          headers,
          maxBytes: 2 * 1024 * 1024,
        });
    if (response.status === 401 || response.status === 403) {
      return { ok: false, why: 'The registry refused this key.', needsKey: true };
    }
    if (response.status < 200 || response.status >= 300) {
      return { ok: false, why: `The registry answered ${response.status}.` };
    }
    try {
      return { ok: true, body: JSON.parse(response.text) };
    } catch {
      return { ok: false, why: 'The registry answered with something that is not JSON.' };
    }
  } catch (error) {
    return { ok: false, why: `The registry could not be reached: ${(error as Error).message}` };
  } finally {
    clearTimeout(timer);
  }
}

/** Browse the catalogue. Works without a key; a key may reveal more. */
export async function registryCatalog(
  search?: string,
  options: RegistryOptions = {},
): Promise<{ ok: true; plugins: RegistryListing[] } | RegistryProblem> {
  const query = search?.trim() ? `?q=${encodeURIComponent(search.trim().slice(0, 100))}` : '';
  const answer = await get(`/api/v1/plugins${query}`, options);
  if (!answer.ok) return answer;
  const shape = CatalogResponse.safeParse(answer.body);
  if (!shape.success) return { ok: false, why: 'The registry answered in a shape this version does not understand.' };
  return { ok: true, plugins: shape.data.plugins };
}

/** One Plugin's detail, including the manifest text and its published hash. */
export async function registryDetail(
  id: string,
  options: RegistryOptions = {},
): Promise<{ ok: true; listing: RegistryListing; manifest: string; manifestSha256: string } | RegistryProblem> {
  const answer = await get(`/api/v1/plugins/${encodeURIComponent(id)}`, options);
  if (!answer.ok) return answer;
  const shape = DetailResponse.safeParse(answer.body);
  if (!shape.success) return { ok: false, why: 'The registry answered in a shape this version does not understand.' };
  return {
    ok: true,
    listing: shape.data.plugin,
    manifest: shape.data.manifest,
    manifestSha256: shape.data.manifestSha256,
  };
}

/**
 * Install from the registry.
 *
 * The hash is checked against the bytes actually received, before anything is
 * parsed or registered. A manifest whose hash does not match what the registry
 * published is refused without being read: a document that has been changed in
 * transit is not one to reason about the contents of.
 */
export async function installFromRegistry(
  id: string,
  options: RegistryOptions & {
    /** The owner has seen what a new version asks for that the old did not. */
    acknowledgeExpansion?: boolean;
  } = {},
): Promise<
  | { ok: true; installedId: string; version: string }
  | { ok: false; why: string; needsAcknowledgement?: string[] }
> {
  const detail = await registryDetail(id, options);
  if (!detail.ok) return { ok: false, why: detail.why };

  const digest = manifestDigest(detail.manifest);
  if (digest !== detail.manifestSha256) {
    return {
      ok: false,
      why: `What arrived for ${id} does not match the checksum the registry published for it, so it was not installed.`,
    };
  }
  const read = readManifest(detail.manifest);
  if (!read.ok) return { ok: false, why: read.why };
  if (read.manifest.id !== id) {
    // A catalogue entry that hands back a manifest for a different Plugin is
    // how an install becomes a substitution.
    return { ok: false, why: `The registry offered ${id} and sent a manifest for ${read.manifest.id}.` };
  }
  if (read.manifest.publisher !== detail.listing.publisher) {
    return { ok: false, why: `The catalogue says ${detail.listing.publisher} publishes ${id}, and the manifest says ${read.manifest.publisher}.` };
  }

  const done = await installPlugin({
    raw: detail.manifest,
    source: 'AI17Z_REGISTRY',
    // The catalogue's own word on who publishes this, held against the
    // manifest by `installPlugin` as well as above. A registry that changed
    // its mind between the listing and the detail is a substitution.
    expectPublisher: detail.listing.publisher,
    ...(options.acknowledgeExpansion ? { acknowledgeExpansion: true } : {}),
  });
  if (!done.ok) return done;
  return { ok: true, installedId: done.plugin.id, version: done.plugin.version };
}

/** Which installed Plugins the registry has a newer version of. */
export async function registryUpdates(
  options: RegistryOptions = {},
): Promise<{ ok: true; updates: Record<string, string> } | RegistryProblem> {
  const catalog = await registryCatalog(undefined, options);
  if (!catalog.ok) return catalog;
  const installed = await pluginsRepo.listInstalledPlugins();
  const updates: Record<string, string> = {};
  for (const record of installed) {
    const listed = catalog.plugins.find((entry) => entry.id === record.id);
    if (!listed) continue;
    // A plain string comparison would call 1.10.0 older than 1.9.0.
    const parts = (value: string) => value.split('.').map((piece) => Number(piece) || 0);
    const [a, b, c] = parts(listed.version);
    const [x, y, z] = parts(record.version);
    const newer = a! > x! || (a === x && (b! > y! || (b === y && c! > z!)));
    if (newer) updates[record.id] = listed.version;
  }
  return { ok: true, updates };
}
