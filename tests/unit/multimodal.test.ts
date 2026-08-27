import { describe, expect, it } from 'vitest';
import { MediaPolicy, type MediaInventory } from '@xbam/shared/contracts';
import { decideLink, mediaCarriesTheSubstance, textCarriesTheQuestion } from '@xbam/runtime';
import { linksInText, upgradeImageUrl } from '@xbam/channels';
import { renderLinks, renderMedia, renderQuoted } from '@xbam/prompts';

const inventory = (over: Partial<MediaInventory> = {}): MediaInventory => ({
  media: [],
  quoted: null,
  links: [],
  ...over,
});

const image = (position = 0) => ({
  kind: 'image' as const,
  position,
  sourceUrl: `https://pbs.twimg.com/media/x${position}?format=jpg&name=small`,
  altText: null,
  meta: {},
});

describe('deciding whether the text is the whole message', () => {
  it('treats a substantial post as standing on its own', () => {
    expect(
      textCarriesTheQuestion('I still think the distribution schedule is the weak point here, whatever they announce.'),
    ).toBe(true);
  });

  it('treats a bare prompt as meaning the substance is elsewhere', () => {
    expect(textCarriesTheQuestion('thoughts?')).toBe(false);
    expect(textCarriesTheQuestion('@someone what do you think')).toBe(false);
  });

  it('does not count mentions and links as content', () => {
    expect(textCarriesTheQuestion('@a @b @c @d @e https://example.com/very/long/path')).toBe(false);
  });
});

describe('deciding whether unread media matters', () => {
  it('says it matters when a short post carries an image', () => {
    expect(mediaCarriesTheSubstance('thoughts?', inventory({ media: [image()] }))).toBe(true);
  });

  it('says it does not when the post explains itself', () => {
    const text = 'Here is the updated distribution chart, which shows the unlock schedule moving out two quarters.';
    expect(mediaCarriesTheSubstance(text, inventory({ media: [image()] }))).toBe(false);
  });

  it('counts a quoted post as substance, since it often is the message', () => {
    expect(
      mediaCarriesTheSubstance(
        'this',
        inventory({ quoted: { remoteId: '1', remoteUrl: null, authorHandle: 'alice', text: 'the real point', media: [] } }),
      ),
    ).toBe(true);
  });

  it('is not triggered by a post with nothing attached', () => {
    expect(mediaCarriesTheSubstance('thoughts?', inventory())).toBe(false);
  });
});

describe('link policy', () => {
  const policy = (over: Partial<MediaPolicy> = {}) => MediaPolicy.parse(over);

  it('never opens anything when told not to', () => {
    expect(decideLink('https://example.com/a', policy({ linkPolicy: 'IGNORE_LINKS' })).resolution).toBe('ignored');
  });

  it('refuses a domain that is not on the list', () => {
    const decision = decideLink(
      'https://elsewhere.example/a',
      policy({ linkPolicy: 'ALWAYS_RESOLVE_ALLOWED_DOMAINS', allowedLinkDomains: ['docs.example.com'] }),
    );
    expect(decision.resolution).toBe('refused');
    expect(decision.reason).toMatch(/not on this agent's allowed list/i);
  });

  it('allows a subdomain of an allowed domain, and not a lookalike', () => {
    const p = policy({ linkPolicy: 'ALWAYS_RESOLVE_ALLOWED_DOMAINS', allowedLinkDomains: ['example.com'] });
    expect(decideLink('https://docs.example.com/a', p).resolution).toBe('metadata_only');
    // The classic mistake: endsWith('example.com') would let this through.
    expect(decideLink('https://notexample.com/a', p).resolution).toBe('refused');
  });

  it('refuses something that is not a URL rather than throwing', () => {
    expect(decideLink('not a url', policy()).resolution).toBe('refused');
  });
});

describe('reading X media out of post text', () => {
  it('asks for the full-size image rather than the thumbnail', () => {
    expect(upgradeImageUrl('https://pbs.twimg.com/media/abc?format=jpg&name=small')).toContain('name=large');
  });

  it('leaves a URL it does not recognise alone', () => {
    expect(upgradeImageUrl('not a url')).toBe('not a url');
  });

  it('finds links and ignores the platform shortener', () => {
    const links = linksInText('see https://example.com/report and https://t.co/abcdef');
    expect(links).toEqual(['https://example.com/report']);
  });

  it('strips trailing punctuation from a link at the end of a sentence', () => {
    expect(linksInText('read this https://example.com/a.')).toEqual(['https://example.com/a']);
  });
});

describe('telling the model what is attached', () => {
  it('numbers items so "the second image" can be resolved', () => {
    const rendered = renderMedia([
      { kind: 'image', position: 0, description: 'A line chart.', extractedText: null, altText: null, status: 'analyzed', confidence: 0.7 },
      { kind: 'image', position: 1, description: 'A table of figures.', extractedText: null, altText: null, status: 'analyzed', confidence: 0.7 },
    ]);
    expect(rendered).toContain('image 1');
    expect(rendered).toContain('image 2');
  });

  it('marks text read out of an image as read, not as fact', () => {
    const rendered = renderMedia([
      { kind: 'image', position: 0, description: 'A chart.', extractedText: '40% unlocked', altText: null, status: 'analyzed', confidence: 0.6 },
    ]);
    expect(rendered).toMatch(/text visible in it/i);
  });

  it('says an item was not examined rather than omitting it', () => {
    const rendered = renderMedia([
      { kind: 'image', position: 0, description: null, extractedText: null, altText: null, status: 'skipped', confidence: null },
    ]);
    expect(rendered).toMatch(/not examined/i);
  });

  it('falls back to the author\'s own alt text when nothing looked at it', () => {
    const rendered = renderMedia([
      { kind: 'image', position: 0, description: null, extractedText: null, altText: 'unlock schedule', status: 'skipped', confidence: null },
    ]);
    expect(rendered).toContain('unlock schedule');
    expect(rendered).toMatch(/not otherwise examined/i);
  });

  it('renders a quoted post as somebody else speaking', () => {
    const rendered = renderQuoted({ authorHandle: 'projectq', text: 'Announcing the new schedule.', mediaSummary: '1 attached image' });
    expect(rendered).toContain('@projectq wrote:');
    expect(rendered).toContain('1 attached image');
  });

  it('says a link was not opened rather than implying it was read', () => {
    const rendered = renderLinks([{ url: 'https://example.com/a', title: null, summary: null, resolution: 'ignored' }]);
    expect(rendered).toMatch(/not opened/i);
  });

  it('renders nothing at all when there is nothing attached', () => {
    expect(renderMedia([])).toBe('');
    expect(renderQuoted(null)).toBe('');
    expect(renderLinks([])).toBe('');
  });
});
