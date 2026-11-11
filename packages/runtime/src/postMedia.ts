/**
 * Files that go out with a post.
 *
 * A file is held as an artifact of kind POST_MEDIA, written once after its bytes
 * have been identified, and referred to everywhere else by id. What travels with
 * a development update, an event and a job is a small reference
 * (`{ artifactId, kind, mime, bytes, sha256 }`), never a path: the path is
 * resolved here, at the last moment, from an artifact this installation owns.
 *
 * ## Checked twice
 *
 * Once when it is stored, from its bytes. And again when it is about to be sent,
 * from its bytes, against the hash recorded at the first check. A file that was
 * swapped on disk between the owner approving it and the executor sending it is
 * a different picture on a public account; refusing is the only safe answer.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { BadRequestError, PipelineError, createLogger, errorMessage, validateMedia, mediaSetProblem } from '@xbam/shared';
import type { PostMediaKind } from '@xbam/shared';
import { devUpdates as devUpdatesRepo, ops as opsRepo } from '@xbam/database';
import type { MediaAttachment } from '@xbam/channels';
import { storageDir } from './channelContext';

const log = createLogger('post-media');

export const PostMediaRef = z.object({
  artifactId: z.uuid(),
  kind: z.enum(['IMAGE', 'GIF', 'VIDEO']),
  mime: z.string().min(1).max(60),
  bytes: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type PostMediaRef = z.infer<typeof PostMediaRef>;

function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The errno code of a filesystem failure (`ENOENT`), which says what happened without saying where. */
function errnoOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'UNKNOWN';
}

function mediaDir(agentId: string): string {
  const root = resolve(storageDir());
  const dir = resolve(root, 'post-media', agentId);
  if (!dir.startsWith(root + sep)) throw new BadRequestError('That agent id is not usable as a path.');
  return dir;
}

/**
 * Identifies, caps and stores one file, and returns the reference to it.
 *
 * `scope` is recorded on the artifact so a file nobody attached can be found and
 * removed again, and so one project cannot attach another project's upload.
 */
export async function storePostMedia(input: {
  agentId: string;
  jobId?: string;
  bytes: Uint8Array;
  scope: Record<string, unknown>;
}): Promise<PostMediaRef> {
  const info = validateMedia(input.bytes);
  const sha256 = sha256Of(input.bytes);

  const dir = mediaDir(input.agentId);
  // A fresh name every time, and the extension is the sniffed one.
  const filename = `${randomUUID()}.${info.extension}`;
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, filename), input.bytes);
  } catch (error) {
    // A filesystem error names the absolute path it failed on, and this one
    // reaches an API response. Keep the errno for the log and say the rest in
    // words.
    log.warn('post media could not be stored', { code: errnoOf(error) });
    throw PipelineError.retryable('post_media_store_failed', 'The file could not be saved on this machine. Try uploading it again.');
  }

  const artifact = await opsRepo.createArtifact({
    kind: 'POST_MEDIA',
    ...(input.jobId ? { jobId: input.jobId } : {}),
    agentId: input.agentId,
    mimeType: info.mime,
    relPath: join('post-media', input.agentId, filename),
    bytes: input.bytes.byteLength,
    meta: { ...input.scope, mediaKind: info.kind, sha256, width: info.width, height: info.height },
  }).catch(async (error: unknown) => {
    // A row that never existed must not leave bytes behind.
    await rm(join(dir, filename), { force: true }).catch(() => undefined);
    throw error;
  });

  return { artifactId: artifact.id, kind: info.kind, mime: info.mime, bytes: input.bytes.byteLength, sha256 };
}

/** The references an event carries, or none. Malformed entries are dropped, not guessed at. */
export function mediaRefsOf(payload: unknown): PostMediaRef[] {
  const raw = (payload as { media?: unknown } | null | undefined)?.media;
  if (!Array.isArray(raw)) return [];
  const refs: PostMediaRef[] = [];
  for (const entry of raw) {
    const parsed = PostMediaRef.safeParse(entry);
    if (parsed.success) refs.push(parsed.data);
  }
  return refs;
}

/** Whether these references can share a post. */
export function mediaRefsProblem(refs: readonly PostMediaRef[]): string | null {
  return mediaSetProblem(refs.map((r) => r.kind as PostMediaKind));
}

