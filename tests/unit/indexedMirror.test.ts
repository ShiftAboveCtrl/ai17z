/**
 * @release-check-fixtures
 *
 * The addresses below are invented tricks a hostile search result could carry,
 * including a user name before the host, which reads like an email address.
 */
import { describe, expect, it } from 'vitest';
import { collectIndexedMirror, indexedMirrorStatus, mirrorStatusLinks, type MirrorPageRead } from '@xbam/channels';
import { gradeEvidence, gradeTeachesVoice, mayEstablishFact, mayTriggerAction, type GradeInput } from '@xbam/shared/contracts';

const ID = '1234567890123456789';

describe('which addresses are a mirror page for one post', () => {
  it('accepts twstalker.com and every subdomain of it as one family', () => {
    for (const host of ['twstalker.com', 'www.twstalker.com', 'www6.twstalker.com', 'platform.twstalker.com']) {
      const link = indexedMirrorStatus(`https://${host}/somebody/status/${ID}?utm_source=x#top`);
      expect(link?.family, host).toBe('TWSTALKER');
      expect(link?.url).toBe(`https://${host}/somebody/status/${ID}`);
      expect(link?.handle).toBe('somebody');
    }
  });

  it('refuses hosts that only look like it', () => {
    for (const url of [
      `https://twstalker.com.evil.io/somebody/status/${ID}`,
      `https://eviltwstalker.com/somebody/status/${ID}`,
      `https://twstalker.co/somebody/status/${ID}`,
      `https://twstalker.com./somebody/status/${ID}`,
      `https://twstalker.com@evil.io/somebody/status/${ID}`,
      `https://user:pw@twstalker.com/somebody/status/${ID}`,
      `https://twstalker.com:8443/somebody/status/${ID}`,
      `https://twstаlker.com/somebody/status/${ID}`, // Cyrillic a
      `https://evil.io/twstalker.com/somebody/status/${ID}`,
      `ftp://twstalker.com/somebody/status/${ID}`,
      'javascript:alert(1)',
    ]) {
      expect(indexedMirrorStatus(url), url).toBeNull();
    }
  });

  it('refuses a page that does not name a post and its author', () => {
    expect(indexedMirrorStatus('https://twstalker.com/somebody')).toBeNull();
    expect(indexedMirrorStatus(`https://twstalker.com/status/${ID}`)).toBeNull();
    expect(indexedMirrorStatus('https://twstalker.com/somebody/status/123')).toBeNull();
  });

  it('keeps only posts by the person asked about, once each', () => {
    const links = mirrorStatusLinks(
      [
        { url: `https://twstalker.com/Somebody/status/${ID}` },
        { url: `https://www6.twstalker.com/somebody/status/${ID}` },
        { url: `https://twstalker.com/impostor/status/1234567890123456780` },
        { url: `https://www.sotwe.com/somebody/status/1234567890123456781` },
      ],
      '@somebody',
      'TWSTALKER',
    );
    expect(links.map((l) => l.statusId)).toEqual([ID]);
  });
});

function page(articles: MirrorPageRead['articles'], challenge = false): MirrorPageRead {
  return { challenge, status: challenge ? 403 : 200, articles, detail: '' };
}

