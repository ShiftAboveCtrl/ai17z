import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The worker's account reads, the persona collector and the Response Lab each
 * used to call X's reader directly. They now take the reader from the reading
 * account's channel, and a channel with no reader is refused in words: no throw,
 * nothing queued, nothing recorded, and no other network's reader quietly used
 * in its place.
 */

const requireAccount = vi.hoisted(() => vi.fn());
const setSourceStatus = vi.hoisted(() => vi.fn(async () => undefined));
const record = vi.hoisted(() => vi.fn());
const listAccounts = vi.hoisted(() => vi.fn());

vi.mock('@xbam/database', async (importOriginal) => {
  const original = await importOriginal<typeof import('@xbam/database')>();
  return {
    ...original,
    accounts: { ...original.accounts, requireAccount, listAccounts },
    personaSources: { ...original.personaSources, setSourceStatus },
    xAccountObservations: { ...original.xAccountObservations, record },
  };
});

import { readXAccount } from '../../apps/worker/src/accountIntelligence';
import { collectPersonaFromX, readerAccountFor } from '../../apps/worker/src/personaFromX';
import { rehearseAgainstPost } from '../../apps/worker/src/rehearsalPost';

const account = (channel: string) => ({ id: 'acct-1', channel, handle: 'someone', ownerId: 'owner-1', enabled: true });

beforeEach(() => {
  requireAccount.mockReset();
  setSourceStatus.mockClear();
  record.mockReset();
  listAccounts.mockReset();
});

describe.each(['bluesky', 'mock', 'threads', 'a-channel-nobody-built'])('a reading account on %s', (channel) => {
  beforeEach(() => requireAccount.mockResolvedValue(account(channel)));

  it('is refused when asked to read an account, and nothing is recorded', async () => {
    const read = await readXAccount({ ownerUserId: 'owner-1', handle: 'somebody', readerAccountId: 'acct-1' });
    expect(read.outcome).toBe('UNAVAILABLE');
    expect(read.detail).toContain(channel);
    expect(read.row).toBeNull();
    expect(read.postsRead).toBe(0);
    expect(record).not.toHaveBeenCalled();
  });

  it('is refused when asked to learn a voice, and the source is marked unavailable', async () => {
    const collection = await collectPersonaFromX({ sourceId: 'source-1', handle: 'somebody', readerAccountId: 'acct-1' });
    expect(collection.outcome).toBe('REFUSED');
    expect(collection.collected).toBe(0);
    expect(setSourceStatus).toHaveBeenCalledWith('source-1', 'UNAVAILABLE', expect.objectContaining({ lastError: expect.stringContaining(channel) }));
  });

  it('is refused when asked to rehearse against a post, and nothing is queued', async () => {
    const run = await rehearseAgainstPost({
      readerAccountId: 'acct-1',
      agentId: 'agent-1',
      postRef: 'https://x.com/someone/status/1900000000000000001',
      requestedBy: null,
    });
    expect(run.outcome).toBe('UNAVAILABLE');
    expect(run.jobId).toBeNull();
    expect(run.subject).toBeNull();
    expect(run.detail).toContain(channel);
  });
});

describe('a reading account on X', () => {
  beforeEach(() => requireAccount.mockResolvedValue(account('x')));

  it('is not refused for being on the wrong network: a bad link is the only thing wrong with it', async () => {
    const run = await rehearseAgainstPost({
      readerAccountId: 'acct-1',
      agentId: 'agent-1',
      postRef: 'https://x.com/someone',
      requestedBy: null,
    });
    // The same answer it gave before there were profiles, reached before any browser is asked.
    expect(run.outcome).toBe('NOT_FOUND');
    expect(run.detail).toBe('That is not a link to a post. Paste the address of one, or its numeric id.');
    expect(run.jobId).toBeNull();
  });
});

describe('choosing which of an owner’s accounts reads', () => {
  it('takes the first enabled one on a network that has a reader', async () => {
    listAccounts.mockResolvedValue([
      { id: 'a-bluesky', channel: 'bluesky', enabled: true },
      { id: 'a-x-off', channel: 'x', enabled: false },
      { id: 'a-x', channel: 'x', enabled: true },
    ]);
    expect(await readerAccountFor('owner-1')).toBe('a-x');
  });

  it('is nobody when no account is on such a network', async () => {
    listAccounts.mockResolvedValue([
      { id: 'a-bluesky', channel: 'bluesky', enabled: true },
      { id: 'a-mock', channel: 'mock', enabled: true },
    ]);
    expect(await readerAccountFor('owner-1')).toBeNull();
  });
});
