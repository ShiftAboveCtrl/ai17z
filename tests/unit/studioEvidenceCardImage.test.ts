import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { DEFAULT_POLICY, PolicyConfig } from '@xbam/shared/contracts';
import type { CardReading } from '@xbam/prompts';

type FileAnswer = { ok: true; status: number; bytes: Uint8Array | null; contentType: string | null } | { ok: false; why: string };
let answer: FileAnswer = { ok: false, why: 'unset' };
const sent: Array<{ path: string; json: unknown; limits: { timeoutMs: number; maxBytes: number } }> = [];
vi.mock('../../packages/runtime/src/studioLink', () => ({
  studioInstallationFile: async (path: string, json: unknown, limits: { timeoutMs: number; maxBytes: number }) => {
    sent.push({ path, json, limits });
    return answer;
  },
}));

const { EvidenceCardImageRequest, evidenceCardImagePayload, requestEvidenceCardImage, EVIDENCE_CARD_IMAGE_PATH } =
  await import('../../packages/runtime/src/studioEvidenceCardImage');

const fixture = JSON.parse(readFileSync(new URL('../fixtures/studioEvidenceCardImage.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
const mint = 'So11111111111111111111111111111111111111112';
const readings: CardReading[] = ([
  ['Liquidity', 12000, 'USD'], ['Top holders', 20, '%'], ['Mint authority', true, 'authority'], ['Freeze authority', false, 'authority'], ['Pool age', 1, 'hours'],
] as const).map(([label, value, unit]) => ({ label, value, unit, source: 'solana_tokens.jupiter', fetchedAt: '2026-11-14T11:59:30.000Z',
  observedAt: '2026-11-14T11:59:20.000Z', maxAgeMs: 300_000 }));

beforeEach(() => { sent.length = 0; answer = { ok: false, why: 'unset' }; });

describe('frozen evidence card image payload', () => {
  it('is exactly the shared fixture', () => {
    expect(EvidenceCardImageRequest.parse(fixture)).toEqual(fixture);
    expect(evidenceCardImagePayload({ chain: 'solana', address: mint, readings, now: new Date('2026-11-14T12:00:00.000Z') })).toEqual(fixture);
  });

  it('fails when any field outside the schema appears, at any depth', () => {
    const extras: Array<[string, (c: any) => void]> = [
      ['post body', c => { c.text = 'hey @agent check this'; }],
      ['handle', c => { c.handle = 'alice'; }],
      ['asker data', c => { c.asker = { id: '1', handle: 'alice' }; }],
      ['job id', c => { c.job_id = 'abc'; }],
      ['agent id', c => { c.agent_id = 'abc'; }],
      ['reading field', c => { c.readings[0].note = 'free text'; }],
      ['reading label outside the card', c => { c.readings[0].label = 'Price'; }],
    ];
    for (const [name, mutate] of extras) {
      const copy = structuredClone(fixture);
      mutate(copy);
      expect(EvidenceCardImageRequest.safeParse(copy).success, name).toBe(false);
    }
  });

  it('pins the exact key set, so a new field is a deliberate change to this test', () => {
    expect(Object.keys(fixture).sort()).toEqual(['address', 'chain', 'disclaimer', 'protocol', 'readings', 'requested_at']);
    expect(Object.keys((fixture.readings as object[])[0]!).sort()).toEqual(['fetched_at', 'label', 'max_age_ms', 'observed_at', 'source', 'unit', 'value']);
  });

  it('refuses a card Studio cannot draw: another chain, a malformed address, a changed disclaimer, no readings', () => {
    expect(evidenceCardImagePayload({ chain: 'base', address: `0x${'1'.repeat(40)}`, readings })).toBeNull();
    expect(evidenceCardImagePayload({ chain: 'solana', address: `https://evil.example/${mint}`, readings })).toBeNull();
    expect(evidenceCardImagePayload({ chain: 'solana', address: mint, readings: [] })).toBeNull();
    expect(EvidenceCardImageRequest.safeParse({ ...fixture, disclaimer: 'safe' }).success).toBe(false);
    expect(evidenceCardImagePayload({ chain: 'solana', address: mint, readings: [{ ...readings[0]!, label: 'Verdict' }] })).toBeNull();
  });

  it('leaves LP readings off the picture and still yields the frozen payload', () => {
    const lp: CardReading[] = ['LP burned', 'LP locked', 'LP status'].map(label => ({
      label, value: 10, unit: '%' as const, source: 'solana_lp', fetchedAt: '2026-11-14T11:59:30.000Z',
      observedAt: '2026-11-14T11:59:20.000Z', maxAgeMs: 300_000,
    }));
    const payload = evidenceCardImagePayload({ chain: 'solana', address: mint, readings: [...readings, ...lp], now: new Date('2026-11-14T12:00:00.000Z') });
    expect(payload).toEqual(fixture);
    expect(payload?.readings.map(r => r.label)).toEqual(['Liquidity', 'Top holders', 'Mint authority', 'Freeze authority', 'Pool age']);
    // A card made only of LP lines has nothing Studio can draw.
    expect(evidenceCardImagePayload({ chain: 'solana', address: mint, readings: lp })).toBeNull();
  });

  it('lowercases an EVM address so one token has one card', () => {
    const p = evidenceCardImagePayload({ chain: 'ethereum', address: '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01', readings });
    expect(p?.address).toBe('0xabcdef0123456789abcdef0123456789abcdef01');
  });

  it('is off by default and parses when on', () => {
    expect(DEFAULT_POLICY.tools.evidenceCardImage).toBe(false);
    expect(PolicyConfig.parse({ ...DEFAULT_POLICY, tools: { ...DEFAULT_POLICY.tools, evidenceCardImage: true } }).tools.evidenceCardImage).toBe(true);
  });
});

describe('requestEvidenceCardImage', () => {
  const payload = () => evidenceCardImagePayload({ chain: 'solana', address: mint, readings })!;

  it('sends only the frozen payload to the installation path with a short deadline and a size cap', async () => {
    answer = { ok: true, status: 200, bytes: PNG, contentType: 'image/png' };
    expect((await requestEvidenceCardImage(payload())).ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.path).toBe('/api/v1/installation/evidence-card-image');
    expect(sent[0]!.path).toBe(EVIDENCE_CARD_IMAGE_PATH);
    expect(EvidenceCardImageRequest.parse(sent[0]!.json)).toEqual(sent[0]!.json);
    expect(sent[0]!.limits.timeoutMs).toBeLessThanOrEqual(10_000);
    expect(sent[0]!.limits.maxBytes).toBeLessThanOrEqual(2_000_000);
  });

  it('refuses to send a widened object', async () => {
    const wide = { ...payload(), text: 'a post body' } as never;
    expect((await requestEvidenceCardImage(wide)).ok).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('treats everything but a still image as no picture, by its bytes and not its content type', async () => {
    const cases: FileAnswer[] = [
      { ok: false, why: 'Studio could not be reached.' },
      { ok: true, status: 500, bytes: PNG, contentType: 'image/png' },
      { ok: true, status: 200, bytes: null, contentType: 'image/png' },
      { ok: true, status: 200, bytes: new Uint8Array(), contentType: 'image/png' },
      { ok: true, status: 200, bytes: Buffer.from('<html>ok</html>'), contentType: 'image/png' },
      { ok: true, status: 200, bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>'), contentType: 'image/svg+xml' },
      { ok: true, status: 200, bytes: new Uint8Array(1_600_000).fill(1), contentType: 'image/png' },
    ];
    for (const c of cases) {
      answer = c;
      expect((await requestEvidenceCardImage(payload())).ok, JSON.stringify(c).slice(0, 60)).toBe(false);
    }
  });
});
