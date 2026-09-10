import { describe, expect, it } from 'vitest';
import { looksLikeXBroke, looksUnavailable } from '@xbam/channels';

/**
 * Telling "X errored" apart from "there is nothing there".
 *
 * Found on a live signed-in session: a search for "ethereum" -- which certainly
 * has results -- came back with nought, and the page said "Something went
 * wrong. Try reloading." Every reader in this package renders that as an empty
 * list, so an agent would have been told nobody is talking about Ethereum.
 *
 * The two states need different answers. A deleted post is gone and asking
 * again will not help; a failed request is worth retrying and the results are
 * probably still there.
 */
describe('X saying its own request failed', () => {
  it('recognises the error page', () => {
    expect(looksLikeXBroke('Something went wrong. Try reloading. Retry')).toBe(true);
    expect(looksLikeXBroke('SOMETHING WENT WRONG. TRY RELOADING.')).toBe(true);
  });

  it('does not mistake an ordinary empty page for one', () => {
    expect(looksLikeXBroke('No results for "asdkjhasd"')).toBe(false);
    expect(looksLikeXBroke('')).toBe(false);
  });

  it('is a different question from whether the page is gone', () => {
    // A deleted post is permanent and a failed request is not. Answering one
    // with the other either retries forever or gives up on something that was
    // there all along.
    expect(looksUnavailable('This post was deleted by the post author')).toBe(true);
    expect(looksLikeXBroke('This post was deleted by the post author')).toBe(false);
    expect(looksUnavailable('Something went wrong. Try reloading.')).toBe(false);
  });
});
