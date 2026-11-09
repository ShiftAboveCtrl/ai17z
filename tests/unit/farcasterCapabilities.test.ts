import { beforeEach, describe, expect, it } from 'vitest';
import { getCapability, listModelCallable, resetCapabilitiesForTest } from '@xbam/tools';
import { registerFarcasterCapabilities } from '@xbam/runtime';

beforeEach(() => {
  resetCapabilitiesForTest();
  registerFarcasterCapabilities();
});

describe('Farcaster capability boundary', () => {
  it('pins the model-callable surface; posts and replies use pipeline grants', () => {
    expect(listModelCallable().map((c) => c.id)).toEqual([
      'farcaster.like', 'farcaster.read_cast', 'farcaster.read_thread', 'farcaster.recast',
    ]);
  });
  it('rejects a bare hash or handle as an ambiguous cast target', () => {
    const input = getCapability('farcaster.read_cast')?.input;
    expect(input?.safeParse({ cast: `farcaster:22:0x${'ab'.repeat(20)}` }).success).toBe(true);
    expect(input?.safeParse({ cast: `0x${'ab'.repeat(20)}` }).success).toBe(false);
    expect(input?.safeParse({ cast: '@someone' }).success).toBe(false);
  });
  it('declares writes disabled and reads low risk by default', () => {
    for (const id of ['farcaster.like', 'farcaster.recast']) {
      expect(getCapability(id)).toMatchObject({ effect: 'WRITE', unsetPermission: 'DISABLED' });
    }
    for (const id of ['farcaster.read_cast', 'farcaster.read_thread']) {
      expect(getCapability(id)).toMatchObject({ effect: 'READ', risk: 'LOW' });
    }
  });
});
