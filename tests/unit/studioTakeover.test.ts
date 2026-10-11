import { describe, expect, it } from 'vitest';
import { leaseSession, lockForOperation, ownerHolds, setOwnerHolding, type TabState } from '@xbam/browser';
import { applyOwnerInput, carryOut, SENSITIVE_INPUT_RULES, STUDIO_COMMANDS } from '@xbam/runtime';

/**
 * Taking control of an agent's browser from Studio. What is pinned: while the
 * owner holds an account's browser no new operation starts on it; only the
 * closed list of input kinds reaches the page, each as one mouse or keyboard
 * call; a key outside the list and a malformed event do nothing; the verbs
 * are carried out only where something can show a browser; and the rules
 * about what an owner types are still the rules.
 */

function fakePage() {
  const calls: string[] = [];
  return {
    calls,
    page: {
      mouse: {
        click: async (x: number, y: number, o?: { button?: string }) => void calls.push(`click ${x},${y} ${o?.button ?? 'left'}`),
        move: async (x: number, y: number) => void calls.push(`move ${x},${y}`),
        wheel: async (dx: number, dy: number) => void calls.push(`wheel ${dx},${dy}`),
      },
      keyboard: {
        insertText: async (t: string) => void calls.push(`text ${t.length}`),
        press: async (k: string) => void calls.push(`press ${k}`),
      },
    } as never,
  };
}

describe('taking control', () => {
  it('starts no new browser operation on an account its owner holds', async () => {
    setOwnerHolding('acct-1', true);
    expect(ownerHolds('acct-1')).toBe(true);
    await expect(leaseSession({ accountId: 'acct-1' } as never)).rejects.toMatchObject({ reason: 'owner_has_the_browser' });
    setOwnerHolding('acct-1', false);
    expect(ownerHolds('acct-1')).toBe(false);
  });

  /*
    The race the start-of-lease check alone left open: an operation queued
    behind another on the same tab passed that check before the owner asked,
    and took the tab once it came free, after the owner had been told the page
    was theirs. Without the check after the lock, `waiting` resolves and this
    fails.
  */
  it('refuses an operation that was already waiting for the tab when the owner took it', async () => {
    const tab = { role: 'MENTIONS', queue: Promise.resolve(), busy: false, heldSince: null, lastUsedAt: 0, lastError: null } as unknown as TabState;
    const first = await lockForOperation('acct-2', tab);
    const waiting = lockForOperation('acct-2', tab);
    setOwnerHolding('acct-2', true);
    first();
    await expect(waiting).rejects.toMatchObject({ reason: 'owner_has_the_browser' });
    // Refused without keeping the tab: nothing the owner does next waits behind it.
    expect(tab.busy).toBe(false);
    setOwnerHolding('acct-2', false);
    const after = await lockForOperation('acct-2', tab);
    expect(tab.busy).toBe(true);
    after();
  });

  it('turns each kind of owner input into one call on the page, and nothing else', async () => {
    const { calls, page } = fakePage();
    expect(await applyOwnerInput(page, { t: 'click', x: 10, y: 20, button: 'right' })).toBe(true);
    expect(await applyOwnerInput(page, { t: 'scroll', x: 5, y: 5, dy: 99_999 })).toBe(true);
    expect(await applyOwnerInput(page, { t: 'text', text: '123456' })).toBe(true);
    expect(await applyOwnerInput(page, { t: 'key', key: 'Enter' })).toBe(true);
    expect(calls).toEqual(['click 10,20 right', 'move 5,5', 'wheel 0,5000', 'text 6', 'press Enter']);
  });

  it('ignores what is not on the list', async () => {
    const { calls, page } = fakePage();
    for (const bad of [{ t: 'key', key: 'F12' }, { t: 'key', key: 'Control+V' }, { t: 'click', x: -1, y: 2 }, { t: 'text', text: '' }, { t: 'eval', code: 'x' }, null]) {
      expect(await applyOwnerInput(page, bad)).toBe(false);
    }
    expect(calls).toEqual([]);
  });

  it('is two more verbs, carried out only where a browser can be shown', async () => {
    expect(STUDIO_COMMANDS).toEqual(expect.arrayContaining(['TAKE_CONTROL', 'RELEASE_CONTROL']));
    const effects = {
      agent: async () => ({ id: 'a', name: 'Scout', state: 'ACTIVE' }),
      pause: async () => {},
      resume: async () => ({ ok: true as const }),
      pauseAll: async () => {},
      audit: async () => {},
    };
    const command = { id: '11111111-1111-4111-8111-111111111111', kind: 'TAKE_CONTROL', agentId: '22222222-2222-4222-8222-222222222222', ageMs: 1000 };
    expect(await carryOut(command, effects)).toMatchObject({ ok: false, sentence: expect.stringMatching(/does not run the browser/) });
    const taken = await carryOut(command, { ...effects, takeControl: async () => ({ ok: true, sentence: 'You have it.' }) });
    expect(taken).toMatchObject({ ok: true, sentence: 'You have it.' });
  });

  it('keeps the rules about what an owner types', () => {
    expect(SENSITIVE_INPUT_RULES.join(' ')).toMatch(/never written to a log/);
    expect(SENSITIVE_INPUT_RULES.join(' ')).toMatch(/answered by the person only/);
  });
});
