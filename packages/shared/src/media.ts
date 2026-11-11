/**
 * What a file attached to a post actually is.
 *
 * A post may carry a picture or a video. The file is held by AI17Z and handed to
 * a browser that will upload it to somebody else's service under the agent's
 * name, so what it is gets decided here, from its own bytes, before anything is
 * stored: a content-type is a claim and a filename is a worse one.
 *
 * Accepted: the four raster images `sniffImage` knows (PNG, JPEG, WebP, and GIF,
 * which X treats as its own kind), and MP4 or QuickTime video. Nothing else. SVG
 * is a document that can carry script, and a "video" whose container has no
 * movie in it is not one.
 *
 * No decoder and no dependency, for the reason `image.ts` gives.
 */
import { BadRequestError } from './errors';
import { sniffImage } from './image';

export type PostMediaKind = 'IMAGE' | 'GIF' | 'VIDEO';

export type PostMediaMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'video/mp4' | 'video/quicktime';

export interface PostMediaInfo {
  kind: PostMediaKind;
  mime: PostMediaMime;
  /** The extension to store it under, so the file on disk is honest too. */
  extension: 'png' | 'jpg' | 'gif' | 'webp' | 'mp4' | 'mov';
  /** Null for video: its dimensions are inside a codec this does not parse. */
  width: number | null;
  height: number | null;
}

const MB = 1024 * 1024;

/**
 * Per-kind size caps.
 *
 * Under what X itself accepts (5MB image, 15MB GIF, 512MB video) and sized so
 * that a mistake -- a screen recording of the whole afternoon -- fails when it
 * is attached, not after a browser has spent ten minutes uploading it.
 */
export const MEDIA_LIMITS: Readonly<Record<PostMediaKind, number>> = {
  IMAGE: 5 * MB,
  GIF: 15 * MB,
  VIDEO: 50 * MB,
};

/** The most a single post carries. X allows four images, or one GIF, or one video. */
export const MAX_IMAGES_PER_POST = 4;

/** Above this an image is a camera original, and X downsamples it anyway. */
export const MAX_IMAGE_EDGE = 8192;

function ascii(bytes: Uint8Array, at: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) out += String.fromCharCode(bytes[at + i] ?? 0);
  return out;
}

function beUint32(bytes: Uint8Array, at: number): number {
  return (((bytes[at] ?? 0) << 24) | ((bytes[at + 1] ?? 0) << 16) | ((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0)) >>> 0;
}

const MP4_BRANDS = new Set(['isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'mmp4', 'M4V ', 'dash', 'msnv']);
const MOV_BRANDS = new Set(['qt  ']);

/**
 * ISO base media file: a run of boxes, each `size, type`. A real movie has an
 * `ftyp` first and, somewhere after it, both `moov` (the index) and `mdat` (the
 * samples). A truncated download has one and not the other, and X reports that
 * as an upload that failed after minutes of trying; here it is refused at once.
 */
function video(bytes: Uint8Array): PostMediaInfo | null {
  if (bytes.length < 16 || ascii(bytes, 4, 4) !== 'ftyp') return null;
  const brand = ascii(bytes, 8, 4);
  const mime: PostMediaMime | null = MP4_BRANDS.has(brand) ? 'video/mp4' : MOV_BRANDS.has(brand) ? 'video/quicktime' : null;
  if (!mime) return null;

  let sawMoov = false;
  let sawMdat = false;
  let at = 0;
  let boxes = 0;
  while (at + 8 <= bytes.length && boxes < 256) {
    boxes += 1;
    let size = beUint32(bytes, at);
    const type = ascii(bytes, at + 4, 4);
    let header = 8;
    if (size === 1) {
      // 64-bit size. A real file's high word is zero below the size caps.
      if (at + 16 > bytes.length || beUint32(bytes, at + 8) !== 0) return null;
      size = beUint32(bytes, at + 12);
      header = 16;
    } else if (size === 0) {
      // Runs to the end of the file.
      size = bytes.length - at;
    }
    if (size < header) return null;
    if (type === 'moov') sawMoov = true;
    if (type === 'mdat') sawMdat = true;
    at += size;
  }
  // A box that claims to run past the end is a file cut short.
  if (at > bytes.length) return null;
  if (!sawMoov || !sawMdat) return null;

  return { kind: 'VIDEO', mime, extension: mime === 'video/mp4' ? 'mp4' : 'mov', width: null, height: null };
}

/**
 * What this actually is, or null.
 *
 * Null covers a corrupt file, an SVG, a PDF renamed to .png, a script, and a
 * movie that is not whole. The caller does not need to tell those apart: none of
 * them can be posted.
 */
export function sniffMedia(bytes: Uint8Array): PostMediaInfo | null {
  const image = sniffImage(bytes);
  if (image) {
    return {
      kind: image.mime === 'image/gif' ? 'GIF' : 'IMAGE',
      mime: image.mime,
      extension: image.extension,
      width: image.width,
      height: image.height,
    };
  }
  return video(bytes);
}

/**
 * Sniffs and enforces the caps, or says why not.
 *
 * The size is checked first, so a hundred megabytes of nothing is refused
 * without being read.
 */
export function validateMedia(bytes: Uint8Array): PostMediaInfo {
  if (bytes.byteLength === 0) throw new BadRequestError('That file is empty.');
  const info = sniffMedia(bytes);
  if (!info) {
    throw new BadRequestError(
      'That is not a PNG, JPEG, GIF, WebP, MP4 or QuickTime file (or a video that is cut short). SVG is not accepted, because it is a document that can carry script.',
    );
  }
  const limit = MEDIA_LIMITS[info.kind];
  if (bytes.byteLength > limit) {
    throw new BadRequestError(
      `That ${info.kind === 'VIDEO' ? 'video' : info.kind === 'GIF' ? 'GIF' : 'image'} is ${(bytes.byteLength / MB).toFixed(1)}MB. The limit is ${limit / MB}MB.`,
    );
  }
  if (info.width !== null && info.height !== null && Math.max(info.width, info.height) > MAX_IMAGE_EDGE) {
    throw new BadRequestError(`That image is ${info.width}x${info.height}. The limit is ${MAX_IMAGE_EDGE} pixels on a side.`);
  }
  return info;
}

/**
 * Whether these can go on one post together, or the reason they cannot.
 *
 * Mirrors what the composer accepts: up to four images, or exactly one GIF, or
 * exactly one video. Mixed kinds are refused rather than guessed at.
 */
export function mediaSetProblem(kinds: readonly PostMediaKind[]): string | null {
  if (kinds.length === 0) return null;
  const images = kinds.filter((k) => k === 'IMAGE').length;
  if (images === kinds.length) {
    return images > MAX_IMAGES_PER_POST ? `A post carries at most ${MAX_IMAGES_PER_POST} images; this has ${images}.` : null;
  }
  if (kinds.length > 1) {
    return 'A post carries up to four images, or one GIF, or one video. They cannot be mixed.';
  }
  return null;
}
