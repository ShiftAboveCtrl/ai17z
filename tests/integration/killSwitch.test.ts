import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { agents as agentsRepo, query } from '@xbam/database';
import { pauseState, remoteActionsAllowed, setPauseAll } from '@xbam/runtime';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';

installHarness();

afterEach(async () => {
  await setPauseAll({ paused: false, by: null });
});

/**
 * A pause that lives in the interface stops the buttons and nothing else: the
 * worker keeps claiming, the poller keeps polling, and a reply already through
 * validation still goes out.
 */
describe('stopping everything', () => {
  it('lets actions through when it is not on', async () => {
    expect((await remoteActionsAllowed()).allowed).toBe(true);
  });

  it('refuses them when it is, and says why', async () => {
    await setPauseAll({ paused: true, by: 'someone@example.test' });
    const gate = await remoteActionsAllowed();
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain('paused');
    expect(gate.reason).toContain('Nothing will be sent');
  });

  it('remembers who stopped it and when', async () => {
    // "Paused" on its own leaves somebody wondering whether they did it.
    await setPauseAll({ paused: true, by: 'someone@example.test', reason: 'Checking something.' });
    const state = await pauseState();
    expect(state.by).toBe('someone@example.test');
    expect(state.since).toBeTruthy();
    expect(state.reason).toContain('Checking');
  });

  it('survives a restart, because it is a row rather than a variable', async () => {
    await setPauseAll({ paused: true, by: 'someone@example.test' });
    // Read straight from storage, as a fresh process would.
    const [row] = await query<{ value: unknown }>("SELECT value FROM app_settings WHERE key = 'runtime.pauseAll'");
    expect((row!.value as { paused: boolean }).paused).toBe(true);
  });

  it('releases cleanly', async () => {
    await setPauseAll({ paused: true, by: 'someone@example.test' });
    await setPauseAll({ paused: false, by: 'someone@example.test' });
    expect((await pauseState()).paused).toBe(false);
    expect((await remoteActionsAllowed()).allowed).toBe(true);
  });

  it('does not touch any agent of its own', async () => {
    // The invariant the brief names: an agent paused by a person before the
    // switch was thrown must still be paused after it is released. Restoring
    // "everything" must never start something nobody asked to start.
    const fixture = await createFixture();
    await agentsRepo.updateAgent(fixture.agentId, { state: 'PAUSED' });

    await setPauseAll({ paused: true, by: 'someone@example.test' });
    await setPauseAll({ paused: false, by: 'someone@example.test' });

    expect((await agentsRepo.getAgent(fixture.agentId))!.state).toBe('PAUSED');
  });

  it('leaves a running agent running after a pause and release', async () => {
    const fixture = await createFixture();
    await agentsRepo.updateAgent(fixture.agentId, { state: 'ACTIVE' });
    await setPauseAll({ paused: true, by: 'someone@example.test' });
    await setPauseAll({ paused: false, by: 'someone@example.test' });
    expect((await agentsRepo.getAgent(fixture.agentId))!.state).toBe('ACTIVE');
  });
});

/**
 * The race the brief names, and the reason the check sits where it does.
 *
 * A job is validated, somebody presses stop, and the action executes a moment
 * later. A check at the top of the pipeline leaves a window exactly as long as
 * the pipeline -- which is the window somebody reaches for this button in.
 */
describe('where the check actually sits', () => {
  const steps = readFileSync(resolve(__dirname, '../../packages/runtime/src/steps.ts'), 'utf8');

  it('is after the last await before the remote call', () => {
    const gate = steps.indexOf('remoteActionsAllowed()');
    const call = steps.indexOf('adapter.executeAction(');
    expect(gate).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(gate);

    // And nothing that could take time sits between them. Anything awaited in
    // that gap reopens the window this exists to close. The slice stops before
    // the `await` belonging to the call itself, which is not in the gap.
    const between = steps.slice(gate, steps.lastIndexOf('await', call));
    expect(between).not.toMatch(/await (?!remoteActionsAllowed|observability)/);
  });

  it('exempts a dry run, which reaches nobody', () => {
    const gate = steps.slice(steps.indexOf('const gate = await remoteActionsAllowed()') - 400, steps.indexOf('const gate = await remoteActionsAllowed()'));
    expect(gate).toContain('!job.dryRun');
  });

  it('is retryable rather than permanent, because a person stopped it', () => {
    // Releasing the pause should let the job go out. A job stopped by somebody
    // pressing a button has not failed.
    const at = steps.indexOf("PipelineError.retryable('paused_globally'");
    expect(at).toBeGreaterThan(-1);
  });
});
