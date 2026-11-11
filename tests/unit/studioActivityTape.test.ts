import { describe, expect, it } from 'vitest';
import { ActivityTapeBatch, projectActivity, registerActivityTapeCapability, withoutUnconsentedText } from '../../packages/runtime/src/studioActivityTape';
import { invokeCapability, getCapability } from '@xbam/tools';
import { createLogger } from '@xbam/shared';

describe('public activity allowlist', () => {
  it('is disabled unless granted and refuses a public caller even with a grant', async () => {
    registerActivityTapeCapability();
    expect(getCapability('studio.activity_tape')).toMatchObject({ audience: 'OWNER', unsetPermission: 'DISABLED' });
    const context = { agentId: '00000000-0000-4000-8000-000000000002', jobId: null, accountId: null,
      config: {}, audience: 'OWNER' as const, logger: createLogger('tape-test') };
    const options = { call: { id: 'studio.activity_tape', input: {} }, context,
      permission: { stored: null, paused: false } };
    expect((await invokeCapability(options)).outcome).toBe('REFUSED');
    expect((await invokeCapability({ ...options, context: { ...context, audience: 'PUBLIC' },
      permission: { stored: 'ALLOWED', paused: false } })).outcome).toBe('REFUSED');
  });
  it('projects only normalized fields, with no private source data', () => {
    const event = projectActivity({
      id: 'action:00000000-0000-4000-8000-000000000001',
      agent_id: '00000000-0000-4000-8000-000000000002',
      kind: 'REPLY', at: new Date('2026-11-09T10:00:00Z'), dry_run: false,
      payload: { text: 'PRIVATE', prompt: 'PRIVATE', wallet: 'PRIVATE' },
      target_ref: '@private-person', reasoning: 'PRIVATE', cookies: 'PRIVATE',
    });
    expect(event).toEqual({
      id: 'action:00000000-0000-4000-8000-000000000001',
      agent_id: '00000000-0000-4000-8000-000000000002', kind: 'REPLY',
      at: '2026-11-09T10:00:00.000Z', dry_run: false, target_handle: null,
      paper: null,
    });
    expect(JSON.stringify(event)).not.toMatch(/PRIVATE|private-person|payload|reasoning|cookies|wallet/);
  });

  it('keeps unavailable paper values null and pins simulated', () => {
    const event = projectActivity({ id: 'paper:00000000-0000-4000-8000-000000000001',
      agent_id: '00000000-0000-4000-8000-000000000002', kind: 'PAPER_FILL',
      at: new Date(), dry_run: true, size: null, asset: null });
    expect(event?.paper).toEqual({ simulated: true, size_base_units: null, asset: null, verdict: 'PAPER_FILLED' });
  });

  it.each(['bad label', '@PRIVATE', 'TOO.LONG.ASSET.LABEL', 'sol'])('redacts malformed asset label %s independently of size', (asset) => {
    const event = projectActivity({ id: 'paper:00000000-0000-4000-8000-000000000001',
      agent_id: '00000000-0000-4000-8000-000000000002', kind: 'PAPER_FILL',
      at: new Date(), dry_run: true, size: '42', asset });
    expect(event?.paper).toEqual({ simulated: true, size_base_units: '42', asset: null, verdict: 'PAPER_FILLED' });
  });

  it('refuses unknown actions and private fields in outbound batches', () => {
    expect(projectActivity({ kind: 'SIGN', secret: 'PRIVATE' })).toBeNull();
    expect(ActivityTapeBatch.safeParse({ protocol: 1, events: [], remove: [], prompt: 'PRIVATE' }).success).toBe(false);
  });

  it('refuses private fields at every outbound nesting level', () => {
    const event = projectActivity({ id: 'paper:00000000-0000-4000-8000-000000000001',
      agent_id: '00000000-0000-4000-8000-000000000002', kind: 'PAPER_FILL', at: new Date(), dry_run: true });
    for (const field of ['memories','prompt','draft','reasoning','browser_frame','cookie','credential','wallet','handle','secret']) {
      expect(ActivityTapeBatch.safeParse({ protocol: 1, events: [{ ...event, [field]: 'PRIVATE' }], remove: [] }).success, field).toBe(false);
      expect(ActivityTapeBatch.safeParse({ protocol: 1, events: [{ ...event, paper: { ...event!.paper, [field]: 'PRIVATE' } }], remove: [] }).success, field).toBe(false);
    }
  });
});

