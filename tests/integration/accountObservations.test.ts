import { describe, expect, it } from 'vitest';
import { xAccountObservations } from '@xbam/database';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';

installHarness();

/**
 * Keeping what was read about somebody on X.
 *
 * Against a real database rather than mocks, because the guarantees here are
 * the constraints. Two unique indexes -- one on the handle, one on the numeric
 * id -- are what make a person one row instead of a slowly diverging pair, and
 * a mock would test whichever behaviour the mock was written to have.
 *
 * The case that matters is the rename. Somebody who changes their handle is the
 * same person, and an observation store that keys only on what they are called
 * quietly becomes a record of two people -- which is the exact discontinuity the
 * X intelligence layer resolves identity first in order to avoid, so it would
 * be a poor place to throw it away again.
 */

async function owner() {
  const fixture = await createFixture();
  return fixture.ownerId;
}

describe('what AI17Z read about somebody', () => {
  it('keeps one row for one person across a rename', async () => {
    const ownerUserId = await owner();

    await xAccountObservations.record({
      ownerUserId,
      userId: '44196397',
      handle: 'alice',
      displayName: 'Alice',
      followers: 100,
      outcome: 'OK',
    });
    await xAccountObservations.record({
      ownerUserId,
      userId: '44196397',
      handle: 'alice_eth',
      displayName: 'Alice',
      followers: 140,
      outcome: 'OK',
    });

    const all = await xAccountObservations.list(ownerUserId);
    expect(all).toHaveLength(1);
    expect(all[0]!.handle).toBe('alice_eth');
    expect(all[0]!.followers).toBe(140);

    // And the old name no longer finds a second, stale person.
    const byOldName = await xAccountObservations.find({ ownerUserId, handle: 'alice' });
    expect(byOldName).toBeNull();
  });

  it('finds somebody by id even when the handle has moved on', async () => {
    const ownerUserId = await owner();
    await xAccountObservations.record({ ownerUserId, userId: '999', handle: 'renamed_since', outcome: 'OK' });

    const found = await xAccountObservations.find({ ownerUserId, userId: '999', handle: 'whatever_they_were' });
    expect(found?.handle).toBe('renamed_since');
  });

  it('updates in place when the same handle is read again', async () => {
    const ownerUserId = await owner();
    await xAccountObservations.record({ ownerUserId, userId: null, handle: 'bob', followers: 10, outcome: 'OK' });
    await xAccountObservations.record({ ownerUserId, userId: null, handle: 'Bob', followers: 12, outcome: 'OK' });

    const all = await xAccountObservations.list(ownerUserId);
    expect(all).toHaveLength(1);
    expect(all[0]!.followers).toBe(12);
  });

  it('gives a row its id the first time a reader can see one', async () => {
    const ownerUserId = await owner();
    // The rendered-page reader can describe somebody without knowing who they
    // are. The structured one can, and the row should become identified rather
    // than a second row appearing beside it.
    await xAccountObservations.record({ ownerUserId, userId: null, handle: 'carol', outcome: 'OK' });
    await xAccountObservations.record({ ownerUserId, userId: '12345', handle: 'carol', outcome: 'OK' });

    const all = await xAccountObservations.list(ownerUserId);
    expect(all).toHaveLength(1);
    expect(all[0]!.userId).toBe('12345');
  });

  it('keeps two owners from seeing who the other looked up', async () => {
    const first = await owner();
    const second = await owner();
    await xAccountObservations.record({ ownerUserId: first, userId: '1', handle: 'someone', outcome: 'OK' });

    expect(await xAccountObservations.list(second)).toHaveLength(0);
    expect(await xAccountObservations.find({ ownerUserId: second, handle: 'someone' })).toBeNull();
  });

  it('records a refusal as an answer, not as an absence', async () => {
    const ownerUserId = await owner();
    await xAccountObservations.record({
      ownerUserId,
      userId: null,
      handle: 'locked',
      outcome: 'PROTECTED',
      detail: '@locked is not public.',
      backend: 'x-graphql',
    });

    const found = await xAccountObservations.find({ ownerUserId, handle: 'locked' });
    // "Nobody has looked" and "they made their account private" are different
    // things to say to somebody, and a null row cannot say the second.
    expect(found?.outcome).toBe('PROTECTED');
    expect(found?.detail).toBe('@locked is not public.');
  });

  it('refuses an outcome that is not one the layer can produce', async () => {
    const ownerUserId = await owner();
    await expect(
      xAccountObservations.record({ ownerUserId, userId: null, handle: 'x', outcome: 'SOMETHING_ELSE' }),
    ).rejects.toThrow();
  });

  it('answers about many handles in one query, which is how the list is built', async () => {
    const ownerUserId = await owner();
    await xAccountObservations.record({ ownerUserId, userId: '1', handle: 'one', outcome: 'OK' });
    await xAccountObservations.record({ ownerUserId, userId: '2', handle: 'two', outcome: 'OK' });

    const found = await xAccountObservations.findManyByHandle(ownerUserId, ['@One', 'two', 'never_read']);
    expect([...found.keys()].sort()).toEqual(['one', 'two']);
  });

  it('lets an owner forget that they looked somebody up', async () => {
    const ownerUserId = await owner();
    const row = await xAccountObservations.record({ ownerUserId, userId: '7', handle: 'curious', outcome: 'OK' });

    expect(await xAccountObservations.forget(ownerUserId, row.id)).toBe(true);
    expect(await xAccountObservations.list(ownerUserId)).toHaveLength(0);
  });

  it('will not let one owner forget another owner’s row', async () => {
    const first = await owner();
    const second = await owner();
    const row = await xAccountObservations.record({ ownerUserId: first, userId: '8', handle: 'theirs', outcome: 'OK' });

    expect(await xAccountObservations.forget(second, row.id)).toBe(false);
    expect(await xAccountObservations.list(first)).toHaveLength(1);
  });
});
