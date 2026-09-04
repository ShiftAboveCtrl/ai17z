import { describe, expect, it } from 'vitest';
import type { AgentDiagnostics, ComponentHealth } from '@xbam/shared/contracts';
import { summariseDiagnostics } from '@xbam/tools';

const part = (over: Partial<ComponentHealth> = {}): ComponentHealth => ({
  name: 'Something',
  state: 'HEALTHY',
  detail: 'Fine.',
  lastSucceededAt: null,
  failingForMinutes: null,
  ...over,
});

const diagnostics = (over: Partial<AgentDiagnostics> = {}): AgentDiagnostics => ({
  agent: { state: 'ACTIVE', canWork: true, reason: null },
  account: { connected: true, handle: 'someone', status: 'CONNECTED', lastPolledAt: null },
  worker: part({ name: 'Worker' }),
  providers: [],
  models: [],
  browser: [],
  radar: [],
  tools: [],
  knowledge: [],
  lastSuccess: { poll: null, generation: null, action: null },
  recentFailures: [],
  collectedAt: new Date().toISOString(),
  ...over,
});

/**
 * The example from the brief, and the reason this exists at all.
 *
 * An agent asked why it is not replying to mentions, without this, can only
 * guess -- and a model guessing about infrastructure produces a confident wrong
 * answer. The useful reply names the monitor that stopped, how long ago, and
 * what is still working, because the last part is what tells somebody whether
 * anything is actually being missed.
 */
describe('turning runtime health into something an agent can say', () => {
  const withRadar = diagnostics({
    radar: [
      part({ name: 'Mention search', state: 'HEALTHY' }),
      part({ name: 'Notifications', state: 'FAILING', failingForMinutes: 11, detail: '4 failed poll(s) in a row.' }),
    ],
  });

  it('names what is broken and for how long', () => {
    const summary = summariseDiagnostics(withRadar);
    expect(summary).toContain('Notifications');
    expect(summary).toContain('11 minutes');
  });

  it('names what is still working, which is half the answer', () => {
    expect(summariseDiagnostics(withRadar)).toContain('Working: Mention search');
  });

  it('says plainly when the agent cannot work at all', () => {
    const paused = diagnostics({ agent: { state: 'PAUSED', canWork: false, reason: 'The agent is paused.' } });
    expect(summariseDiagnostics(paused)).toContain('not working');
  });

  it('says when nothing has ever been sent, rather than staying silent about it', () => {
    // Silence here reads as "everything is fine", which is the opposite of what
    // an agent that has never managed to send anything should convey.
    expect(summariseDiagnostics(diagnostics())).toContain('Nothing has been sent yet');
  });

  it('names a role with no model behind it', () => {
    const missing = diagnostics({
      models: [
        { role: 'primary', configured: true, model: 'some-model' },
        { role: 'vision', configured: false, model: null },
      ],
    });
    expect(summariseDiagnostics(missing)).toContain('vision');
  });

  it('counts failures by class without quoting any of them', () => {
    // The class is a name this codebase chose. A raw message can contain the
    // request it came from, and a request can contain a key.
    const failing = diagnostics({
      recentFailures: [{ reason: 'provider_unauthorised', count: 7, lastAt: null }],
    });
    const summary = summariseDiagnostics(failing);
    expect(summary).toContain('provider_unauthorised (7)');
  });

  it('stays quiet about the parts that have nothing to report', () => {
    // A status report that lists every healthy component is one nobody reads.
    const summary = summariseDiagnostics(diagnostics());
    expect(summary).not.toContain('Knowledge:');
    expect(summary).not.toContain('Tools:');
  });
});
