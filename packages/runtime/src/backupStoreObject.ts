import { createHash, createHmac } from 'node:crypto';
import { registerBackupStore, type BackupStore } from './runtimeBackup';

/**
 * Backups on an object store, which is the only kind that survives the host.
 *
 * `backupStoreFs.ts` writes to a disk and says plainly that it is not off-host:
 * a host failure takes it with the thing it was protecting. This is the one
 * that does not, and it is deliberately an S3-compatible client rather than
 * one provider's SDK, because the backup target is deployment configuration
 * and committing to a vendor here would put a cloud choice inside the agent
 * architecture.
 *
 * What it does not do is as important.
 *
 * **It never encrypts anything.** The ciphertext arriving here was sealed by
 * the runtime with the runtime's own key, before it left the confidential
 * boundary. Possession of this bucket is possession of ciphertext, which is
 * the entire reason an off-host backup is safe to have. A store that encrypted
 * on the way out would be a store that could decrypt on the way back.
 *
 * **It does not trust a key it was handed.** A location read from a database
 * row is data, and a row somebody edited is not permission to fetch an
 * arbitrary object: every key is checked against the prefix this store owns.
 *
 * **It signs its own requests.** AWS Signature Version 4, implemented here
 * rather than pulled in, because the alternative is a dependency tree for four
 * HTTP verbs and this project already carries its own crypto for the same
 * reason elsewhere.
 */

export interface ObjectStoreConfig {
  /** `https://s3.eu-west-1.amazonaws.com`, or a compatible endpoint. */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /**
   * Path style addressing, which every S3-compatible server supports and
   * which avoids needing a wildcard certificate per bucket. Virtual-hosted
   * style is the default on AWS itself.
   */
  pathStyle?: boolean;
  /** Prefix every key sits under, so one bucket can hold more than this. */
  prefix?: string;
}

const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');

/** A canonical, percent-encoded path segment. S3 signs what it sees. */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * Signature Version 4.
 *
 * Written out because it is four steps and the alternative is a dependency for
 * them. Each step is named after the one in the specification so a reader can
 * check it against the document rather than against an intention.
 */
