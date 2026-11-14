import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_POLICY, PolicyConfig } from '@xbam/shared/contracts';

type Linked = { ok: false; why: string } | { where: { origin: string; unsafeDev: boolean } };
let linked: Linked = { ok: false, why: 'This installation is not linked to Studio.' };
vi.mock('../../packages/runtime/src/studioLink', () => ({ studioLinkedContext: async () => linked }));

interface Home { url: string | null; stale: boolean; confirmed: { published: boolean; paper?: boolean; origin: string; slug: string } | null }
const origin = 'https://studio.example.invalid';
let home: Home = { url: null, stale: false, confirmed: null };
vi.mock('../../packages/runtime/src/studioPublicHome', () => ({ publicHomeState: async () => home }));

const { recordLinkUrl, studioRecordLink, checkRecordLinkText, paperRecordSendText, RECORD_LINK_PREFIX } = await import('../../packages/runtime/src/studioRecordLink');
const { PAPER_IDEA_SOURCE } = await import('../../packages/runtime/src/studioPaperVoice');

const link = `${origin}/a/my-agent`;
const body = 'Simulated paper trading from AI17Z Studio, 2026-11-01 to 2026-11-07: 4 paper trades.';
const policy = (studio: Record<string, unknown> = {}, output: Record<string, unknown> = {}) =>
  PolicyConfig.parse({ ...DEFAULT_POLICY, studio: { ...DEFAULT_POLICY.studio, postPaperRecord: true, linkPaperRecord: true, ...studio }, output: { ...DEFAULT_POLICY.output, ...output } });
const raw = { ideaSource: PAPER_IDEA_SOURCE };
const send = (text: string, p = policy(), r: unknown = raw) => paperRecordSendText({ agentId: 'a1', raw: r, text, policy: p });

beforeEach(() => {
  linked = { where: { origin, unsafeDev: false } };
  home = { url: link, stale: false, confirmed: { published: true, paper: true, origin, slug: 'my-agent' } };
});

describe('recordLinkUrl', () => {
  it('builds the public page only from an exact origin and a plain slug', () => {
    expect(recordLinkUrl(origin, 'my-agent')).toBe(link);
    for (const slug of ['', '../x', 'a/b', 'A', 'x?y=1', '//evil.example']) expect(recordLinkUrl(origin, slug), slug).toBeNull();
    for (const bad of ['', 'not a url', 'ftp://studio.example.invalid', `${origin}/path`]) expect(recordLinkUrl(bad, 'my-agent'), bad).toBeNull();
  });
});

describe('studioRecordLink', () => {
  it('is the linked origin page for a current publication that carries a paper snapshot', async () => {
    expect(await studioRecordLink('a1')).toBe(link);
  });

  it('is null for anything unpublished, stale, paper-less, unlinked, dev or from another origin', async () => {
    home = { ...home, url: null };
    expect(await studioRecordLink('a1')).toBeNull();
    home = { url: link, stale: true, confirmed: home.confirmed };
    expect(await studioRecordLink('a1')).toBeNull();
    home = { url: link, stale: false, confirmed: { published: true, origin, slug: 'my-agent' } };
    expect(await studioRecordLink('a1')).toBeNull();
    home = { url: link, stale: false, confirmed: { published: false, paper: true, origin, slug: 'my-agent' } };
    expect(await studioRecordLink('a1')).toBeNull();
    home = { url: 'https://evil.example/a/my-agent', stale: false, confirmed: { published: true, paper: true, origin: 'https://evil.example', slug: 'my-agent' } };
    expect(await studioRecordLink('a1')).toBeNull();
    home = { url: link, stale: false, confirmed: { published: true, paper: true, origin, slug: 'my-agent' } };
    linked = { where: { origin, unsafeDev: true } };
    expect(await studioRecordLink('a1')).toBeNull();
    linked = { ok: false, why: 'not linked' };
    expect(await studioRecordLink('a1')).toBeNull();
  });
});

