import { describe, expect, it } from 'vitest';
import { ActivityTapeBatch, projectActivity, registerActivityTapeCapability } from '../../packages/runtime/src/studioActivityTape';
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