describe('search index, then the indexed page', () => {
  const results = [
    { title: 'somebody on TwStalker', snippet: 'shipping the agent memory rewrite today', url: `https://twstalker.com/somebody/status/${ID}` },
    { title: 'somebody on TwStalker', snippet: 'older take', url: 'https://www6.twstalker.com/somebody/status/1234567890123456700' },
    { title: 'somebody else', snippet: 'not them', url: 'https://twstalker.com/other/status/1234567890123456701' },
  ];

  it('records the index and the mirror as two sightings of the X post', async () => {
    const opened: string[] = [];
    const answer = await collectIndexedMirror({
      family: 'TWSTALKER',
      label: 'TwStalker',
      handle: 'somebody',
      search: async () => results,
      read: async (url) => {
        opened.push(url);
        return page([{ href: url, text: 'shipping the agent memory rewrite today, finally' }]);
      },
      maxFetches: 8,
    });
    expect(opened).toHaveLength(2);
    expect(opened.every((u) => u.startsWith('https://') && !u.includes('other'))).toBe(true);
    const keys = answer.observations.map((o) => `${o.family}:${o.objectKey}`);
    expect(keys).toContain(`SEARCH_ENGINE:x:status:${ID}`);
    expect(keys).toContain(`TWSTALKER:x:status:${ID}`);
    const copy = answer.observations.find((o) => o.family === 'TWSTALKER')!;
    expect(copy.canonicalUrl).toBe(`https://x.com/somebody/status/${ID}`);
    expect(copy.tier).toBe('PUBLIC_MIRROR');
    expect(answer.read).toBe(2);
  });

  it('stops at the first bot check and opens nothing after it', async () => {
    let opened = 0;
    const answer = await collectIndexedMirror({
      family: 'TWSTALKER',
      label: 'TwStalker',
      handle: 'somebody',
      search: async () => results,
      read: async () => {
        opened += 1;
        return page([], true);
      },
      maxFetches: 8,
    });
    expect(opened).toBe(1);
    expect(answer.challenged).toBe(true);
    expect(answer.observations.every((o) => o.family === 'SEARCH_ENGINE')).toBe(true);
  });

  it('ignores a page whose copy is of a different post or by somebody else', async () => {
    const answer = await collectIndexedMirror({
      family: 'TWSTALKER',
      label: 'TwStalker',
      handle: 'somebody',
      search: async () => results.slice(0, 1),
      read: async () =>
        page([
          { href: `https://twstalker.com/other/status/${ID}`, text: 'a copy under another name' },
          { href: 'https://twstalker.com/somebody/status/1234567890123456799', text: 'a different post' },
        ]),
      maxFetches: 8,
    });
    expect(answer.read).toBe(0);
    expect(answer.observations.filter((o) => o.family === 'TWSTALKER')).toHaveLength(0);
  });

  it('opens no more pages than it was allowed', async () => {
    let opened = 0;
    await collectIndexedMirror({
      family: 'TWSTALKER',
      label: 'TwStalker',
      handle: 'somebody',
      search: async () => results,
      read: async (url) => {
        opened += 1;
        return page([{ href: url, text: 'x' }]);
      },
      maxFetches: 1,
    });
    expect(opened).toBe(1);
  });
});

describe('evidence grades', () => {
  const base: GradeInput = {
    families: ['X'],
    disagreeing: [],
    bestTier: 'PRIMARY_PLATFORM',
    bestCompleteness: 'FULL',
    confirmedOnPlatform: true,
    author: 'somebody',
    expectedAuthor: 'somebody',
  };

  it('A is read on the platform by the right author', () => {
    expect(gradeEvidence(base).grade).toBe('A');
    expect(gradeEvidence({ ...base, disagreeing: ['TWSTALKER'] }).grade).toBe('A');
  });

  it('B is a whole mirror copy by the right author that a second family saw', () => {
    const b = { ...base, families: ['SEARCH_ENGINE', 'TWSTALKER'] as const, bestTier: 'PUBLIC_MIRROR' as const, confirmedOnPlatform: false };
    expect(gradeEvidence(b).grade).toBe('B');
    expect(gradeEvidence({ ...b, families: ['TWSTALKER'] }).grade).toBe('C');
    expect(gradeEvidence({ ...b, bestCompleteness: 'SNIPPET', bestTier: 'SEARCH_INDEX' }).grade).toBe('C');
  });

  it('D is somebody else, or copies that disagree with nothing to settle them', () => {
    expect(gradeEvidence({ ...base, author: 'impostor' }).grade).toBe('D');
    expect(
      gradeEvidence({ ...base, confirmedOnPlatform: false, bestTier: 'PUBLIC_MIRROR', families: ['SEARCH_ENGINE', 'TWSTALKER'], disagreeing: ['SOTWE'] }).grade,
    ).toBe('D');
  });

  it('only A and B teach a voice, and no grade makes a mirror a witness or a trigger', () => {
    expect(['A', 'B', 'C', 'D'].map((g) => gradeTeachesVoice(g as 'A'))).toEqual([true, true, false, false]);
    for (const tier of ['PUBLIC_MIRROR', 'SEARCH_INDEX'] as const) {
      expect(mayEstablishFact(tier)).toBe(false);
      expect(mayTriggerAction(tier)).toBe(false);
    }
  });
});
