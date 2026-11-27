import { describe, expect, it } from 'vitest';
import {
  BLUESKY_NETWORK_PROFILE,
  CHANNELS,
  NETWORK_TAB_ROLES,
  RADAR_SOURCE_KINDS,
  X_NETWORK_PROFILE,
  X_READ_PACING,
  effectiveReadInterval,
  effectiveXInterval,
  getNetworkProfile,
  isBrowserNetwork,
  listNetworkProfiles,
  networkHas,
  postIdFromInput,
  postUrlFor,
  profileUrlFor,
} from '@xbam/shared/contracts';

/**
 * The engine used to ask `channel === 'x'` in about sixteen places. Each of
 * those is now a question put to a network's profile, and these tests pin two
 * things: that X's profile says exactly what the hard-coded answers said, and
 * that a channel with no profile is answered the way a non-browser channel
 * always was, never with a throw.
 */
describe('the network profile registry', () => {
  it('describes X and Bluesky and nothing else yet', () => {
    expect(listNetworkProfiles().map((profile) => profile.channel).sort()).toEqual(['bluesky', 'x']);
    // Every profile is keyed by a channel the product actually has.
    for (const profile of listNetworkProfiles()) expect(CHANNELS).toContain(profile.channel);
  });

  it('looks a profile up by channel and by a plain string', () => {
    expect(getNetworkProfile('x')).toBe(X_NETWORK_PROFILE);
    expect(getNetworkProfile('bluesky')).toBe(BLUESKY_NETWORK_PROFILE);
  });

  it('answers an unknown, empty or missing channel with nothing, never a throw', () => {
    for (const channel of ['discord', 'threads', '', null, undefined, 'X']) {
      expect(getNetworkProfile(channel)).toBeUndefined();
    }
  });
});

describe('what an unknown channel is treated as', () => {
  const unknown = ['mock', 'telegram', 'farcaster', 'threads', 'not-a-channel', '', null, undefined] as const;

  it('is not browser driven', () => {
    for (const channel of unknown) expect(isBrowserNetwork(channel)).toBe(false);
  });

  it('has none of the optional features', () => {
    for (const channel of unknown) {
      for (const feature of ['spendsReadBudget', 'accountReads', 'capabilityTools', 'studioCounts'] as const) {
        expect(networkHas(channel, feature)).toBe(false);
      }
    }
  });

  it('keeps whatever pace it was configured with', () => {
    for (const channel of unknown) expect(effectiveReadInterval(channel, 'mention_search', 5)).toBeNull();
  });

  it('has no urls and no post ids to offer', () => {
    for (const channel of unknown) {
      expect(profileUrlFor(channel, 'someone')).toBeNull();
      expect(postUrlFor(channel, '1900000000000000001')).toBeNull();
      expect(postIdFromInput(channel, '1900000000000000001')).toBeNull();
    }
  });
});

describe('X, as the profile says it', () => {
  it('is driven through the browser and keeps all four tabs', () => {
    expect(isBrowserNetwork('x')).toBe(true);
    expect(X_NETWORK_PROFILE.browser?.tabs.roles).toEqual([...NETWORK_TAB_ROLES]);
    expect(X_NETWORK_PROFILE.browser?.startUrl).toBe('https://x.com/home');
    expect(X_NETWORK_PROFILE.browser?.homeUrl).toBe('https://x.com/home');
  });

  it('has the features every X-only gate used to mean', () => {
    for (const feature of ['spendsReadBudget', 'accountReads', 'capabilityTools', 'studioCounts'] as const) {
      expect(networkHas('x', feature)).toBe(true);
    }
  });

  it('seeds a new account with the same four monitors at the same pace as before', () => {
    expect(X_NETWORK_PROFILE.pacing.defaultRadar).toEqual([
      { kind: 'notifications', label: 'Notifications', intervalSeconds: 90 },
      { kind: 'mention_search', label: 'Mention search', intervalSeconds: 300 },
      { kind: 'reply_search', label: 'Reply search', intervalSeconds: 600 },
      { kind: 'own_threads', label: 'Replies to own posts', intervalSeconds: 300 },
    ]);
  });

  it('reads its pacing from X_READ_PACING, the one table that decides it', () => {
    expect(X_NETWORK_PROFILE.pacing.read).toBe(X_READ_PACING);
  });

  it('gives exactly effectiveXInterval for every kind of page and every setting', () => {
    for (const kind of RADAR_SOURCE_KINDS) {
      for (const configured of [undefined, null, 1, 30, 60, 90, 299, 300, 599, 600, 1200, 1800, 7200]) {
        expect(effectiveReadInterval('x', kind, configured)).toEqual(effectiveXInterval(kind, configured));
      }
    }
  });

  it('builds the links the interface used to write by hand', () => {
    expect(profileUrlFor('x', 'someone')).toBe('https://x.com/someone');
    expect(profileUrlFor('x', '@someone')).toBe('https://x.com/someone');
    expect(postUrlFor('x', '1900000000000000001')).toBe('https://x.com/i/web/status/1900000000000000001');
  });

  it('reads a post id from a link or on its own, the way the rehearsal always did', () => {
    expect(postIdFromInput('x', '1900000000000000001')).toBe('1900000000000000001');
    expect(postIdFromInput('x', '  1900000000000000001  ')).toBe('1900000000000000001');
    expect(postIdFromInput('x', 'https://x.com/someone/status/1900000000000000001?s=20')).toBe('1900000000000000001');
    expect(postIdFromInput('x', 'https://twitter.com/someone/statuses/1900000000000000001')).toBe('1900000000000000001');
    expect(postIdFromInput('x', 'https://x.com/someone')).toBeNull();
    expect(postIdFromInput('x', '123')).toBeNull();
    expect(postIdFromInput('x', '')).toBeNull();
  });

  it('refuses a public screenshot of X, including its short links', () => {
    expect(X_NETWORK_PROFILE.refusedCaptureHosts).toEqual(['x.com', 'twitter.com', 't.co']);
  });
});

describe('Bluesky, which is here for the questions that are not about a browser', () => {
  it('is not browser driven but does spend the account budget', () => {
    expect(isBrowserNetwork('bluesky')).toBe(false);
    expect(BLUESKY_NETWORK_PROFILE.browser).toBeNull();
    expect(networkHas('bluesky', 'spendsReadBudget')).toBe(true);
  });

  it('keeps whatever pace it was configured with and seeds no radar', () => {
    expect(effectiveReadInterval('bluesky', 'mention_search', 5)).toBeNull();
    expect(BLUESKY_NETWORK_PROFILE.pacing.defaultRadar).toEqual([]);
  });

  it('cannot build a post link from an id alone', () => {
    expect(postUrlFor('bluesky', '3kabc')).toBeNull();
    expect(postUrlFor('bluesky', '3kabc', 'someone.bsky.social')).toBe('https://bsky.app/profile/someone.bsky.social/post/3kabc');
  });
});