describe('checkRecordLinkText', () => {
  it('accepts only the proven link as the closing line', () => {
    expect(checkRecordLinkText(`${body}\n${RECORD_LINK_PREFIX}${link}`, link)).toEqual([]);
    expect(checkRecordLinkText(body, null)).toEqual([]);
    expect(checkRecordLinkText(`${body} ${link}`, link)).not.toEqual([]);
    expect(checkRecordLinkText(`${body}\n${RECORD_LINK_PREFIX}${link}\nsee ${link}`, link)).not.toEqual([]);
    expect(checkRecordLinkText(`${body}\n${RECORD_LINK_PREFIX}https://evil.example/a/x`, link)).not.toEqual([]);
    expect(checkRecordLinkText(`${body} ${link}`, null)).not.toEqual([]);
  });
});

describe('paperRecordSendText', () => {
  it('is off by default: the text goes out unchanged', async () => {
    expect(DEFAULT_POLICY.studio.linkPaperRecord).toBe(false);
    expect(await send(body, policy({ linkPaperRecord: false }))).toBe(body);
  });

  it('closes the post with the runtime-built link when the owner opted in', async () => {
    expect(await send(body)).toBe(`${body}\n${RECORD_LINK_PREFIX}${link}`);
  });

  it('leaves the link off, keeping the summary, when there is no confirmed publication', async () => {
    home = { url: null, stale: false, confirmed: null };
    expect(await send(body)).toBe(body);
  });

  it('leaves it off when the link policy forbids links, the dates are missing or it does not fit', async () => {
    expect(await send(body, policy({}, { forbidLinks: true }))).toBe(body);
    const undated = 'Simulated paper trading from AI17Z Studio: 4 paper trades.';
    expect(await send(undated)).toBe(undated);
    expect(await send(body, policy({}, { maxCharacters: body.length + 5 }))).toBe(body);
  });

  it('holds a link the model wrote, whether or not the feature is on', async () => {
    await expect(send(`${body} ${link}`)).rejects.toMatchObject({ reason: 'paper_record_link' });
    await expect(send(`${body} ${link}`, policy({ linkPaperRecord: false }))).rejects.toMatchObject({ reason: 'paper_record_link' });
    await expect(send(`${body} https://evil.example/records/1`)).rejects.toMatchObject({ reason: 'paper_record_link' });
    home = { url: null, stale: false, confirmed: null };
    await expect(send(`${body} ${link}`)).rejects.toMatchObject({ reason: 'paper_record_link' });
  });

  it('never touches a post that is not made from the paper record', async () => {
    const other = `Something else ${link}`;
    expect(await send(other, policy(), { ideaSource: 'something_else' })).toBe(other);
    expect(await send(body, policy(), null)).toBe(body);
  });

  it('sends text that already ends with the proven closing line once, unchanged', async () => {
    const closed = `${body}
${RECORD_LINK_PREFIX}${link}`;
    expect(await send(closed)).toBe(closed);
    expect(await send(closed, policy({ linkPaperRecord: false }))).toBe(closed);
  });

  it('still holds any other link, or the proven one anywhere but the closing line', async () => {
    await expect(send(`${body}
${RECORD_LINK_PREFIX}https://evil.example/a/x`)).rejects.toMatchObject({ reason: 'paper_record_link' });
    await expect(send(`${body}
${RECORD_LINK_PREFIX}${link}
see ${link}`)).rejects.toMatchObject({ reason: 'paper_record_link' });
    home = { url: null, stale: false, confirmed: null };
    await expect(send(`${body}
${RECORD_LINK_PREFIX}${link}`)).rejects.toMatchObject({ reason: 'paper_record_link' });
  });

  it('runs the whole validator on the text with the link added, and holds a failure for review', async () => {
    const strict = policy({}, { bannedPhrases: ['paper record'] });
    // The body passes alone; only the appended line contains the phrase.
    await expect(send(body, strict)).rejects.toMatchObject({ reason: 'paper_record_invalid' });
    expect(await send(body, policy({}, { bannedPhrases: ['nothing like this'] }))).toBe(`${body}
${RECORD_LINK_PREFIX}${link}`);
  });
});
