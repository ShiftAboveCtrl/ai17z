import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tx } from '@xbam/database';
import { advanceNotificationWatermark } from '../../packages/runtime/src/blueskyConnect';

// Exercise the real writer with just the SQL boundary replaced. Integration
// coverage remains in blueskyChannel.test.ts; these ordering tests need no DB.
let settings: Record<string, unknown>;
let writes = 0;
vi.mock('@xbam/database', async (importOriginal) => ({
  ...await importOriginal<typeof import('@xbam/database')>(),
  withTransaction: async <T>(run: (tx: Tx) => Promise<T>) => run({
    async one<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | null> {
      expect(sql).toBe('SELECT settings FROM accounts WHERE id = $1 FOR UPDATE');
      expect(params).toEqual(['account']);
      return { settings: structuredClone(settings) } as unknown as T;
    },
    async many() {
      throw new Error('The watermark writer must use the locked row, not another read.');
    },
    async query(sql: string, params: unknown[] = []) {
      expect(sql.replace(/\s+/g, ' ').trim()).toBe(
        "UPDATE accounts SET settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{bluesky}', $2::jsonb) WHERE id = $1",
      );
      expect(params[0]).toBe('account');
      settings = { ...settings, bluesky: JSON.parse(params[1] as string) };
      writes += 1;
      return { rows: [], rowCount: 1 };
    },
  }),
}));

const at = (seconds: number) => new Date(Date.UTC(2026, 10, 8) + seconds * 1_000).toISOString();
const events = (...seconds: number[]) => seconds.map((s) => ({ raw: { indexedAt: at(s) } }));
const state = () => settings.bluesky as Record<string, unknown>;
beforeEach(() => {
  settings = { theme: 'kept', bluesky: { notificationsSeenThrough: at(100), serviceUrl: 'https://pds.example.test' } };
  writes = 0;
});

describe('notification state compare and set', () => {
  it('leaves the newer incomplete poll untouched when the older poll completes last', async () => {
    await advanceNotificationWatermark('account', events(400), { complete: false, resume: 'unread-101-to-200' }, 0);
    const newer = structuredClone(settings);
    const before = writes;
    await advanceNotificationWatermark('account', events(200), { complete: true, resume: null }, 0);
    expect(settings).toEqual(newer);
    expect(writes).toBe(before);
    expect(state().notificationsSeenThrough).toBe(at(100));
    expect(state().notificationsResume).toEqual({ cursor: 'unread-101-to-200', throughAt: at(400) });
  });

  it('allows a fresh poll to resume after rejecting the overlapping completion', async () => {
    await advanceNotificationWatermark('account', events(400), { complete: false, resume: 'remainder' }, 0);
    await advanceNotificationWatermark('account', events(200), { complete: true, resume: null }, 0);
    // This poll read version 1, including the continuation left by the winner.
    await advanceNotificationWatermark('account', events(101, 150, 200), { complete: true, resume: null }, 1);
    expect(writes).toBe(2);
    expect(state().notificationsSeenThrough).toBe(at(400));
    expect(state().notificationsResume).toBeUndefined();
    expect(state().notificationsVersion).toBe(2);
    expect(settings.theme).toBe('kept');
    expect(state().serviceUrl).toBe('https://pds.example.test');
  });

  it('rejects an incomplete stale poll too, preserving the winning cursor', async () => {
    await advanceNotificationWatermark('account', events(400), { complete: false, resume: 'winner' }, 0);
    await advanceNotificationWatermark('account', events(300), { complete: false, resume: 'stale' }, 0);
    expect(state().notificationsResume).toEqual({ cursor: 'winner', throughAt: at(400) });
    expect(writes).toBe(1);
  });

  it('keeps the mark when a refused cursor cannot be retried within the budget', async () => {
    await advanceNotificationWatermark('account', events(400), { complete: false, resume: 'expired' }, 0);
    await advanceNotificationWatermark('account', [], { complete: false, resume: null, restarted: true }, 1);
    expect(state().notificationsSeenThrough).toBe(at(100));
    expect(state().notificationsResume).toBeUndefined();
  });
});
