import { describe, expect, it } from 'vitest';
import { ActivityEventId, ActivityTapeBatch } from '@xbam/shared/contracts';

describe('activity tape identifier contract', () => {
  it.each(['action', 'paper', 'radar'])('normalizes %s ids in removal batches', (prefix) => {
    const id = `${prefix}:abcdef01-2345-4678-9abc-def012345678`;
    expect(ActivityTapeBatch.parse({ protocol: 1, events: [], remove: [id.toUpperCase()] }).remove).toEqual([id]);
  });

  it.each(['action', 'paper', 'radar'])('refuses a malformed UUID after %s', (prefix) => {
    expect(ActivityEventId.safeParse(`${prefix}:${'-'.repeat(36)}`).success).toBe(false);
  });
});
