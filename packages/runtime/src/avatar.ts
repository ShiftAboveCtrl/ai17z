/**
 * The agent's face.
 *
 * Until now an avatar was a URL somebody typed at creation and could never
 * change, which fails twice: an agent's likeness is the thing most likely to be
 * wrong on the first attempt, and a URL is a promise that somebody else's
 * server will keep serving an image. It breaks, or it changes to something
 * else, and either way the agent's face is not the owner's to control.
 *
 * So an avatar is now a file AI17Z holds. A URL still works -- an agent already
 * configured with one does not change -- but a picture chosen here belongs to
 * this installation.
 *
 * ## What this is not
 *
 * **It is not the X profile picture, and it never touches it.** Nothing here
 * calls a channel adapter, and `tests/integration/agentAvatar.test.ts` fails if
 * anything is added that does. Silently reaching into somebody's real, public
 * social account because they changed a picture in a local admin screen is the
 * kind of surprise that costs the whole product its trust -- and it is not
 * undoable by the person it surprises.
 *
 * The two are different things that happen to be pictures. One is how an agent
 * appears in AI17Z; the other is a public identity that a person, not an
 * automation, should decide to change.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { BadRequestError, createLogger, errorMessage, sniffImage } from '@xbam/shared';
import type { ImageInfo } from '@xbam/shared';
import { agents as agentsRepo, ops as opsRepo } from '@xbam/database';
import { storageDir } from './channelContext';

const log = createLogger('avatar');

/**
 * Five megabytes.
 *
 * Far more than a profile picture needs and small enough that a mistake -- a
 * camera original, a screenshot of a screenshot -- fails immediately instead of
 * filling a disk. The check happens before anything is written.
 */
export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

/** Below this it will look like a thumbnail stretched to fill a page, because it is one. */
export const MIN_AVATAR_EDGE = 64;

/**
 * Above this is a photograph, not an avatar. It is displayed at 224 pixels.
 * The cap is on the *header's* claim, which is also what stops a decompression
 * bomb: a 40KB PNG can declare 60000 x 60000.
 */
export const MAX_AVATAR_EDGE = 4096;

export interface AvatarResult {
  artifactId: string;
  url: string;
  width: number;
  height: number;
  bytes: number;
  mime: string;
}

/** Where an agent's portraits live, under the storage root and nowhere else. */
function portraitDir(agentId: string): string {
  const root = resolve(storageDir());
  const dir = resolve(root, 'portraits', agentId);
  // The agent id comes from the database rather than from a request, but the
  // check is cheap and this is the function that turns an id into a path.
  if (!dir.startsWith(root + sep)) throw new BadRequestError('That agent id is not usable as a path.');
  return dir;
}

function validate(bytes: Uint8Array): ImageInfo {
  if (bytes.byteLength === 0) throw new BadRequestError('That file is empty.');
  if (bytes.byteLength > MAX_AVATAR_BYTES) {
    throw new BadRequestError(
      `That image is ${(bytes.byteLength / 1024 / 1024).toFixed(1)}MB. The limit is ${MAX_AVATAR_BYTES / 1024 / 1024}MB -- a profile picture needs far less.`,
    );
  }

  // From the bytes, never from the content-type header or the filename. Both
  // are claims, and what is stored here is served back later.
  const info = sniffImage(bytes);
  if (!info) {
    throw new BadRequestError(
      'That is not a PNG, JPEG, GIF or WebP. SVG is not accepted, because it is a document that can carry script.',
    );
  }

  const smallest = Math.min(info.width, info.height);
  if (smallest < MIN_AVATAR_EDGE) {
    throw new BadRequestError(
      `That image is ${info.width}x${info.height}. It needs to be at least ${MIN_AVATAR_EDGE} pixels on its shortest side, or it will be blurry everywhere it is shown.`,
    );
  }
  const largest = Math.max(info.width, info.height);
  if (largest > MAX_AVATAR_EDGE) {
    throw new BadRequestError(
      `That image is ${info.width}x${info.height}. The limit is ${MAX_AVATAR_EDGE} pixels; it is displayed at 224.`,
    );
  }

  return info;
}

/**
 * Stores a new avatar and points the agent at it.
 *
 * The previous one is removed afterwards rather than first. If writing the new
 * file fails, the agent keeps the face it had; the alternative loses both.
 */
export async function setAgentAvatar(agentId: string, bytes: Uint8Array): Promise<AvatarResult> {
  const agent = await agentsRepo.getAgent(agentId);
  if (!agent) throw new BadRequestError('That agent no longer exists.');

  const info = validate(bytes);

  const dir = portraitDir(agentId);
  await mkdir(dir, { recursive: true });
  // A fresh name every time. Overwriting one path would leave every cached copy
  // of the old picture claiming to be the new one.
  const filename = `${randomUUID()}.${info.extension}`;
  await writeFile(join(dir, filename), bytes);

  const artifact = await opsRepo.createArtifact({
    kind: 'PORTRAIT',
    agentId,
    mimeType: info.mime,
    relPath: join('portraits', agentId, filename),
    bytes: bytes.byteLength,
    meta: { width: info.width, height: info.height },
  });

  const previous = currentArtifactId(agent.avatarUrl);
  await agentsRepo.updateAgent(agentId, { avatarUrl: `/api/artifacts/${artifact.id}` });
  if (previous) await forget(previous);

  return {
    artifactId: artifact.id,
    url: `/api/artifacts/${artifact.id}`,
    width: info.width,
    height: info.height,
    bytes: bytes.byteLength,
    mime: info.mime,
  };
}

/**
 * Removes the avatar, leaving the generated mark in its place.
 *
 * An agent with no picture is a supported state, not a broken one: the glyph
 * derived from its id is a perfectly good face, and forcing somebody to pick a
 * replacement in order to remove one is how a bad picture stays.
 */
export async function clearAgentAvatar(agentId: string): Promise<void> {
  const agent = await agentsRepo.getAgent(agentId);
  if (!agent) throw new BadRequestError('That agent no longer exists.');

  const previous = currentArtifactId(agent.avatarUrl);
  await agentsRepo.updateAgent(agentId, { avatarUrl: null });
  if (previous) await forget(previous);
}

/**
 * The artifact an avatar URL points at, if it points at one at all.
 *
 * An agent configured with an external URL has no artifact behind it, and
 * removing its picture must not try to delete somebody else's server.
 */
export function currentArtifactId(avatarUrl: string | null | undefined): string | null {
  if (!avatarUrl) return null;
  const match = /^\/api\/artifacts\/([0-9a-f-]{36})$/i.exec(avatarUrl.trim());
  return match?.[1] ?? null;
}

/** Drops the row, then the file it pointed at. */
async function forget(artifactId: string): Promise<void> {
  const row = await opsRepo.deleteArtifact(artifactId).catch(() => null);
  if (!row) return;
  const absolute = resolve(storageDir(), row.relPath);
  // Deleting a replaced portrait is housekeeping. Failing at it must not fail
  // the change the owner actually asked for, so it is logged and left.
  await rm(absolute, { force: true }).catch((error: unknown) => {
    log.warn('an old portrait could not be deleted', { artifactId, message: errorMessage(error) });
  });
}