/**
 * Turns references into files an adapter can upload, proving each one is still
 * what was approved.
 *
 * Throws a permanent `post_media_unavailable`: a missing or changed file is not
 * something a retry fixes, and nothing has been sent at this point.
 */
export async function resolvePostMedia(refs: readonly PostMediaRef[]): Promise<MediaAttachment[]> {
  if (refs.length === 0) return [];
  const problem = mediaRefsProblem(refs);
  if (problem) throw PipelineError.permanent('post_media_invalid', problem);

  const root = resolve(storageDir());
  const out: MediaAttachment[] = [];
  for (const ref of refs) {
    const artifact = await opsRepo.getArtifact(ref.artifactId);
    if (!artifact || artifact.kind !== 'POST_MEDIA') {
      throw PipelineError.permanent('post_media_unavailable', 'A file attached to this post is no longer held, so nothing was sent.', {
        artifactId: ref.artifactId,
      });
    }
    const absolute = resolve(root, artifact.relPath);
    if (!absolute.startsWith(root + sep)) {
      throw PipelineError.permanent('post_media_unavailable', 'An attached file is outside the storage directory, so nothing was sent.');
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(absolute);
    } catch (error) {
      // Not the error's own message: it carries the absolute path, and this one
      // lands in the job's error, the trace and the owner's screen.
      log.warn('an attached file could not be read', { artifactId: ref.artifactId, code: errnoOf(error) });
      throw PipelineError.permanent('post_media_unavailable', 'An attached file could not be read from storage, so nothing was sent.', {
        artifactId: ref.artifactId,
      });
    }
    const hash = sha256Of(bytes);
    if (hash !== ref.sha256) {
      throw PipelineError.permanent('post_media_changed', 'An attached file is not the one that was approved, so nothing was sent.', {
        artifactId: ref.artifactId,
      });
    }
    let kind: PostMediaKind;
    try {
      kind = validateMedia(bytes).kind;
    } catch (error) {
      throw PipelineError.permanent('post_media_invalid', `An attached file is not acceptable: ${errorMessage(error)}`);
    }
    if (kind !== ref.kind) {
      throw PipelineError.permanent('post_media_changed', 'An attached file is not the kind that was approved, so nothing was sent.');
    }
    out.push({ kind, mime: artifact.mimeType, bytes: bytes.byteLength, sha256: hash, path: absolute });
  }
  return out;
}

/** What a trace or an owner screen may say about a file: never its path. */
export function describeMedia(refs: readonly Pick<PostMediaRef, 'kind' | 'mime' | 'bytes' | 'sha256'>[]) {
  return refs.map((r) => ({ kind: r.kind, mime: r.mime, bytes: r.bytes, sha256: r.sha256.slice(0, 12) }));
}

/** Drops the rows, then the files. Housekeeping: failing at it never fails the caller. */
export async function forgetPostMedia(artifactIds: readonly string[]): Promise<void> {
  for (const id of artifactIds) {
    const row = await opsRepo.deleteArtifact(id).catch(() => null);
    if (!row || row.kind !== 'POST_MEDIA') continue;
    await removeStoredFile(id, row.relPath);
  }
}

/**
 * Drops uploads that no update has taken, and only those.
 *
 * The ids come from an earlier read, and a submission can attach one between
 * that read and this call. So the "nobody has taken it" test is part of the
 * DELETE itself: Postgres re-checks it against the row's latest committed
 * version once a concurrent attach lets go of the lock, and a file an update
 * now names is left alone. Returns how many were removed.
 */
export async function forgetUnattachedPostMedia(artifactIds: readonly string[]): Promise<number> {
  if (artifactIds.length === 0) return 0;
  const removed = await devUpdatesRepo.deleteUnattachedMedia([...artifactIds]);
  for (const row of removed) await removeStoredFile(row.id, row.relPath);
  return removed.length;
}

async function removeStoredFile(artifactId: string, relPath: string): Promise<void> {
  const root = resolve(storageDir());
  await rm(resolve(root, relPath), { force: true }).catch((error: unknown) => {
    log.warn('post media could not be deleted', { artifactId, code: errnoOf(error) });
  });
}
