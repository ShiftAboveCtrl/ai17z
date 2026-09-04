import { describe, expect, it } from 'vitest';
import type { AgentDiagnostics, ComponentHealth } from '@xbam/shared/contracts';
import { liveStatus, type JobInFlight } from '@xbam/runtime';

const part = (over: Partial<ComponentHealth> = {}): ComponentHealth => ({
  name: 'Something',
  state: 'HEALTHY',
  detail: 'Fine.',
  lastSucceededAt: null,
  failingForMinutes: null,
  ...over,
});

const healthy = (over: Partial<AgentDiagnostics> = {}): AgentDiagnostics => ({
  agent: { state: 'ACTIVE', canWork: true, reason: null },
  account: { connected: true, handle: 'someone', status: 'CONNECTED', lastPolledAt: new Date().toISOString() },
  worker: part({ name: 'Worker' }),
  providers: [part({ name: 'A provider' })],
  models: [],
  browser: [part({ name: 'MENTIONS tab' })],
  radar: [part({ name: 'Mention search' })],
  tools: [],
  knowledge: [],
  lastSuccess: { poll: new Date().toISOString(), generation: null, action: null },
  recentFailures: [],
  collectedAt: new Date().toISOString(),
  ...over,
});

const status = (over: Partial<Parameters<typeof liveStatus>[0]> = {}) =>
  liveStatus({ diagnostics: healthy(), inFlight: [], awaitingPeople: 0, ...over });

const job = (over: Partial<JobInFlight> = {}): JobInFlight => ({
  status: 'GENERATING',
  currentNodeKey: null,
  actionType: 'REPLY',
  ...over,
});

/**
 * The screen said RUNNING, and RUNNING was equally true of an agent answering
 * mentions, an agent waiting on a dead provider, an agent whose Chrome had
 * gone, and an agent holding twelve replies for review. One word for four
 * situations, three of which need somebody.
 */
describe('what the agent is actually doing', () => {
  it('is listening when it is connected and holding nothing', () => {
    expect(status().activity).toBe('LISTENING');
  });

  it('names the model wait, which is most of the time an agent looks stuck', () => {
    const s = status({ inFlight: [job({ status: 'GENERATING' })] });
    expect(s.activity).toBe('WAITING_FOR_MODEL');
    expect(s.detail).toContain('has not answered');
  });

  it('names research, because it is the slowest step there is', () => {
    expect(status({ inFlight: [job({ currentNodeKey: 'research' })] }).activity).toBe('RESEARCHING');
  });

  it('tells replying from posting, because they are different acts', () => {
    expect(status({ inFlight: [job({ status: 'EXECUTING', actionType: 'REPLY' })] }).activity).toBe('REPLYING');
    expect(status({ inFlight: [job({ status: 'EXECUTING', actionType: 'POST' })] }).activity).toBe('POSTING');
  });

  it('says paused when a person paused it, rather than calling it a problem', () => {
    const paused = healthy({ agent: { state: 'PAUSED', canWork: false, reason: 'The agent is paused.' } });
    expect(status({ diagnostics: paused }).activity).toBe('PAUSED');
  });

  it('asks for attention when nothing can work', () => {
    const noWorker = healthy({ worker: part({ name: 'Worker', state: 'FAILING', detail: 'Nothing has checked in.' }) });
    const s = status({ diagnostics: noWorker });
    expect(s.activity).toBe('NEEDS_ATTENTION');
    expect(s.detail).toContain('checked in');
  });

  it('asks for attention when messages are waiting on a person', () => {
    const s = status({ awaitingPeople: 12 });
    expect(s.activity).toBe('NEEDS_ATTENTION');
    expect(s.detail).toContain('12');
  });

  it('reports work in hand even while something else is degraded', () => {
    // An agent mid-reply is doing that whatever else is also true, and saying
    // so is more honest than reporting a monitor while a reply goes out.
    const degraded = healthy({ radar: [part({ name: 'Notifications', state: 'FAILING' })] });
    expect(status({ diagnostics: degraded, inFlight: [job({ status: 'EXECUTING' })] }).activity).toBe('REPLYING');
  });

  it('keeps listening when one source fails and others still work', () => {
    // The whole point of several monitors: one being down is not silence, and
    // saying NEEDS ATTENTION here would be asking for help that is not needed.
    const partial = healthy({
      radar: [part({ name: 'Notifications', state: 'FAILING' }), part({ name: 'Mention search' })],
    });
    const s = status({ diagnostics: partial });
    expect(s.activity).toBe('LISTENING');
    expect(s.detail).toContain('Notifications');
    expect(s.detail).toContain('still');
  });

  it('asks for attention when the only source fails', () => {
    const blind = healthy({ radar: [part({ name: 'Notifications', state: 'FAILING' })] });
    expect(status({ diagnostics: blind }).activity).toBe('NEEDS_ATTENTION');
  });

  it('says the account is the problem when it is', () => {
    const gone = healthy({
      account: { connected: false, handle: 'someone', status: 'SESSION_EXPIRED', lastPolledAt: null },
    });
    expect(status({ diagnostics: gone }).detail).toContain('session_expired');
  });

  it('never claims to be listening when it cannot hear anything', () => {
    const gone = healthy({ account: { connected: false, handle: null, status: null, lastPolledAt: null } });
    expect(status({ diagnostics: gone }).activity).not.toBe('LISTENING');
  });
});
