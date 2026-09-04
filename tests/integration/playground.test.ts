import { describe, expect, it } from 'vitest';
import { query } from '@xbam/database';
import { compareModels, tryMessage } from '@xbam/runtime';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';

installHarness();

const counts = async () => {
  const [row] = await query<{ jobs: number; actions: number }>(
    'SELECT (SELECT count(*)::int FROM jobs) AS jobs, (SELECT count(*)::int FROM actions) AS actions',
  );
  return row!;
};

/**
 * Experimenting with a voice is the thing owners most want to do and are most
 * afraid of, because every other way of finding out what an agent sounds like
 * involves it saying something in public.
 *
 * The safety is structural rather than a flag. Every remote call in this system
 * is made by an action belonging to a job, and this path creates neither -- so
 * the code that reaches X is not reachable from here. A dry-run flag can be got
 * wrong, and was once: a nested `{ options: { dryRun: true } }` was silently
 * ignored and an autonomous agent replied to a stranger.
 */
describe('trying an agent out', () => {
  it('creates no job and no action, which is what makes it safe', async () => {
    const fixture = await createFixture();
    const before = await counts();
    await tryMessage({ agentId: fixture.agentId, message: 'What do you think about this?', fromHandle: 'alice' });
    expect(await counts()).toEqual(before);
  });

  it('runs the real path and says which model answered', async () => {
    const fixture = await createFixture();
    const result = await tryMessage({ agentId: fixture.agentId, message: 'What do you think?' });
    expect(result.provider).toBeTruthy();
    expect(result.model).toBeTruthy();
    expect(result.raw.length).toBeGreaterThan(0);
    expect(result.final.length).toBeGreaterThan(0);
  });

  it('shows the raw answer beside the final one', async () => {
    // The whole point of the screen: what the model said, and what AI17Z made
    // of it. One without the other explains nothing.
    const fixture = await createFixture();
    const result = await tryMessage({ agentId: fixture.agentId, message: 'thoughts?' });
    expect(result).toHaveProperty('raw');
    expect(result).toHaveProperty('final');
  });

  it('lets a draft persona be tried without saving it', async () => {
    // Comparing an edit against what is live, without making the edit live,
    // which is the reason to open this at all.
    const fixture = await createFixture();
    const versions = async () =>
      (
        await query<{ n: number }>(
          'SELECT count(*)::int AS n FROM persona_versions v JOIN personas p ON p.id = v.persona_id WHERE p.agent_id = $1',
          [fixture.agentId],
        )
      )[0]!.n;
    const before = await versions();

    await tryMessage({
      agentId: fixture.agentId,
      message: 'hello',
      persona: { personality: 'Completely different, and never saved.' },
    });

    expect(await versions()).toBe(before);
  });

  it('refuses clearly for an agent that does not exist', async () => {
    await expect(tryMessage({ agentId: '00000000-0000-0000-0000-000000000000', message: 'hi' })).rejects.toThrow();
  });
});

/**
 * The demonstration of the idea the product rests on: the model is where the
 * intelligence comes from, and AI17Z is what makes the answer sound like the
 * same agent whichever model wrote it. Seeing that requires the raw answer
 * beside the final one, for more than one provider at a time.
 */
describe('comparing models', () => {
  it('runs the same message through each role', async () => {
    const fixture = await createFixture();
    const entries = await compareModels({ agentId: fixture.agentId, message: 'what do you make of this?', roles: ['primary'] });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.result?.raw.length).toBeGreaterThan(0);
  });

  it('records a failure instead of throwing it', async () => {
    // One provider out of credit must not blank a comparison the others
    // answered, which is exactly when the comparison is most informative.
    const fixture = await createFixture();
    const entries = await compareModels({
      agentId: fixture.agentId,
      message: 'hello',
      roles: ['primary', 'fallback_2'],
    });

    expect(entries).toHaveLength(2);
    expect(entries[0]!.result, 'the configured role should still answer').toBeTruthy();
    const unconfigured = entries[1]!;
    expect(unconfigured.result === null || unconfigured.failed !== null).toBe(true);
  });

  it('creates no job and no action, like the single run', async () => {
    const fixture = await createFixture();
    const before = await counts();
    await compareModels({ agentId: fixture.agentId, message: 'hello', roles: ['primary'] });
    expect(await counts()).toEqual(before);
  });
});
