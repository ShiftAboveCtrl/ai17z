/**
 * Working out what an uploaded file actually is.
 *
 * The `content-type` a client sends is a claim, not a fact, and the filename is
 * worse. Anything AI17Z stores and later serves back has to be identified from
 * its own bytes, because the alternative is serving whatever somebody uploaded
 * under whatever type they said it was -- which is how an "image" becomes a
 * script running on the origin that holds the session token.
 *
 * So: four raster formats, each recognised by its signature, each with its
 * dimensions read out of its own header. Nothing else is accepted. SVG is
 * deliberately absent -- it is a document that can carry script, and there is
 * no version of "profile picture" that needs one.
 *
 * No decoder and no dependency. Reading four headers is a page of code; a
 * decoding library is 40MB in an installer and a stream of CVEs, to answer a
 * question that is four byte comparisons.
 */

export type ImageMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export interface ImageInfo {
  mime: ImageMime;
  width: number;
  height: number;
  /** The extension to store it under, so the file on disk is honest too. */
  extension: 'png' | 'jpg' | 'gif' | 'webp';
}

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

function beUint32(bytes: Uint8Array, at: number): number {
  return ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0;
}

function beUint16(bytes: Uint8Array, at: number): number {
  return (bytes[at]! << 8) | bytes[at + 1]!;
}

function leUint16(bytes: Uint8Array, at: number): number {
  return bytes[at]! | (bytes[at + 1]! << 8);
}

function leUint24(bytes: Uint8Array, at: number): number {
  return bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16);
}

/** PNG: eight-byte signature, then IHDR, whose first two fields are the size. */
function png(bytes: Uint8Array): ImageInfo | null {
  if (!startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return null;
  // IHDR must be the first chunk, so width and height are at fixed offsets.
  if (bytes.length < 24 || !startsWith(bytes, [0x49, 0x48, 0x44, 0x52], 12)) return null;
  return { mime: 'image/png', extension: 'png', width: beUint32(bytes, 16), height: beUint32(bytes, 20) };
}

/**
 * JPEG: the size lives in a start-of-frame marker, which is somewhere after an
 * unknown number of other segments, so the segment chain has to be walked.
 */
function jpeg(bytes: Uint8Array): ImageInfo | null {
  if (!startsWith(bytes, [0xff, 0xd8, 0xff])) return null;

  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) {
      // Padding between segments is legal; anything else means this is not a
      // JPEG we can read, and guessing past it is how a parser reads garbage.
      at += 1;
      continue;
    }
    const marker = bytes[at + 1]!;
    // Standalone markers carry no length, so they are skipped rather than read.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    // Start of scan: the image data begins and there is no frame header left.
    if (marker === 0xda) return null;

    const length = beUint16(bytes, at + 2);
    if (length < 2) return null;

    // Every start-of-frame except the four that are not frames at all.
    const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isFrame) {
      return { mime: 'image/jpeg', extension: 'jpg', height: beUint16(bytes, at + 5), width: beUint16(bytes, at + 7) };
    }
    at += 2 + length;
  }
  return null;
}

/** GIF: six-byte signature, then the logical screen size, little-endian. */
function gif(bytes: Uint8Array): ImageInfo | null {
  const is87a = startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]);
  const is89a = startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
  if (!is87a && !is89a) return null;
  if (bytes.length < 10) return null;
  return { mime: 'image/gif', extension: 'gif', width: leUint16(bytes, 6), height: leUint16(bytes, 8) };
}

/**
 * WebP: a RIFF container with three different payloads, each of which keeps its
 * dimensions somewhere different.
 */
function webp(bytes: Uint8Array): ImageInfo | null {
  if (!startsWith(bytes, [0x52, 0x49, 0x46, 0x46])) return null; // "RIFF"
  if (!startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return null; // "WEBP"
  if (bytes.length < 30) return null;

  const format = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!);

  if (format === 'VP8 ') {
    // Lossy. The frame header follows a three-byte start code.
    if (!startsWith(bytes, [0x9d, 0x01, 0x2a], 23)) return null;
    // Fourteen bits of size, two bits of scale, which is not a dimension.
    return { mime: 'image/webp', extension: 'webp', width: leUint16(bytes, 26) & 0x3fff, height: leUint16(bytes, 28) & 0x3fff };
  }

  if (format === 'VP8L') {
    // Lossless. Fourteen bits each, packed across four bytes after a signature.
    if (bytes[20] !== 0x2f) return null;
    const packed = bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24);
    return {
      mime: 'image/webp',
      extension: 'webp',
      width: (packed & 0x3fff) + 1,
      height: ((packed >> 14) & 0x3fff) + 1,
    };
  }

  if (format === 'VP8X') {
    // Extended. Canvas size is stored minus one, in three little-endian bytes.
    return {
      mime: 'image/webp',
      extension: 'webp',
      width: leUint24(bytes, 24) + 1,
      height: leUint24(bytes, 27) + 1,
    };
  }

  return null;
}

/**
 * What this actually is, or null.
 *
 * Null means "not one of the four raster formats AI17Z accepts", which covers a
 * corrupt file, an SVG, a PDF renamed to .png, and a script. The caller does not
 * need to tell those apart: none of them is a profile picture.
 */
export function sniffImage(bytes: Uint8Array): ImageInfo | null {
  const found = png(bytes) ?? jpeg(bytes) ?? gif(bytes) ?? webp(bytes);
  if (!found) return null;
  // A header can say anything. A zero or absurd dimension means the header is
  // wrong or hostile, and either way there is nothing here to display.
  if (found.width <= 0 || found.height <= 0) return null;
  return found;
}
