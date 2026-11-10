import { describe, expect, it } from 'vitest';
import { PublicHomeManifest, projectHomeManifest, asksForPublicHome } from '../../packages/runtime/src/studioPublicHome';
import { STUDIO_HOME_CAPABILITIES } from '../../packages/runtime/src/studioPublicHomeCapabilities';

const facts = { alias: 'Night Owl', showActivity: false, leagueEntryId: null, voice: null, paper: null, league: null, receipts: [] };
describe('public home allowlist', () => {
  it('keeps publication capabilities owner-only and disabled without consent', () => {
    expect(STUDIO_HOME_CAPABILITIES.map((c) => [c.id, c.audience, c.unsetPermission])).toEqual([
      ['studio_home.preview', 'OWNER', 'DISABLED'], ['studio_home.publish', 'OWNER', 'DISABLED'], ['studio_home.unpublish', 'OWNER', 'DISABLED'],
    ]);
  });
  it('pins the exact public shape and discards private source fields', () => {
    const manifest = projectHomeManifest({ ...facts, memory: 'private', prompt: 'private', relationships: [], credential: 'private', account: 'private' });
    expect(manifest).toEqual({ protocol: 1, identity: 'AI_AGENT', simulated: true, ...facts });
    for (const key of ['memory', 'prompt', 'relationship', 'credential', 'account', 'owner', 'wallet']) {
      expect(PublicHomeManifest.safeParse({ ...manifest, [key]: 'private' }).success).toBe(false);
    }
  });
  it('recognises requests for its own record without treating a mint as a request', () => {
    expect(asksForPublicHome('Where can I see your record?')).toBe(true);
    expect(asksForPublicHome('show me your public home')).toBe(true);
    expect(asksForPublicHome('check this mint')).toBe(false);
  });
  it('refuses private fields within receipts and paper windows, rather than forwarding them', () => {
    const manifest = projectHomeManifest(facts);
    const receipt = { id: 'receipt:00000000-0000-4000-8000-000000000000', kind: 'RECEIPT', at: '2026-11-09T12:00:00.000Z', dryRun: false };
    expect(PublicHomeManifest.safeParse({ ...manifest, receipts: [receipt] }).success).toBe(true);
    for (const key of ['memory', 'prompt', 'relationship', 'credential', 'account', 'owner', 'wallet']) {
      expect(PublicHomeManifest.safeParse({ ...manifest, receipts: [{ ...receipt, [key]: 'private' }] }).success).toBe(false);
    }
    const paper = { protocol: 1, simulated: true, source: 'ai17z-studio', generated_at: '2026-11-09T12:00:00.000Z',
      window: { label: '7d', start: '2026-11-02T12:00:00.000Z', end: '2026-11-09T12:00:00.000Z', complete: true }, state: 'MISSING', totals: null, costs: null, open_positions: null };
    expect(PublicHomeManifest.safeParse({ ...manifest, paper }).success).toBe(true);
    expect(PublicHomeManifest.safeParse({ ...manifest, paper: { ...paper, decisions: [{ prompt: 'private' }] } }).success).toBe(false);
    expect(PublicHomeManifest.safeParse({ ...manifest, paper: { ...paper, window: { ...paper.window, account: 'private' } } }).success).toBe(false);
  });
});
