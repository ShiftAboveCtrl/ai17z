import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { DEFAULT_POLICY, PolicyConfig } from '@xbam/shared/contracts';
import type { HolderMapView } from '@xbam/prompts';

type FileAnswer = { ok: true; status: number; bytes: Uint8Array | null; contentType: string | null } | { ok: false; why: string };
let answer: FileAnswer = { ok: false, why: 'unset' };
const sent: Array<{ path: string; json: unknown }> = [];
vi.mock('../../packages/runtime/src/studioLink', () => ({
  studioInstallationFile: async (path: string, json: unknown) => { sent.push({ path, json }); return answer; },
}));

const { HolderMapImageRequest, holderMapImagePayload, requestEvidenceCardImage, EVIDENCE_CARD_IMAGE_PATH } =
  await import('../../packages/runtime/src/studioEvidenceCardImage');

const fixture = JSON.parse(readFileSync(new URL('../fixtures/studioHolderMapImage.json', import.meta.url), 'utf8')) as Record<string, any>;
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));

const view: HolderMapView = {
  mint: fixture.address, readAt: fixture.read_at, source: fixture.source, notRead: fixture.not_read,
  holders: fixture.holders.map((h: any) => ({ address: h.address, percent: h.percent, funding: h.funding, group: h.group, readAt: h.read_at })),
  groups: [{ id: 'g1', size: 2 }],
};
beforeEach(() => { sent.length = 0; answer = { ok: false, why: 'unset' }; });

describe('frozen holder-map payload', () => {
  it('is exactly the shared fixture', () => {
    expect(HolderMapImageRequest.parse(fixture)).toEqual(fixture);
    expect(holderMapImagePayload(view, new Date(fixture.requested_at))).toEqual(fixture);
  });

  it('pins the exact key set, so a new field is a deliberate change to this test', () => {
    expect(Object.keys(fixture).sort()).toEqual(['address', 'chain', 'disclaimer', 'exclusion_line', 'holders', 'kind', 'not_read', 'palette', 'protocol', 'read_at', 'reading_line', 'requested_at', 'service_line', 'source']);
    expect(Object.keys(fixture.holders[0]).sort()).toEqual(['address', 'funding', 'group', 'percent', 'read_at']);
  });

  it('fails when any field outside the schema appears, at any depth', () => {
    const extras: Array<[string, (c: any) => void]> = [
      ['post body', c => { c.text = 'hey @agent check this'; }],
      ['handle', c => { c.handle = 'alice'; }],
      ['asker', c => { c.asker = { id: '1' }; }],
      ['job id', c => { c.job_id = 'abc'; }],
      ['agent id', c => { c.agent_id = 'abc'; }],
      ['funding address', c => { c.holders[0].funding_address = 'x'; }],
      ['holder label', c => { c.holders[0].label = 'insider'; }],
      ['a colour', c => { c.holders[0].color = 'red'; }],
      ['a danger palette', c => { c.palette = 'warning'; }],
      ['a changed reading line', c => { c.reading_line = 'These accounts have one owner.'; }],
      ['a changed disclaimer', c => { c.disclaimer = 'safe'; }],
      ['another chain', c => { c.chain = 'ethereum'; }],
    ];
    for (const [name, mutate] of extras) {
      const copy = structuredClone(fixture);
      mutate(copy);
      expect(HolderMapImageRequest.safeParse(copy).success, name).toBe(false);
    }
  });

  it('refuses shapes that would misdraw a reading', () => {
    const bad: Array<[string, (c: any) => void]> = [
      ['more than twelve accounts', c => { c.holders = Array.from({ length: 13 }, (_, i) => ({ ...fixture.holders[1], address: `${'A'.repeat(40)}${'BCDEFGHJKLMNP'[i]}QQQ` })); }],
      ['a group id on a single account', c => { c.holders[1].group = 'g1'; }],
      ['grouped without a group id', c => { c.holders[0].group = null; }],
      ['a group of one', c => { c.holders[2].funding = 'single'; c.holders[2].group = null; }],
      ['an unread account also drawn', c => { c.not_read = [c.holders[0].address]; }],
      ['a negative percent', c => { c.holders[0].percent = -1; }],
      ['a null percent (an unread figure is listed, not drawn)', c => { c.holders[0].percent = null; }],
      ['no accounts at all', c => { c.holders = []; }],
      ['duplicate accounts', c => { c.holders[1].address = c.holders[0].address; }],
    ];
    for (const [name, mutate] of bad) {
      const copy = structuredClone(fixture);
      mutate(copy);
      expect(HolderMapImageRequest.safeParse(copy).success, name).toBe(false);
    }
  });

  it('gives nothing to draw when no account has a read percent', () => {
    expect(holderMapImagePayload({ ...view, holders: [], groups: [] })).toBeNull();
  });

  it('has its own owner switch, off by default and separate from the card picture', () => {
    expect(DEFAULT_POLICY.tools.holderMap).toBe(false);
    const on = PolicyConfig.parse({ ...DEFAULT_POLICY, tools: { ...DEFAULT_POLICY.tools, holderMap: true } });
    expect(on.tools.holderMap).toBe(true);
    expect(on.tools.evidenceCardImage).toBe(false);
  });
});

describe('requestEvidenceCardImage with the holder-map kind', () => {
  it('sends the same path and only the frozen payload, and accepts an image', async () => {
    answer = { ok: true, status: 200, bytes: PNG, contentType: 'image/png' };
    expect((await requestEvidenceCardImage(HolderMapImageRequest.parse(fixture))).ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.path).toBe(EVIDENCE_CARD_IMAGE_PATH);
    expect(HolderMapImageRequest.parse(sent[0]!.json)).toEqual(sent[0]!.json);
  });

  it('refuses to send a widened or reworded map', async () => {
    expect((await requestEvidenceCardImage({ ...HolderMapImageRequest.parse(fixture), text: 'a post body' } as never)).ok).toBe(false);
    expect((await requestEvidenceCardImage({ ...HolderMapImageRequest.parse(fixture), palette: 'warning' } as never)).ok).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('treats everything but a still image as no picture', async () => {
    const cases: FileAnswer[] = [
      { ok: false, why: 'unreachable' },
      { ok: true, status: 500, bytes: PNG, contentType: 'image/png' },
      { ok: true, status: 200, bytes: Buffer.from('<html>ok</html>'), contentType: 'image/png' },
      { ok: true, status: 200, bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), contentType: 'image/svg+xml' },
    ];
    for (const c of cases) {
      answer = c;
      expect((await requestEvidenceCardImage(HolderMapImageRequest.parse(fixture))).ok).toBe(false);
    }
  });
});
