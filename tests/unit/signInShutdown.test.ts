import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What a worker shutdown is allowed to say about a sign-in in progress.
 *
 * From a real Mac, Beta 1.0.0 (19): an account sat in AWAITING_LOGIN with the
 * Chrome window open, `ai17z restart` arrived, and nine milliseconds after
 * SIGTERM the account was marked NEEDS_AUTH -- "The sign-in window was closed
 * before it finished." Nobody had closed anything. Shutdown detached CDP under
 * a check that was halfway through reading the page, the adapter correctly
 * reported UNREACHABLE, and the watcher wrote that down as the owner's doing.
 *
 * The window was still on screen. Coming back up, the account said it needed
 * signing in again -- so the damage outlived the restart that caused it.
 *
 * Mocked rather than run against Postgres and a browser, because the question
 * here is one of ordering: which writes happen, and whether stopping waits.
 */

const updates: { accountId: string; status?: string; lastHealthStatus?: string }[] = [];
let awaiting: { id: string }[] = [];
/** How many times the watcher went looking for work at all. */
let listed = 0;
let observed: () => Promise<{ state: string; detail: string }> = async () => ({
  state: 'AWAITING_LOGIN',
  detail: 'Waiting.',
});

vi.mock('@xbam/database', () => ({
  accounts: {
    async accountsAwaitingSignIn() {
      listed += 1;
      return awaiting;
    },
    async getAccount(id: string) {
      return {
        id,
        handle: `@${id}`,
        channel: 'X',
        status: 'AWAITING_LOGIN',
        displayName: null,
        authStartedAt: new Date().toISOString(),
        // Deliberately in the future: an expired deadline is a different
        // branch, and it writes before the browser is ever touched.
        authDeadlineAt: new Date(Date.now() + 600_000).toISOString(),
      };
    },
    async updateAccount(accountId: string, patch: Record<string, unknown>) {
      updates.push({ accountId, ...(patch as { status?: string; lastHealthStatus?: string }) });
    },
  },
  ops: {
    async createDiagnostic() {
      return { id: 'd' };
    },
  },
}));

vi.mock('@xbam/channels', () => ({
  getChannelAdapter: () => ({
    async observeAuth() {
      return observed();
    },
  }),
}));

vi.mock('@xbam/runtime', () => ({
  async buildChannelContext() {
    return {} as unknown;
  },
}));

const { SignInWatcher } = await import('../../apps/worker/src/signIn');

/** Resolves when somebody else asks it to, so a check can be held mid-flight. */
function gate() {
  let open!: () => void;
  const waited = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { waited, open };
}

beforeEach(() => {
  updates.length = 0;
  listed = 0;
  awaiting = [{ id: 'acc-1' }];
  observed = async () => ({ state: 'AWAITING_LOGIN', detail: 'Waiting.' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a sign-in check caught by a shutdown', () => {
  it('does not tell the owner their window was closed', async () => {
    const watcher = new SignInWatcher();
    let stopping: Promise<void> | null = null;
    // The shutdown arrives *during* the read, which is the only version of
    // this that matters: a check declined before it started never reaches the
    // branch that writes. So stopping begins inside the page read, and the
    // browser then goes away underneath it -- what detaching CDP looks like
    // from up here.
    observed = async () => {
      stopping = watcher.stop();
      return { state: 'UNREACHABLE', detail: 'Target closed.' };
    };

    await watcher.tick();
    await stopping;

    expect(updates, 'a shutdown wrote a status of its own').toEqual([]);
  });

  it('still says so when nothing is shutting down', async () => {
    // The mirror of the case above, and the reason it cannot simply swallow
    // UNREACHABLE: somebody closing the window really is the ordinary way a
    // sign-in ends, and the account has to come back to NEEDS_AUTH.
    const watcher = new SignInWatcher();
    observed = async () => ({ state: 'UNREACHABLE', detail: 'Target closed.' });

    await watcher.tick();

    expect(updates).toHaveLength(1);
    expect(updates[0]?.status).toBe('NEEDS_AUTH');
    expect(updates[0]?.lastHealthStatus).toContain('closed before it finished');
  });

  it('waits for the check rather than racing it', async () => {
    // `stop()` used to clear the interval and return, so the caller went
    // straight on to closing every browser while a check still held a page.
    const watcher = new SignInWatcher();
    const held = gate();
    let finished = false;
    observed = async () => {
      await held.waited;
      finished = true;
      return { state: 'AWAITING_LOGIN', detail: 'Still waiting.' };
    };

    const tick = watcher.tick();
    await Promise.resolve();
    const stop = watcher.stop().then(() => {
      expect(finished, 'stop() returned while a check was still reading a page').toBe(true);
    });

    held.open();
    await Promise.all([tick, stop]);
    expect(finished).toBe(true);
  });

  it('does not even look for work once stopping', async () => {
    // Asserted on the query rather than on the writes, because the loop
    // declines each account individually and that alone would hide a tick
    // that had started and gone to the database on a worker on its way down.
    const watcher = new SignInWatcher();
    let asked = 0;
    observed = async () => {
      asked += 1;
      return { state: 'UNREACHABLE', detail: 'Target closed.' };
    };

    await watcher.stop();
    await watcher.tick();

    expect(listed, 'a stopping watcher went looking for accounts').toBe(0);
    expect(asked, 'a check ran after shutdown began').toBe(0);
    expect(updates).toEqual([]);
  });

  it('is awaited by the shutdown that asked for it', () => {
    // Every guard above is defeated at the call site by dropping one word.
    // `signIns.stop()` unawaited returns a promise nobody holds, and the
    // shutdown goes straight on to closing the browsers -- which is the fault
    // this whole file is about, reintroduced one line higher up.
    const main = readFileSync(resolve(__dirname, '../../apps/worker/src/main.ts'), 'utf8');
    expect(main).toMatch(/await signIns\.stop\(\);/);
  });

  it('abandons the accounts it has not reached yet', async () => {
    // Several accounts can be signing in at once. Stopping partway through
    // must not walk the rest of the list against browsers already closing.
    const watcher = new SignInWatcher();
    awaiting = [{ id: 'acc-1' }, { id: 'acc-2' }, { id: 'acc-3' }];
    const seen: string[] = [];
    let stopping: Promise<void> | null = null;
    observed = async () => {
      seen.push('checked');
      if (seen.length === 1) stopping = watcher.stop();
      return { state: 'AWAITING_LOGIN', detail: 'Waiting.' };
    };

    await watcher.tick();
    await stopping;

    expect(seen, 'kept checking accounts through a shutdown').toHaveLength(1);
  });
});
