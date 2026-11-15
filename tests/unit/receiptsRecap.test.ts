import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DEFAULT_POLICY, PolicyConfig } from '@xbam/shared/contracts';

type FileAnswer = { ok: true; status: number; bytes: Uint8Array | null; contentType: string | null } | { ok: false; why: string };
let answer: FileAnswer = { ok: false, why: 'unset' };
const sent: Array<{ path: string; json: unknown }> = [];
import { vi } from 'vitest';
vi.mock('../../packages/runtime/src/studioLink', () => ({
  studioInstallationFile: async (path: string, json: unknown) => { sent.push({ path, json }); return answer; },
}));

const { recapFrom, recapText, checkRecapText, receiptsRecapImagePayload, ReceiptsRecapImageRequest, RECEIPTS_RECAP_IMAGE_PATH } =
  await import('../../packages/runtime/src/receiptsRecap');
const { requestReceiptsRecapImage } = await import('../../packages/runtime/src/receiptsRecapImage');

const fixture = JSON.parse(readFileSync(new URL('../fixtures/studioReceiptsRecapImage.json', import.meta.url), 'utf8')) as Record<string, any>;
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
const mint = 'So11111111111111111111111111111111111111112';
const window = { start: new Date('2026-11-08T12:00:00.000Z'), end: new Date('2026-11-15T12:00:00.000Z') };
const obs = (value: number, at: string) => ({ value, source: 'solana_tokens.jupiter', observedAt: at, definition: 'd' });
const row = (executed: string, predicate: string, atPost: number, now: number | null, verdict: 'changed' | 'unchanged' | 'unavailable' | null, at: string, nowAt = at) => ({
  executed_at: executed, status: now === null ? 'skipped' : 'offered', verdict,
  evidence: { watch: { chain: 'solana', address: mint, predicate, threshold: 100 }, after: obs(atPost, at) },
  now_read: now === null ? null : obs(now, nowAt),
}) as never;
const rows = [
  row('2026-11-14T10:00:00.000Z', 'liquidity_below', 45, null, null, '2026-11-14T09:59:30.000Z'),
  row('2026-11-09T09:00:00.000Z', 'liquidity_below', 50, 30, 'changed', '2026-11-09T08:59:40.000Z', '2026-11-10T09:01:10.000Z'),
  row('2026-11-11T15:30:00.000Z', 'concentration_above', 60, 60, 'unchanged', '2026-11-11T15:29:50.000Z', '2026-11-12T15:31:00.000Z'),
];

beforeEach(() => { sent.length = 0; answer = { ok: false, why: 'unset' }; });

describe('weekly receipts recap', () => {
  it('counts every published signal, keeps the order posted and never ranks by outcome', () => {
    const recap = recapFrom(rows, window);
    expect(recap).toMatchObject({ n: 3, readings_taken: 2, changed: 1, unchanged: 1, without_reading: 1 });
    expect(recap.rows.map(r => r.posted_at)).toEqual(['2026-11-09T09:00:00.000Z', '2026-11-11T15:30:00.000Z', '2026-11-14T10:00:00.000Z']);
    expect(recap.rows[2]!.after_24h).toMatchObject({ value: null, state: 'not_read' });
  });

  it('says n = and the window, with counts only and no outcome words', () => {
    const text = recapText(recapFrom(rows, window));
    expect(text).toContain('n = 3');
    expect(text).toContain('2026-11-08 to 2026-11-15');
    expect(text).toMatch(/no reading: 1/);
    expect(checkRecapText(text, recapFrom(rows, window))).toEqual([]);
    expect(recapText(recapFrom(rows.slice(0, 1), window))).toContain('n = 1 radar signal posted');
  });

  it('refuses a rewrite that drops the sample size or states an outcome, a rate, a ranking or a link', () => {
    const recap = recapFrom(rows, window);
    const good = recapText(recap);
    expect(checkRecapText(good.replace('n = 3', 'three'), recap).join(' ')).toMatch(/sample size/);
    for (const bad of ['Win rate 66%.', 'Best call of the week.', 'Net profit across them.', 'We were right twice.', 'Details https://example.invalid/x']) {
      expect(checkRecapText(`${good} ${bad}`, recap).length, bad).toBeGreaterThan(0);
    }
  });

  it('is off by default', () => {
    expect(DEFAULT_POLICY.studio.postReceiptsRecap).toBe(false);
    expect(DEFAULT_POLICY.studio.receiptsRecapImage).toBe(false);
    expect(PolicyConfig.parse({}).studio.receiptsRecapImage).toBe(false);
  });
});

