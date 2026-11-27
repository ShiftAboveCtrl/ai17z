import { describe, expect, it } from 'vitest';
import { X_NETWORK_PROFILE } from '@xbam/shared/contracts';
import { reconcileTabs, browserProfileFor, type OpenPage, type TabShapes } from '@xbam/browser';
import { accountReaderFor, canReadAccounts, xIntelligence } from '@xbam/channels';
import { DEFAULT_X_RADAR, defaultRadarFor, spendsReadBudget } from '@xbam/runtime';
import { screenshotUrlAllowed } from '../../packages/channels/src/postScreenshot';

/**
 * Each place that used to compare a channel with the string 'x' now asks the
 * network's profile or a dispatch table instead. For every one of them: X gets
 * the answer it always got, and a channel nobody has described gets the answer
 * a non-browser channel always got, with no throw.
 */

const UNKNOWN = ['mock', 'telegram', 'farcaster', 'threads', 'a-channel-nobody-built', ''] as const;

describe('capacity: who spends the read budget', () => {
  it('is X and Bluesky, as before', () => {
    expect(spendsReadBudget('x')).toBe(true);
    expect(spendsReadBudget('bluesky')).toBe(true);
  });

  it('is nobody else, and an unknown channel does not crash it', () => {
    for (const channel of UNKNOWN) expect(spendsReadBudget(channel)).toBe(false);
  });
});

describe('reconcile: what a new account starts watching', () => {
  it('is the same four monitors on X', () => {
    expect(defaultRadarFor('x')).toEqual(DEFAULT_X_RADAR);
    expect(defaultRadarFor('x').map((preset) => preset.kind)).toEqual([
      'notifications',
      'mention_search',
      'reply_search',
      'own_threads',
    ]);
  });

  it('is nothing for Bluesky, the mock channel, and a channel with no profile', () => {
    for (const channel of ['bluesky', ...UNKNOWN]) expect(defaultRadarFor(channel)).toEqual([]);
  });
});

describe('who reads accounts and posts for a channel', () => {
  it('hands X its canonical intelligence layer', () => {
    expect(accountReaderFor('x')).toBe(xIntelligence);
    expect(canReadAccounts('x')).toBe(true);
  });

  it('hands nothing to any other channel, so the caller refuses in words', () => {
    for (const channel of ['bluesky', ...UNKNOWN, null, undefined]) {
      expect(accountReaderFor(channel)).toBeNull();
      expect(canReadAccounts(channel)).toBe(false);
    }
  });
});

describe('the browser session a network gets', () => {
  it('starts X on its home page and recognises its tabs', () => {
    const profile = browserProfileFor('x');
    expect(profile.startUrl).toBe('https://x.com/home');
    expect(profile.tabs).toBe(X_NETWORK_PROFILE.browser!.tabs);
  });

  it('falls back to X for a channel it does not know, as every session did before', () => {
    for (const channel of [...UNKNOWN, 'bluesky', null, undefined]) {
      expect(browserProfileFor(channel).startUrl).toBe('https://x.com/home');
    }
  });
});

describe('tab reconciliation reads the network it was given', () => {
  let id = 0;
  const page = (url: string, tag: OpenPage['tag'] = null): OpenPage => ({ id: `p${(id += 1)}`, tag, url });

  // A second network, described the way a profile would: not X, with its own
  // pages for two of the four roles and no use for the other two.
  const elsewhere: TabShapes = {
    roles: ['ACTION', 'NOTIFICATIONS'],
    looksLike: { NOTIFICATIONS: /example\.test\/activity/i },
    onNetwork: /example\.test/i,
  };

  it('defaults to X, so a caller that passes nothing is unchanged', () => {
    const pages = [page('https://x.com/notifications'), page('https://x.com/home')];
    expect(reconcileTabs(pages)).toEqual(reconcileTabs(pages, X_NETWORK_PROFILE.browser!.tabs));
    expect(reconcileTabs(pages).adopt.NOTIFICATIONS).toBeDefined();
  });

  it('claims another network’s tab by that network’s own pages', () => {
    const activity = page('https://example.test/activity');
    const result = reconcileTabs([activity], elsewhere);
    expect(result.adopt.NOTIFICATIONS).toBe(activity.id);
  });

  it('does not mistake an X page for that network’s, nor the reverse', () => {
    const x = page('https://x.com/notifications');
    expect(reconcileTabs([x], elsewhere).adopt.NOTIFICATIONS).toBeUndefined();
    const theirs = page('https://example.test/activity');
    expect(reconcileTabs([theirs]).adopt.NOTIFICATIONS).toBeUndefined();
  });

  it('opens only the roles that network uses', () => {
    expect(reconcileTabs([], elsewhere).create).toEqual(['ACTION', 'NOTIFICATIONS']);
    expect(reconcileTabs([]).create).toEqual(['ACTION', 'MENTIONS', 'NOTIFICATIONS', 'RESEARCH']);
  });

  it('lets a spare untagged page on the network become the action tab', () => {
    const spare = page('https://example.test/home');
    expect(reconcileTabs([spare], elsewhere).adopt.ACTION).toBe(spare.id);
    // And never a page on a different site.
    expect(reconcileTabs([page('https://x.com/home')], elsewhere).adopt.ACTION).toBeUndefined();
  });

  it('still never claims or closes a sign-in, whichever network it is', () => {
    const login = page('https://example.test/login');
    const result = reconcileTabs([login], elsewhere);
    expect(result.close).toEqual([]);
    expect(result.keep.map((kept) => kept.id)).toEqual([login.id]);
  });
});

describe('public screenshots are refused for every network the engine knows', () => {
  it.each(['https://x.com/a/status/1', 'https://mobile.twitter.com/a', 'https://t.co/abc'])('refuses %s', (url) => {
    expect(screenshotUrlAllowed(url)).toBe(false);
  });

  it('allows an ordinary public page and still refuses lookalike hosts', () => {
    expect(screenshotUrlAllowed('https://example.test/release')).toBe(true);
    // A host that merely ends in the same letters is not a subdomain of it.
    expect(screenshotUrlAllowed('https://notx.com/a')).toBe(true);
    expect(screenshotUrlAllowed('https://x.com.example.test/a')).toBe(true);
  });

  it('takes the refused hosts from the profiles rather than from a list of its own', () => {
    const hosts: readonly string[] = X_NETWORK_PROFILE.refusedCaptureHosts;
    expect(hosts.length).toBeGreaterThan(0);
    for (const host of hosts) expect(screenshotUrlAllowed(`https://${host}/a`)).toBe(false);
  });
});