describe('verifiable posts: the link to the real post, and words only by consent', () => {
  const base = { id: 'action:00000000-0000-4000-8000-000000000001', agent_id: '00000000-0000-4000-8000-000000000002',
    kind: 'POST', at: new Date('2026-11-09T10:00:00Z'), dry_run: false,
    post_url: 'https://x.com/agentone/status/1234567890', post_remote_id: '1234567890' };

  it('carries the stored status link of a published post or reply, and nothing else new', () => {
    for (const kind of ['POST', 'REPLY']) {
      const event = projectActivity({ ...base, kind });
      expect(event).toMatchObject({ kind, dry_run: false, target_handle: null, post_url: base.post_url });
      expect(Object.keys(event!).sort()).toEqual(['agent_id', 'at', 'dry_run', 'id', 'kind', 'paper', 'post_url', 'target_handle']);
    }
  });

  it('leaves the keys out entirely when there is nothing to link, so an older receiver sees the old shape', () => {
    for (const row of [{ ...base, post_url: null, post_remote_id: null }, { ...base, post_url: undefined }]) {
      expect(Object.keys(projectActivity(row)!).sort()).toEqual(['agent_id', 'at', 'dry_run', 'id', 'kind', 'paper', 'target_handle']);
    }
  });

  it.each([
    ['a dry run', { dry_run: true }],
    ['an unknown run state', { dry_run: null }],
    ['no remote id', { post_remote_id: null }],
    ['a remote id the link does not end in', { post_remote_id: '99' }],
    ['a mock link', { post_url: 'mock://message/1234567890' }],
    ['another service', { post_url: 'https://bsky.app/profile/a/post/1234567890' }],
    ['an http link', { post_url: 'http://x.com/agentone/status/1234567890' }],
    ['a look-alike host', { post_url: 'https://x.com.evil.test/agentone/status/1234567890' }],
    ['a link with a query', { post_url: 'https://x.com/agentone/status/1234567890?s=20' }],
    ['a paper fill', { kind: 'PAPER_FILL' }],
    ['a radar hit', { kind: 'RADAR_HIT' }],
    ['a receipt', { kind: 'RECEIPT', id: 'receipt:00000000-0000-4000-8000-000000000001' }],
  ])('shows no link for %s', (_name, over) => {
    const event = projectActivity({ ...base, post_text: 'hello', ...over });
    expect(event?.post_url).toBeUndefined();
    expect(event?.post_text).toBeUndefined();
  });

  it('carries words only when they were supplied, beside the link, and bounded', () => {
    expect(projectActivity({ ...base })?.post_text).toBeUndefined();
    expect(projectActivity({ ...base, post_text: 'Shipped the new radar.' })?.post_text).toBe('Shipped the new radar.');
    expect(projectActivity({ ...base, post_text: '   ' })?.post_text).toBeUndefined();
    expect(projectActivity({ ...base, post_text: 'x'.repeat(501) })?.post_text).toBeUndefined();
    expect(projectActivity({ ...base, post_text: 'x'.repeat(500) })?.post_text).toHaveLength(500);
    expect(projectActivity({ ...base, post_text: `bad${String.fromCharCode(0)}text` })?.post_text).toBeUndefined();
    expect(projectActivity({ ...base, post_url: null, post_remote_id: null, post_text: 'orphan' })?.post_text).toBeUndefined();
  });

  it('never lets a reply name the person it was to, while target_handle stays null', () => {
    const reply = { ...base, kind: 'REPLY' };
    expect(projectActivity({ ...reply, post_text: '@someone thanks for the question' })?.post_text).toBeUndefined();
    expect(projectActivity({ ...reply, post_text: 'thanks, and cc @someone' })?.post_text).toBeUndefined();
    expect(projectActivity({ ...reply, post_text: 'write to me at a@b.example' })?.post_text).toBe('write to me at a@b.example');
    expect(projectActivity({ ...reply, post_text: '@someone thanks' })?.target_handle).toBeNull();
    expect(projectActivity({ ...base, post_text: 'thanks @someone for the review' })?.post_text).toBe('thanks @someone for the review');
  });

  it('keeps every other private source field out', () => {
    const event = projectActivity({ ...base, post_text: 'public words', payload: { text: 'PRIVATE' }, target_ref: '@private-person', reasoning: 'PRIVATE' });
    expect(JSON.stringify(event)).not.toMatch(/PRIVATE|private-person|payload|reasoning/);
  });

  it('drops words the owner no longer consents to at send time, and keeps the link', () => {
    const event = projectActivity({ ...base, post_text: 'words' })!;
    const at = (iso: string) => ({ enabled: true, changedAt: iso });
    expect(withoutUnconsentedText([event], at('2026-11-09T09:00:00.000Z'))[0]!.post_text).toBe('words');
    expect(withoutUnconsentedText([event], at('2026-11-09T10:00:00.000Z'))[0]!.post_text).toBe('words');
    for (const consent of [{ enabled: false, changedAt: '2026-11-09T09:00:00.000Z' }, { enabled: false, changedAt: null },
      { enabled: true, changedAt: null }, at('2026-11-09T10:00:00.001Z')]) {
      const [out] = withoutUnconsentedText([event], consent);
      expect(out).not.toHaveProperty('post_text');
      expect(out).toMatchObject({ post_url: base.post_url, id: base.id });
    }
    expect(event.post_text).toBe('words');
  });

  it('is strict about the new fields on the outbound contract', () => {
    const event = projectActivity({ ...base, post_text: 'words' })!;
    const batch = (e: unknown) => ActivityTapeBatch.safeParse({ protocol: 1, events: [e], remove: [] }).success;
    expect(batch(event)).toBe(true);
    expect(batch({ ...event, post_url: 'https://x.com/a/status/1?x=1' })).toBe(false);
    expect(batch({ ...event, post_url: 'https://example.invalid/a/status/1' })).toBe(false);
    expect(batch({ ...event, dry_run: true })).toBe(false);
    expect(batch({ ...event, kind: 'PAPER_FILL' })).toBe(false);
    expect(batch({ ...event, post_url: undefined })).toBe(false);
    expect(batch({ ...event, post_text: '' })).toBe(false);
    expect(batch({ ...event, post_text: 'x'.repeat(501) })).toBe(false);
    expect(batch({ ...event, post_html: '<b>' })).toBe(false);
    expect(batch({ ...event, target_handle: 'someone' })).toBe(false);
  });
});