describe('frozen receipts recap image payload', () => {
  it('is exactly the shared fixture', () => {
    expect(ReceiptsRecapImageRequest.parse(fixture)).toEqual(fixture);
    expect(receiptsRecapImagePayload(recapFrom(rows, window), new Date('2026-11-15T12:00:00.000Z'))).toEqual(fixture);
  });

  it('pins the exact key set at every level', () => {
    expect(Object.keys(fixture).sort()).toEqual(['changed', 'disclaimer', 'n', 'protocol', 'readings_taken', 'requested_at', 'rows', 'unchanged', 'window', 'without_reading']);
    expect(Object.keys(fixture.rows[0]).sort()).toEqual(['address', 'after_24h', 'at_post', 'chain', 'posted_at', 'predicate']);
    expect(Object.keys(fixture.rows[0].after_24h).sort()).toEqual(['observed_at', 'source', 'state', 'value']);
  });

  it('fails on any extra field, any depth, and on counts that do not add up or drop a signal', () => {
    const extras: Array<[string, (c: any) => void]> = [
      ['post text', c => { c.text = 'hello'; }], ['handle', c => { c.rows[0].handle = 'alice'; }],
      ['agent id', c => { c.agent_id = 'x'; }], ['win rate', c => { c.win_rate = 0.5; }], ['pnl', c => { c.rows[0].pnl = 3; }],
      ['counts wrong', c => { c.changed = 2; }], ['row dropped', c => { c.rows.pop(); }],
    ];
    for (const [name, mutate] of extras) {
      const copy = structuredClone(fixture);
      mutate(copy);
      expect(ReceiptsRecapImageRequest.safeParse(copy).success, name).toBe(false);
    }
  });

  it('stays text for a week the picture cannot carry in full, rather than sampling', () => {
    const many = Array.from({ length: 25 }, (_, i) => row(`2026-11-09T${String(i % 24).padStart(2, '0')}:00:00.000Z`, 'liquidity_below', 50, 30, 'changed', '2026-11-09T08:59:40.000Z'));
    expect(receiptsRecapImagePayload(recapFrom(many, window))).toBeNull();
    expect(receiptsRecapImagePayload(recapFrom([], window))).toBeNull();
  });

  it('sends only the frozen payload to the installation path, and treats a non-image as no picture', async () => {
    const payload = receiptsRecapImagePayload(recapFrom(rows, window))!;
    answer = { ok: true, status: 200, bytes: PNG, contentType: 'image/png' };
    expect((await requestReceiptsRecapImage(payload)).ok).toBe(true);
    expect(sent[0]!.path).toBe(RECEIPTS_RECAP_IMAGE_PATH);
    expect(RECEIPTS_RECAP_IMAGE_PATH).toBe('/api/v1/installation/receipts-recap-image');
    expect(await requestReceiptsRecapImage({ ...payload, text: 'x' } as never)).toMatchObject({ ok: false });
    for (const a of [{ ok: false, why: 'down' }, { ok: true, status: 500, bytes: PNG, contentType: 'image/png' },
      { ok: true, status: 200, bytes: Buffer.from('<html></html>'), contentType: 'image/png' }] as FileAnswer[]) {
      answer = a;
      expect((await requestReceiptsRecapImage(payload)).ok).toBe(false);
    }
  });
});
