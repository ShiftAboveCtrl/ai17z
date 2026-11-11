import { describe, expect, it } from 'vitest';
import { projectHomeManifest, PublicHomeChoices, PublicHomeManifest } from '../../packages/runtime/src/studioPublicHome';

const base = { alias: 'Night Owl', showActivity: false, leagueEntryId: null, voice: null, paper: null, league: null, receipts: [] };
const r = (value: number | null) => ({ value, readAt: '2026-11-11T12:00:00.000Z' });
const xCounts = { consented: true, followers: r(1234), posts: r(56), likes: r(12), replies: r(null), reposts: r(0) };
describe('public home counts sender contract', () => {
  it('adds explicit default-off consent to the owner choices', () => {
    expect(PublicHomeChoices.parse({ alias: 'Night Owl' }).includeXCounts).toBe(false);
    expect(PublicHomeChoices.parse({ alias: 'Night Owl', includeXCounts: true }).includeXCounts).toBe(true);
  });
  it('sends only measured counts and their original times, retaining absent and measured zero', () => {
    expect(projectHomeManifest({ ...base, xCounts }).xCounts).toEqual(xCounts);
    expect(projectHomeManifest(base)).not.toHaveProperty('xCounts');
    for (const key of ['handle', 'account', 'wallet', 'installation', 'rank', 'return']) {
      expect(PublicHomeManifest.safeParse({ ...projectHomeManifest(base), xCounts: { ...xCounts, [key]: 'private' } }).success).toBe(false);
    }
  });
});
