import { describe, expect, it } from 'vitest';
import { observability, query } from '@xbam/database';
import { collectDiagnostics } from '@xbam/runtime';
import { installHarness, mockEvent } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { uniqueSuffix } from '../support/db';

installHarness();

/**
 * The defect this exists for, found on a live installation during promotion.
 *
 * `lastSuccesses` asked for `model_calls.finished_at`, which does not exist,
 * and matched `status = 'OK'`, which nothing writes. The query threw, a catch
 * turned that into three nulls, and every agent reported never read, never
 * wrote, never sent -- including agents in the middle of working.
 *
 * A unit test could not have caught it: the mistake is a disagreement between
 * the query and the schema, and only a real database knows the schema. So this
 * writes the rows and reads the diagnostics back.
 */
describe('the three timestamps that say whether anything is happening', () => {
  it('reports a model call that completed', async () => {
    const fixture = await createFixture();
    const id = await observability.startModelCall({
      jobId: null,
      agentId: fixture.agentId,
      providerCredentialId: null,
      purpose: 'test',
      provider: 'mock',
      model: 'mock-echo',
      modelRole: 'primary',
      attempt: 1,
      parameters: {},
      promptLayers: null,
      promptText: null,
    });
    await observability.finishModelCall(id, { status: 'COMPLETED' });

    const diagnostics = await collectDiagnostics(fixture.agentId);
    expect(diagnostics.lastSuccess.generation, 'a completed model call must show as a generation').toBeTruthy();
  });

  it('does not count a failed model call as a generation', async () => {
    const fixture = await createFixture();
    const id = await observability.startModelCall({
      jobId: null,
      agentId: fixture.agentId,
      providerCredentialId: null,
      purpose: 'test',
      provider: 'mock',
      model: 'mock-echo',
      modelRole: 'primary',
      attempt: 1,
      parameters: {},
      promptLayers: null,
      promptText: null,
    });
    await observability.finishModelCall(id, { status: 'FAILED', error: 'nope' });

    const diagnostics = await collectDiagnostics(fixture.agentId);
    expect(diagnostics.lastSuccess.generation).toBeNull();
  });

  it('reports an executed action, and not a dry run', async () => {
    const fixture = await createFixture();
    const outcome = await (await import('@xbam/runtime')).ingestNormalizedEvent({
      accountId: null,
      onlyAgentId: fixture.agentId,
      event: mockEvent('Something to answer'),
    });
    const jobId = outcome.jobs[0]!.job.id;

    await query(
      `INSERT INTO actions (job_id, agent_id, channel, type, status, dry_run, executed_at, idempotency_key)
       VALUES ($1,$2,'mock','REPLY','EXECUTED',false, now(), $3)`,
      [jobId, fixture.agentId, `act-${uniqueSuffix()}`],
    );

    const diagnostics = await collectDiagnostics(fixture.agentId);
    expect(diagnostics.lastSuccess.action, 'an executed action must show as a send').toBeTruthy();
  });

  it('says nothing has happened when nothing has, rather than by accident', async () => {
    // The failure mode was three nulls that looked exactly like this. The tests
    // above are what tell the two apart.
    const fixture = await createFixture();
    const diagnostics = await collectDiagnostics(fixture.agentId);
    expect(diagnostics.lastSuccess).toEqual({ poll: null, generation: null, action: null });
  });
});

/**
 * Every query in the diagnostics runs against the real schema here, so a column
 * that does not exist fails the test rather than being swallowed into a
 * plausible-looking answer.
 */
describe('collecting diagnostics at all', () => {
  it('returns a whole document without any query throwing', async () => {
    const fixture = await createFixture();
    const diagnostics = await collectDiagnostics(fixture.agentId);

    expect(diagnostics.agent.state).toBeTruthy();
    expect(Array.isArray(diagnostics.providers)).toBe(true);
    expect(Array.isArray(diagnostics.models)).toBe(true);
    expect(Array.isArray(diagnostics.tools)).toBe(true);
    expect(Array.isArray(diagnostics.knowledge)).toBe(true);
    expect(Array.isArray(diagnostics.radar)).toBe(true);
    expect(Array.isArray(diagnostics.recentFailures)).toBe(true);
    expect(diagnostics.collectedAt).toBeTruthy();
  });

  it('grades a published tab honestly', async () => {
    // READY was being graded DEGRADED and MISSING was FAILING, so a browser
    // doing exactly the right thing reported four faults.
    const fixture = await createFixture();
    const account = await (await import('@xbam/database')).accounts.createAccount({
      ownerId: fixture.ownerId,
      channel: 'x',
      handle: `tab${uniqueSuffix()}`.slice(0, 15),
      displayName: 'Tabs',
    });
    await (await import('@xbam/database')).accounts.linkAgentAccount({
      agentId: fixture.agentId,
      accountId: account.id,
    });
    await query(
      `INSERT INTO browser_sessions (account_id, mode, status, tabs, tabs_updated_at)
       VALUES ($1,'MANAGED','healthy',$2::jsonb, now())`,
      [
        account.id,
        JSON.stringify([
          { role: 'ACTION', state: 'READY', url: 'https://x.com/home' },
          { role: 'MENTIONS', state: 'BUSY', url: 'https://x.com/search' },
          { role: 'NOTIFICATIONS', state: 'MISSING', url: null },
          { role: 'RESEARCH', state: 'FAILED', url: null, lastError: 'the page went away' },
        ]),
      ],
    );

    const graded = Object.fromEntries(
      (await collectDiagnostics(fixture.agentId)).browser.map((row) => [row.name, row.state]),
    );
    expect(graded['ACTION tab']).toBe('HEALTHY');
    expect(graded['MENTIONS tab']).toBe('HEALTHY');
    // Opened on demand. Not open is not broken.
    expect(graded['NOTIFICATIONS tab']).toBe('OFF');
    expect(graded['RESEARCH tab']).toBe('FAILING');
  });

  it('carries the reason a tab failed, not just the word', async () => {
    const fixture = await createFixture();
    const account = await (await import('@xbam/database')).accounts.createAccount({
      ownerId: fixture.ownerId,
      channel: 'x',
      handle: `err${uniqueSuffix()}`.slice(0, 15),
      displayName: 'Tabs',
    });
    await (await import('@xbam/database')).accounts.linkAgentAccount({
      agentId: fixture.agentId,
      accountId: account.id,
    });
    await query(
      `INSERT INTO browser_sessions (account_id, mode, status, tabs, tabs_updated_at)
       VALUES ($1,'MANAGED','healthy',$2::jsonb, now())`,
      [account.id, JSON.stringify([{ role: 'ACTION', state: 'FAILED', lastError: 'the page went away' }])],
    );

    const row = (await collectDiagnostics(fixture.agentId)).browser.find((r) => r.name === 'ACTION tab');
    expect(row?.detail).toContain('the page went away');
  });
});
