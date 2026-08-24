import { describe, expect, it } from 'vitest';
import {
  buildStatusUrl,
  extractStatusId,
  handleFromUrl,
  looksUnavailable,
  normalizeHandle,
  normalizeTargetId,
} from '@xbam/channels';

/**
 * Target normalisation anchors every dedupe key, so these are exactly the cases
 * that would otherwise let the same reply be posted twice.
 */
describe('normalizeTargetId', () => {
  it('collapses every spelling of the same post to one canonical URL', () => {
    const canonical = 'https://x.com/someone/status/1234567890123';
    const variants = [
      canonical,
      'http://x.com/someone/status/1234567890123',
      'https://twitter.com/someone/status/1234567890123',
      'https://www.twitter.com/someone/status/1234567890123?s=20&t=abc',
      'https://mobile.twitter.com/someone/status/1234567890123#anchor',
      'x.com/someone/status/1234567890123/photo/1',
      'https://x.com/someone/status/1234567890123/',
    ];
    for (const variant of variants) {
      expect(normalizeTargetId(variant), variant).toBe(canonical);
    }
  });

  it('turns a bare numeric id into a resolvable URL', () => {
    expect(normalizeTargetId('1234567890123')).toBe('https://x.com/i/status/1234567890123');
  });

  it('refuses anything that is not an X status', () => {
    for (const bad of ['', null, undefined, 'not a url', 'https://example.com/status/123', 'https://x.com/someone']) {
      expect(normalizeTargetId(bad)).toBeNull();
    }
  });
});

describe('extractStatusId', () => {
  it('reads the id from every accepted form', () => {
    expect(extractStatusId('https://x.com/a/status/999888777666')).toBe('999888777666');
    expect(extractStatusId('999888777666')).toBe('999888777666');
    expect(extractStatusId('https://x.com/a')).toBeNull();
    expect(extractStatusId(null)).toBeNull();
  });
});

describe('buildStatusUrl', () => {
  it('always produces a navigable URL when an id can be found', () => {
    expect(buildStatusUrl('123456789')).toBe('https://x.com/i/status/123456789');
    expect(buildStatusUrl('https://twitter.com/a/status/123456789?x=1')).toBe('https://x.com/a/status/123456789');
    expect(buildStatusUrl('nonsense')).toBeNull();
  });
});

describe('handles', () => {
  it('normalises and validates handles', () => {
    expect(normalizeHandle('@Someone')).toBe('someone');
    expect(normalizeHandle('  UPPER_case ')).toBe('upper_case');
    expect(normalizeHandle('has spaces')).toBeNull();
    expect(normalizeHandle('waytoolongforahandlebyfar')).toBeNull();
  });

  it('extracts the author from a status URL', () => {
    expect(handleFromUrl('https://x.com/jack/status/123456')).toBe('jack');
    expect(handleFromUrl(null)).toBeNull();
  });
});

describe('looksUnavailable', () => {
  it('recognises the deleted-post copy X actually shows', () => {
    expect(looksUnavailable('Hmm...this page doesn t exist. Try searching for something else.')).toBe(true);
    expect(looksUnavailable('This Post was deleted by the Post author.')).toBe(true);
    expect(looksUnavailable('A perfectly normal post body')).toBe(false);
  });
});
