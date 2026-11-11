import { describe, expect, it } from 'vitest';
import { MAX_IMAGES_PER_POST, MAX_IMAGE_EDGE, MEDIA_LIMITS, mediaSetProblem, sniffMedia, validateMedia } from '@xbam/shared';
import { mediaSeenOnPost } from '@xbam/channels';
import { postHasReadBack } from '@xbam/runtime';
import { fixtureBytes, pngClaiming } from '../support/imageFixtures';
import { SVG_BYTES, movBytes, movieBytes, mp4Bytes } from '../support/mediaFixtures';

/**
 * What a file attached to a post is, decided from its bytes.
 *
 * The same rule as the avatar: a content-type is a claim and a filename is a
 * worse one, and what is stored here is uploaded under an agent's name to a
 * public account. Videos are identified by their container, and a movie that
 * is cut short is refused here rather than after a browser has spent minutes
 * trying to upload it.
 */
describe('identifying a file from its bytes', () => {
  it('recognises the images the avatar path already does, with their kind', () => {
    expect(sniffMedia(fixtureBytes('png'))).toMatchObject({ kind: 'IMAGE', mime: 'image/png', extension: 'png', width: 96, height: 72 });
    expect(sniffMedia(fixtureBytes('jpeg'))).toMatchObject({ kind: 'IMAGE', mime: 'image/jpeg', extension: 'jpg' });
    expect(sniffMedia(fixtureBytes('webp'))).toMatchObject({ kind: 'IMAGE', mime: 'image/webp' });
    // A GIF is its own kind: X counts it as one attachment of its own, not as a picture.
    expect(sniffMedia(fixtureBytes('gif'))).toMatchObject({ kind: 'GIF', mime: 'image/gif' });
  });

  it('recognises MP4 and QuickTime by container, and gives them no dimensions', () => {
    expect(sniffMedia(mp4Bytes())).toMatchObject({ kind: 'VIDEO', mime: 'video/mp4', extension: 'mp4', width: null, height: null });
    expect(sniffMedia(movBytes())).toMatchObject({ kind: 'VIDEO', mime: 'video/quicktime', extension: 'mov' });
  });

  it('refuses SVG, because it is a document that can carry script', () => {
    expect(sniffMedia(SVG_BYTES)).toBeNull();
    expect(() => validateMedia(SVG_BYTES)).toThrow(/SVG is not accepted/);
  });

  it('refuses a file that only claims to be something', () => {
    // Text renamed to .mp4, a PDF, a script, and an ISO file whose brand is not a movie.
    expect(sniffMedia(Buffer.from('this is not a video at all, whatever the name says'))).toBeNull();
    expect(sniffMedia(Buffer.from('%PDF-1.7\n%âãÏÓ\n1 0 obj'))).toBeNull();
    expect(sniffMedia(Buffer.from('#!/bin/sh\nrm -rf /\n'))).toBeNull();
    expect(sniffMedia(movieBytes({ brand: 'heic' }))).toBeNull();
    expect(() => validateMedia(Buffer.alloc(0))).toThrow(/empty/);
  });

  it('refuses a movie that is not whole', () => {
    // No index: X would report an upload that failed after minutes of trying.
    expect(sniffMedia(movieBytes({ moov: false }))).toBeNull();
    // No samples.
    expect(sniffMedia(movieBytes({ mdat: false }))).toBeNull();
    // A download that stopped early: the last box claims more than the file holds.
    expect(sniffMedia(movieBytes({ cutShort: 40 }))).toBeNull();
  });
});

