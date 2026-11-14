import { describe, expect, it } from 'vitest';
import { PublicHomeManifest, projectHomeManifest, asksForPublicHome, buildPublicHomeShare } from '../../packages/runtime/src/studioPublicHome';
import { PUBLIC_HOME_DISCLOSURE, PUBLIC_HOME_PITCH_MAX, PublicHomePitch, PublicHomeShare } from '../../packages/shared/src/contracts/studioPublicHome';
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

describe('public home share card', () => {
  const share = { protocol: 1, identity: 'AI_AGENT', simulated: true, url: 'https://studio.example.invalid/a/night-owl', pitch: 'A calm AI agent trading on paper.', disclosure: PUBLIC_HOME_DISCLOSURE };
  it('pins the exact exported share shape', () => {
    expect(buildPublicHomeShare({ url: share.url, pitch: share.pitch })).toEqual(share);
    expect(Object.keys(PublicHomeShare.shape).sort()).toEqual(['disclosure', 'identity', 'pitch', 'protocol', 'simulated', 'url'].sort());
  });
  it('never lets a credential, memory or account identity enter the share shape', () => {
    for (const key of ['credential', 'memory', 'prompt', 'relationship', 'account', 'owner', 'wallet', 'title', 'image']) {
      expect(PublicHomeShare.safeParse({ ...share, [key]: 'private' }).success).toBe(false);
    }
    expect(PublicHomeShare.safeParse({ ...share, title: 'a title', description: 'a description', image: 'https://example.invalid/i.png' }).success).toBe(false);
  });
  it('always identifies an AI agent and simulated paper results, and never fabricates a title or image', () => {
    expect(PUBLIC_HOME_DISCLOSURE).toMatch(/\bAI agent\b/i);
    expect(PUBLIC_HOME_DISCLOSURE).toMatch(/\bsimulated paper\b/i);
    expect(JSON.stringify(share)).not.toContain('title');
    expect(JSON.stringify(share)).not.toContain('image');
  });
  it('caps the pitch at one line of a fixed length and refuses an empty or multiline pitch', () => {
    expect(PublicHomePitch.safeParse('x'.repeat(PUBLIC_HOME_PITCH_MAX)).success).toBe(true);
    expect(PublicHomePitch.safeParse('x'.repeat(PUBLIC_HOME_PITCH_MAX + 1)).success).toBe(false);
    expect(PublicHomePitch.safeParse('  ').success).toBe(false);
    expect(PublicHomePitch.safeParse('first line\nsecond line').success).toBe(false);
    expect(buildPublicHomeShare({ url: share.url, pitch: '' })).toBeNull();
    expect(buildPublicHomeShare({ url: share.url, pitch: 'two\nlines' })).toBeNull();
  });
  it('rejects a share whose url is not the published home or whose identity is wrong', () => {
    expect(PublicHomeShare.safeParse({ ...share, url: 'not a url' }).success).toBe(false);
    expect(PublicHomeShare.safeParse({ ...share, identity: 'HUMAN' }).success).toBe(false);
    expect(PublicHomeShare.safeParse({ ...share, simulated: false }).success).toBe(false);
  });
});