function sign(input: {
  config: ObjectStoreConfig;
  method: string;
  canonicalUri: string;
  payloadSha256: string;
  now: Date;
}): Record<string, string> {
  const { config, method, canonicalUri, payloadSha256, now } = input;
  const amzDate = `${now.toISOString().replace(/[:-]|\.\d{3}/g, '')}`;
  const dateStamp = amzDate.slice(0, 8);
  const host = new URL(config.endpoint).host;

  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadSha256}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [method, canonicalUri, '', canonicalHeaders, signedHeaders, payloadSha256].join('\n');

  const scope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');

  const hmac = (key: Buffer | string, data: string): Buffer => createHmac('sha256', key).update(data).digest();
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${config.secretAccessKey}`, dateStamp), config.region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  return {
    host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadSha256,
    Authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/**
 * The prefix this store owns, with a trailing slash.
 *
 * Normalised in one place so the ownership check and the key builder cannot
 * disagree about whether it ends in one, which is the sort of difference that
 * makes a traversal check pass.
 */
function prefixOf(config: ObjectStoreConfig): string {
  const raw = (config.prefix ?? 'runtime-backups').replace(/^\/+|\/+$/g, '');
  return raw ? `${raw}/` : '';
}

/** Whether a key belongs to this store, rather than merely being a string. */
export function keyIsOwned(config: ObjectStoreConfig, key: string): boolean {
  if (!key || key.includes('\0') || key.startsWith('/')) return false;
  // A key becomes a path on the far side, and a path has dots.
  if (key.split('/').some((part) => part === '..' || part === '.')) return false;
  return key.startsWith(prefixOf(config));
}

/**
 * An object store, as a `BackupStore`.
 *
 * `location` is the full key rather than a URL, so a stored row names an
 * object within a bucket this installation configured rather than an address
 * that could be anywhere. Changing the bucket then changes where backups are
 * read from, which is the correct behaviour and the reason a row must not
 * carry a host.
 */
export function objectBackupStore(config: ObjectStoreConfig, fetchImpl: typeof fetch = fetch): BackupStore {
  const base = config.endpoint.replace(/\/+$/, '');
  const prefix = prefixOf(config);

  const url = (key: string): { href: string; canonicalUri: string } => {
    const encodedKey = key.split('/').map(encodeSegment).join('/');
    if (config.pathStyle ?? true) {
      return {
        href: `${base}/${encodeSegment(config.bucket)}/${encodedKey}`,
        canonicalUri: `/${encodeSegment(config.bucket)}/${encodedKey}`,
      };
    }
    const host = new URL(base);
    return { href: `${host.protocol}//${config.bucket}.${host.host}/${encodedKey}`, canonicalUri: `/${encodedKey}` };
  };

  /**
   * A key for a new object, which may be given without the prefix.
   *
   * `backupKeyFor` produces `rt-1/gen-2/when.bin` and knows nothing about
   * where this store keeps things, so writing accepts a bare key and puts it
   * under the prefix.
   */
  const keyForWrite = (key: string): string => {
    const full = key.startsWith(prefix) ? key : `${prefix}${key}`;
    if (!keyIsOwned(config, full)) {
      throw new Error(`${key} is not a key this store can write. A key becomes a path on the far side, and a path has dots.`);
    }
    return full;
  };

  /**
   * A key for an existing object, which must already be one this store owns.
   *
   * Deliberately **not** prefixed. Prefixing whatever it was handed made the
   * ownership check unable to refuse anything: `another-tenant/secrets.bin`
   * became `runtime-backups/another-tenant/secrets.bin`, which is owned, so
   * the read went ahead and returned a 404 rather than a refusal. A row
   * somebody edited is not permission to fetch an arbitrary object, and that
   * is only true if the read path insists rather than helps.
   */
  const keyForRead = (location: string): string => {
    if (!keyIsOwned(config, location)) {
      throw new Error(
        `${location} is not a key this store owns. A location is recorded by this store, so one that does not match its prefix came from somewhere else.`,
      );
    }
    return location;
  };

  return {
    id: `object:${base}/${config.bucket}/${prefix}`,

    async put(key, bytes) {
      const full = keyForWrite(key);
      const { href, canonicalUri } = url(full);
      const payloadSha256 = createHash('sha256').update(bytes).digest('hex');
      const headers = sign({ config, method: 'PUT', canonicalUri, payloadSha256, now: new Date() });
      /*
        Copied into a Buffer for the body. A `Uint8Array` over an
        `ArrayBufferLike` is not a `BodyInit` as far as the types are
        concerned, because that could be a `SharedArrayBuffer`, and casting
        past it would be asserting something about memory this function does
        not own.
      */
      const response = await fetchImpl(href, { method: 'PUT', headers, body: Buffer.from(bytes) });
      if (!response.ok) {
        throw new Error(`The object store refused the write with ${response.status}: ${(await response.text()).slice(0, 200)}`);
      }
      // The key, not the URL. A row carrying a host is a row that still points
      // somewhere after the bucket has moved.
      return { location: full };
    },

    async get(location) {
      const full = keyForRead(location);
      const { href, canonicalUri } = url(full);
      const headers = sign({ config, method: 'GET', canonicalUri, payloadSha256: EMPTY_SHA256, now: new Date() });
      const response = await fetchImpl(href, { method: 'GET', headers });
      // Not there is an answer. Anything else is a failure worth seeing, and
      // reporting it as absent is how a broken store reads as an empty one.
      if (response.status === 404) return null;
      if (!response.ok) {
        throw new Error(`The object store refused the read with ${response.status}: ${(await response.text()).slice(0, 200)}`);
      }
      return new Uint8Array(await response.arrayBuffer());
    },

    async remove(location) {
      const full = keyForRead(location);
      const { href, canonicalUri } = url(full);
      const headers = sign({ config, method: 'DELETE', canonicalUri, payloadSha256: EMPTY_SHA256, now: new Date() });
      const response = await fetchImpl(href, { method: 'DELETE', headers });
      if (!response.ok && response.status !== 404) {
        throw new Error(`The object store refused the delete with ${response.status}.`);
      }
    },
  };
}

/**
 * Registers it, and says what it is.
 *
 * Off-host, unlike the filesystem store, which is the whole point. Still not a
 * claim about confidentiality: the bucket holds ciphertext the runtime sealed,
 * and whoever holds the bucket holds ciphertext.
 */
export function useObjectBackupStore(config: ObjectStoreConfig, fetchImpl: typeof fetch = fetch): { id: string; offHost: boolean; detail: string } {
  const store = objectBackupStore(config, fetchImpl);
  registerBackupStore(store);
  return {
    id: store.id,
    offHost: true,
    detail:
      'Backups leave the compute host. The ciphertext was sealed by the runtime with its own key before it left the confidential boundary, so possession of this bucket is possession of ciphertext and nothing more. Nothing here encrypts, because a store that encrypted on the way out could decrypt on the way back.',
  };
}

export const OBJECT_STORE_CAVEATS: readonly string[] = [
  'Nothing here encrypts. The runtime sealed the ciphertext with its own key before it left, which is the only reason an off-host backup is safe to have.',
  'A location is a key within a configured bucket, never a URL. A row carrying a host still points somewhere after the bucket has moved, and a row somebody edited would point wherever they liked.',
  'A read insists on a key this store owns rather than prefixing whatever it was handed. Prefixing made the check unable to refuse anything: another tenant key became an owned one, and the read returned a 404 instead of a refusal.',
  'A 404 is an answer and anything else is a failure. Reporting an error as absent is how a broken store reads as an empty one.',
  'Possession of the bucket is not authority to read it, and that sentence is only true while the sealing happens inside the runtime.',
];
