import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createBarrier, waitAtBarrier } from '../support/barrier';

/**
 * The harness that proves the cross-process quota, proved itself.
 *
 * This is test support rather than product code, and it is still worth testing,
 * because it is load-bearing: the only evidence that two processes cannot
 * overspend one budget comes through it. A barrier that quietly fails to hold
 * turns that proof into a green that means nothing -- which is exactly what
 * happened with the timestamp it replaced.
 *
 * Exercised directly rather than through spawned children, so each of its
 * failure modes can be produced on purpose and in milliseconds.
 */

const barriers: { cleanup(): void }[] = [];
afterEach(() => {
  for (const barrier of barriers.splice(0)) barrier.cleanup();
});

function make(timeoutMs = 200) {
  const barrier = createBarrier({ timeoutMs });
  barriers.push(barrier);
  return barrier;
}

describe('a barrier holds everybody or says it did not', () => {
  it('releases once every expected child has arrived', async () => {
    const barrier = make();
    // Two children announce themselves before the parent looks.
    writeFileSync(join(barrier.directory, 'ready-0'), '1');
    writeFileSync(join(barrier.directory, 'ready-1'), '1');

    const outcome = await barrier.releaseWhenReady(['0', '1']);
    expect(outcome).toMatchObject({ released: true, arrived: ['0', '1'], missing: [] });
    expect(existsSync(join(barrier.directory, 'go'))).toBe(true);
  });

  it('waits for all of them, not the first', async () => {
    const barrier = make(2_000);
    writeFileSync(join(barrier.directory, 'ready-0'), '1');

    // The second arrives late. The parent must still be waiting for it.
    const releasing = barrier.releaseWhenReady(['0', '1']);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(existsSync(join(barrier.directory, 'go'))).toBe(false);

    writeFileSync(join(barrier.directory, 'ready-1'), '1');
    expect(await releasing).toMatchObject({ released: true, missing: [] });
  });

  it('reports a timeout instead of swallowing it', async () => {
    // The old version wrote go regardless and said nothing, so a barrier that
    // had not held showed up later as a confusing count. This is the whole
    // point of returning a result.
    const barrier = make(100);
    writeFileSync(join(barrier.directory, 'ready-0'), '1');

    const outcome = await barrier.releaseWhenReady(['0', '1']);
    // It names the one that never arrived, so somebody reading the failure
    // looks at one child rather than at both.
    expect(outcome).toMatchObject({ released: false, arrived: ['0'], missing: ['1'] });
  });

  it('still lets waiting children go when it times out', async () => {
    // Otherwise a child that did arrive sits until its own deadline, turning a
    // clear failure into a slow one.
    const barrier = make(100);
    await barrier.releaseWhenReady(['0', '1']);
    expect(existsSync(join(barrier.directory, 'go'))).toBe(true);
  });

  it('cannot hang when no child ever arrives', async () => {
    const barrier = make(100);
    const started = Date.now();
    const outcome = await barrier.releaseWhenReady(['a', 'b', 'c']);
    expect(outcome.released).toBe(false);
    expect(outcome.arrived).toEqual([]);
    expect(outcome.missing).toEqual(['a', 'b', 'c']);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe('one barrier cannot be released by another', () => {
  it('gives every barrier its own directory', () => {
    const first = make();
    const second = make();
    expect(first.directory).not.toBe(second.directory);
  });

  it('is not satisfied by ready or go files from an earlier run', async () => {
    // The reason the directory is created fresh each time. A leftover `go`
    // would release children that never met; a leftover `ready-` would make the
    // parent think somebody had arrived who had not.
    const earlier = make();
    writeFileSync(join(earlier.directory, 'ready-0'), '1');
    writeFileSync(join(earlier.directory, 'go'), '1');

    const now = make(100);
    expect(readdirSync(now.directory)).toEqual([]);
    const outcome = await now.releaseWhenReady(['0']);
    expect(outcome).toMatchObject({ released: false, arrived: [], missing: ['0'] });
  });
});

describe('a child at the line', () => {
  it('announces itself and waits to be let go', async () => {
    const barrier = make();
    const waiting = waitAtBarrier(barrier.directory, 'a', { timeoutMs: 2_000 });

    // It has said it is here, and it has not proceeded.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(existsSync(join(barrier.directory, 'ready-a'))).toBe(true);

    expect(await barrier.releaseWhenReady(['a'])).toMatchObject({ released: true });
    expect(await waiting).toBe(true);
  });

  it('gives up rather than waiting for ever, and says it was not released', async () => {
    const barrier = make();
    // Nobody ever writes go.
    expect(await waitAtBarrier(barrier.directory, 'a', { timeoutMs: 100 })).toBe(false);
  });
});

describe('cleanup', () => {
  it('removes the directory, and does not mind being asked twice', () => {
    const barrier = createBarrier();
    writeFileSync(join(barrier.directory, 'ready-0'), '1');
    expect(existsSync(barrier.directory)).toBe(true);

    barrier.cleanup();
    expect(existsSync(barrier.directory)).toBe(false);
    // Idempotent: an afterAll that runs after an early cleanup must not throw.
    expect(() => barrier.cleanup()).not.toThrow();
  });
});
