import { describe, expect, it } from 'vitest';
import { findOwnReply } from '../../packages/channels/src/x/composer';
import { readBackVerdict } from '../../packages/channels/src/x/index';

/**
 * What a look at X for an earlier attempt can prove.
 *
 * `findOwnReply` swallows a failed article count and a failed reload as
 * "nothing here", which is the right default for ordinary recovery and the
 * wrong one for anything that must never post twice. These pin that its
 * absence is never reported as conclusive, using a page whose every read
 * fails, so no browser and no X are involved.
 */

function brokenPage() {
  const calls = { count: 0, reload: 0 };
  const page = {
    locator: () => ({
      count: async () => {
        calls.count += 1;
        throw new Error('Target page, context or browser has been closed');
      },
    }),
    reload: async () => {
      calls.reload += 1;
      throw new Error('net::ERR_INTERNET_DISCONNECTED');
    },
    waitForTimeout: async () => undefined,
  };
  return { page, calls };
}

describe('reading X back after an attempt', () => {
  it('reads as empty when the count and the reload both fail', async () => {
    const { page, calls } = brokenPage();
    const found = await findOwnReply(page as never, 'replies keep their thread after a worker restart now', ['me'], 2);
    expect(found).toBeNull();
    expect(calls.count).toBe(3);
    expect(calls.reload).toBe(2);
  });

  it('never calls that absence conclusive', async () => {
    const { page } = brokenPage();
    const verdict = readBackVerdict(
      await findOwnReply(page as never, 'replies keep their thread after a worker restart now', ['me']),
      null,
    );
    expect(verdict.done).toBe(false);
    expect(verdict.conclusive).toBe(false);
  });

  it('treats a found post as proof', () => {
    expect(readBackVerdict({ statusId: '123', url: 'https://x.com/me/status/123' }, null)).toMatchObject({
      done: true,
      conclusive: true,
      remoteActionId: '123',
    });
  });
});