describe('the size caps are per kind', () => {
  it('lets an image be as big as an image may be and no bigger', () => {
    const image = Buffer.concat([fixtureBytes('png'), Buffer.alloc(MEDIA_LIMITS.IMAGE)]);
    // Trailing bytes do not change what the header says it is, only its size.
    expect(() => validateMedia(image)).toThrow(/limit is 5MB/);
    expect(validateMedia(fixtureBytes('png')).kind).toBe('IMAGE');
  });

  it('gives a GIF more room than an image and a video more than a GIF', () => {
    expect(MEDIA_LIMITS.IMAGE).toBeLessThan(MEDIA_LIMITS.GIF);
    expect(MEDIA_LIMITS.GIF).toBeLessThan(MEDIA_LIMITS.VIDEO);

    const gifJustOverImage = Buffer.concat([fixtureBytes('gif'), Buffer.alloc(MEDIA_LIMITS.IMAGE + 1)]);
    expect(validateMedia(gifJustOverImage).kind).toBe('GIF');
    const gifOver = Buffer.concat([fixtureBytes('gif'), Buffer.alloc(MEDIA_LIMITS.GIF + 1)]);
    expect(() => validateMedia(gifOver)).toThrow(/GIF is .*limit is 15MB/);

    const videoOverGif = mp4Bytes(MEDIA_LIMITS.GIF + 1024);
    expect(validateMedia(videoOverGif).kind).toBe('VIDEO');
  });

  it('refuses a video over its own cap with the video cap in the message', () => {
    expect(() => validateMedia(mp4Bytes(MEDIA_LIMITS.VIDEO + 1))).toThrow(/video is .*limit is 50MB/);
  });

  it('reads an image dimension cap from the header, not the file', () => {
    expect(() => validateMedia(pngClaiming(MAX_IMAGE_EDGE + 1, 100))).toThrow(/pixels on a side/);
    expect(validateMedia(pngClaiming(MAX_IMAGE_EDGE, 100)).kind).toBe('IMAGE');
  });
});

describe('what may share a post', () => {
  it('allows up to four images, one GIF, or one video, and nothing mixed', () => {
    expect(mediaSetProblem([])).toBeNull();
    expect(mediaSetProblem(['IMAGE'])).toBeNull();
    expect(mediaSetProblem(Array(MAX_IMAGES_PER_POST).fill('IMAGE'))).toBeNull();
    expect(mediaSetProblem(Array(MAX_IMAGES_PER_POST + 1).fill('IMAGE'))).toMatch(/at most 4 images/);
    expect(mediaSetProblem(['GIF'])).toBeNull();
    expect(mediaSetProblem(['VIDEO'])).toBeNull();
    expect(mediaSetProblem(['GIF', 'GIF'])).toMatch(/cannot be mixed/);
    expect(mediaSetProblem(['VIDEO', 'IMAGE'])).toMatch(/cannot be mixed/);
  });
});

describe('reading the post back with its media', () => {
  it('counts pictures, wants a player for a video, and lets a GIF be drawn either way', () => {
    expect(mediaSeenOnPost([], { photos: 0, videos: 0 })).toBe(true);
    expect(mediaSeenOnPost([{ kind: 'IMAGE' }, { kind: 'IMAGE' }, { kind: 'IMAGE' }], { photos: 2, videos: 0 })).toBe(false);
    expect(mediaSeenOnPost([{ kind: 'IMAGE' }, { kind: 'IMAGE' }], { photos: 2, videos: 0 })).toBe(true);
    expect(mediaSeenOnPost([{ kind: 'VIDEO' }], { photos: 1, videos: 0 })).toBe(false);
    expect(mediaSeenOnPost([{ kind: 'VIDEO' }], { photos: 0, videos: 1 })).toBe(true);
    expect(mediaSeenOnPost([{ kind: 'GIF' }], { photos: 1, videos: 0 })).toBe(true);
    expect(mediaSeenOnPost([{ kind: 'GIF' }], { photos: 0, videos: 0 })).toBe(false);
  });

  it('is read back only when the adapter says the media was seen, whatever else it found', () => {
    const found = {
      remoteActionId: '12345',
      remoteActionUrl: 'https://x.com/someone/status/12345',
      verification: { verified: true, detail: '', targetRef: null, targetUrl: null, targetAuthorHandle: null, evidence: {} },
    };
    // A text-only post is unchanged by any of this.
    expect(postHasReadBack(found)).toBe(true);
    // One that went out with a file needs the adapter to have looked.
    expect(postHasReadBack(found, { media: 1 })).toBe(false);
    expect(postHasReadBack({ ...found, verification: { ...found.verification, evidence: { mediaConfirmed: false } } }, { media: 1 })).toBe(false);
    expect(postHasReadBack({ ...found, verification: { ...found.verification, evidence: { mediaConfirmed: true } } }, { media: 1 })).toBe(true);
    // Media seen does not rescue a post that was never found.
    expect(
      postHasReadBack(
        { ...found, remoteActionId: null, remoteActionUrl: null, verification: { ...found.verification, evidence: { mediaConfirmed: true } } },
        { media: 1 },
      ),
    ).toBe(false);
  });
});
