import { describe, expect, it } from 'vitest';
import { PipelineError } from '@xbam/shared';
import { SEL, attachMedia } from '@xbam/channels';
import type { MediaAttachment } from '@xbam/channels';

/**
 * Attaching a picture or a video to X's composer.
 *
 * Run against a fake page that records what was done to it, because the real
 * composer is on x.com and no test reaches that. What is pinned is the
 * discipline, not X's markup: files go in through the file input and never by
 * clicking the covered "add photos" control; the step waits for every tile, no
 * progress, and an enabled post button; focus returns to the editor; and every
 * way it can fail is retryable, because it runs before anything is submitted.
 */

interface Options {
  /** How many file inputs the composer has. */
  inputs?: number;
  setFilesError?: string;
  /** Tiles present once files were given. */
  tiles?: number;
  /** The progress count on each successive look; the last repeats. */
  progress?: number[];
  /** Whether the post button is enabled on each successive look; the last repeats. */
  enabled?: boolean[];
  toast?: string;
}

function fakeComposer(options: Options = {}) {
  const log: string[] = [];
  const state = { given: false, progressLooks: 0, enabledLooks: 0 };

  const locator = (selector: string) => {
    const self = {
      first: () => self,
      async count() {
        if (selector === SEL.mediaInput) return options.inputs ?? 1;
        if (selector === SEL.composerMediaItem) return state.given ? (options.tiles ?? 1) : 0;
        if (selector === SEL.composerMediaProgress) {
          const series = options.progress ?? [0];
          const at = Math.min(state.progressLooks, series.length - 1);
          state.progressLooks += 1;
          return series[at]!;
        }
        return 0;
      },
      async setInputFiles(paths: string[], opts: { timeout?: number }) {
        log.push(`setInputFiles:${paths.join('|')}`);
        expect(opts.timeout).toBeGreaterThan(0);
        if (options.setFilesError) throw new Error(options.setFilesError);
        state.given = true;
      },
      async isEnabled() {
        const series = options.enabled ?? [true];
        const at = Math.min(state.enabledLooks, series.length - 1);
        state.enabledLooks += 1;
        return series[at]!;
      },
      async innerText() {
        if (selector === SEL.toast && options.toast) return options.toast;
        throw new Error('no such element');
      },
      async click() {
        log.push('CLICK');
        throw new Error('the add-photos control is covered and must never be clicked');
      },
      async focus() {
        log.push('focus');
      },
    };
    return self;
  };

  const editor = locator('editor');
  const opened = { scope: { locator }, editor, inDialog: true } as never;
  const page = { locator } as never;
  return { page, opened, log, state };
}

const IMAGE: MediaAttachment = { kind: 'IMAGE', mime: 'image/png', bytes: 100, sha256: 'a'.repeat(64), path: '/store/post-media/a.png' };
const VIDEO: MediaAttachment = { kind: 'VIDEO', mime: 'video/mp4', bytes: 900, sha256: 'b'.repeat(64), path: '/store/post-media/b.mp4' };

async function failure(run: () => Promise<unknown>): Promise<PipelineError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(PipelineError);
    return error as PipelineError;
  }
  throw new Error('expected it to fail');
}

describe('attaching media to the composer', () => {
  it('gives the file to the input, never clicks, and returns focus to the editor', async () => {
    const { page, opened, log } = fakeComposer();
    await attachMedia(page, opened, [IMAGE], { pollMs: 1, timeoutMs: 200 });
    expect(log).toEqual([`setInputFiles:${IMAGE.path}`, 'focus']);
  });

  it('gives several images in one call, in order', async () => {
    const second = { ...IMAGE, path: '/store/post-media/c.png' };
    const { page, opened, log } = fakeComposer({ tiles: 2 });
    await attachMedia(page, opened, [IMAGE, second], { pollMs: 1, timeoutMs: 200 });
    expect(log[0]).toBe(`setInputFiles:${IMAGE.path}|${second.path}`);
  });

  it('does nothing at all for a post without media', async () => {
    const { page, opened, log } = fakeComposer({ inputs: 0 });
    await attachMedia(page, opened, [], { pollMs: 1, timeoutMs: 10 });
    expect(log).toEqual([]);
  });

  it('waits out an upload that is still in progress and a button that is still disabled', async () => {
    const { page, opened, log, state } = fakeComposer({ progress: [1, 1, 1, 0], enabled: [false, false, false, true] });
    await attachMedia(page, opened, [VIDEO], { pollMs: 1, timeoutMs: 2_000 });
    expect(state.progressLooks).toBeGreaterThanOrEqual(4);
    expect(log.at(-1)).toBe('focus');
  });

  it('does not call it done while a tile is missing', async () => {
    const { page, opened } = fakeComposer({ tiles: 0 });
    const error = await failure(() => attachMedia(page, opened, [IMAGE], { pollMs: 1, timeoutMs: 30 }));
    expect(error.errorClass).toBe('RETRYABLE');
    expect(error.reason).toBe('media_upload_timeout');
    expect(error.message).toMatch(/0 of 1 attachment/);
    expect(error.message).toMatch(/Nothing was posted/);
  });

  it('times out, retryably, on an upload that never finishes', async () => {
    const { page, opened } = fakeComposer({ progress: [1] });
    const error = await failure(() => attachMedia(page, opened, [VIDEO], { pollMs: 1, timeoutMs: 30 }));
    expect(error).toMatchObject({ errorClass: 'RETRYABLE', reason: 'media_upload_timeout' });
    expect(error.message).toMatch(/still uploading/);
  });

  it('times out when the post button never enables', async () => {
    const { page, opened } = fakeComposer({ enabled: [false] });
    const error = await failure(() => attachMedia(page, opened, [IMAGE], { pollMs: 1, timeoutMs: 30 }));
    expect(error).toMatchObject({ errorClass: 'RETRYABLE', reason: 'media_upload_timeout' });
  });

  it('fails at once, retryably, when X says the upload failed', async () => {
    const { page, opened } = fakeComposer({ toast: 'Some of your media failed to upload.' });
    const started = Date.now();
    const error = await failure(() => attachMedia(page, opened, [IMAGE], { pollMs: 1, timeoutMs: 10_000 }));
    expect(error).toMatchObject({ errorClass: 'RETRYABLE', reason: 'media_upload_failed' });
    expect(error.message).toMatch(/failed to upload/);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('ignores a toast that is not about the upload', async () => {
    const { page, opened } = fakeComposer({ toast: 'Your post was saved to drafts' });
    await attachMedia(page, opened, [IMAGE], { pollMs: 1, timeoutMs: 200 });
  });

  it('fails retryably, without giving anything, when the composer has no file input', async () => {
    const { page, opened, log } = fakeComposer({ inputs: 0 });
    const error = await failure(() => attachMedia(page, opened, [IMAGE], { pollMs: 1, timeoutMs: 30 }));
    expect(error).toMatchObject({ errorClass: 'RETRYABLE', reason: 'media_input_missing' });
    expect(log).toEqual([]);
  });

  it('fails retryably when the input refuses the file', async () => {
    const { page, opened } = fakeComposer({ setFilesError: 'Target closed' });
    const error = await failure(() => attachMedia(page, opened, [IMAGE], { pollMs: 1, timeoutMs: 30 }));
    expect(error).toMatchObject({ errorClass: 'RETRYABLE', reason: 'media_upload_failed' });
    expect(error.message).toMatch(/Nothing was posted/);
  });
});
