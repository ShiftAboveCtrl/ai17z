import { describe, expect, it } from 'vitest';
import { sniffImage } from '@xbam/shared';
import { fixtureBytes, pngClaiming } from '../support/imageFixtures';

/**
 * What a file is, decided from the file.
 *
 * The `content-type` a client sends is a claim and the filename is worse, and
 * whatever is stored here gets served back later -- so identifying an upload by
 * anything other than its own bytes is how an "image" becomes a script running
 * on the origin that holds the session token.
 */
describe('reading an image out of its own bytes', () => {
  it('reads a PNG', () => {
    expect(sniffImage(fixtureBytes('png'))).toEqual({
      mime: 'image/png',
      extension: 'png',
      width: 96,
      height: 72,
    });
  });

  it('reads a JPEG, which keeps its size behind a chain of segments', () => {
    expect(sniffImage(fixtureBytes('jpeg'))).toEqual({
      mime: 'image/jpeg',
      extension: 'jpg',
      width: 96,
      height: 72,
    });
  });

  it('reads a GIF', () => {
    expect(sniffImage(fixtureBytes('gif'))).toEqual({
      mime: 'image/gif',
      extension: 'gif',
      width: 96,
      height: 72,
    });
  });

  it('reads a lossy WebP', () => {
    expect(sniffImage(fixtureBytes('webp'))).toMatchObject({ mime: 'image/webp', width: 96, height: 72 });
  });

  it('reads a lossless WebP, which packs its size differently', () => {
    // Three payloads in one container, each storing dimensions somewhere else.
    // Getting VP8 right says nothing about VP8L.
    expect(sniffImage(fixtureBytes('webp_lossless'))).toMatchObject({
      mime: 'image/webp',
      width: 96,
      height: 72,
    });
  });
});

describe('what it refuses', () => {
  const cases: [string, Buffer][] = [
    ['nothing at all', Buffer.alloc(0)],
    ['a few bytes', Buffer.from([0x00, 0x01, 0x02])],
    ['plain text', Buffer.from('this is not an image, it is a sentence')],
    // The one that matters. An SVG is a document that can carry script, and
    // there is no version of "profile picture" that needs one.
    ['an SVG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')],
    ['HTML', Buffer.from('<!doctype html><html><body><script>alert(1)</script>')],
    ['a PDF', Buffer.from('%PDF-1.7\n1 0 obj\n')],
    ['a Windows executable', Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00])],
    ['a zip, which is what a lot of things are', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00])],
  ];

  for (const [what, bytes] of cases) {
    it(`refuses ${what}`, () => {
      expect(sniffImage(bytes)).toBeNull();
    });
  }

  it('is not fooled by a PNG signature on something that is not a PNG', () => {
    const liar = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('<script>alert(1)</script>'),
    ]);
    // The signature matches; IHDR does not follow it.
    expect(sniffImage(liar)).toBeNull();
  });

  it('refuses a header that claims no size', () => {
    expect(sniffImage(pngClaiming(0, 0))).toBeNull();
    expect(sniffImage(pngClaiming(96, 0))).toBeNull();
  });

  it('does not read past the end of a truncated file', () => {
    const png = fixtureBytes('png');
    for (const cut of [4, 8, 12, 16, 20, 23]) {
      // Whatever it decides, it must not throw. A truncated upload is a normal
      // thing to receive and a crash in a header parser is not a normal thing
      // to do about it.
      expect(() => sniffImage(png.subarray(0, cut))).not.toThrow();
    }
    const jpeg = fixtureBytes('jpeg');
    for (let cut = 2; cut < 40; cut += 3) {
      expect(() => sniffImage(jpeg.subarray(0, cut))).not.toThrow();
    }
  });
});

/**
 * A file's size on disk says nothing about how big the picture claims to be.
 * That gap is the decompression bomb, and it is why the dimension cap reads
 * the header.
 */
describe('a header that claims more than the file holds', () => {
  it('still reports what the header says, so a caller can refuse it', () => {
    const bomb = pngClaiming(60000, 60000);
    expect(bomb.byteLength).toBeLessThan(1000);
    expect(sniffImage(bomb)).toMatchObject({ width: 60000, height: 60000 });
  });
});
