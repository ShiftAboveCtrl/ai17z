import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../apps/api/src/server';
import { research as researchRepo } from '@xbam/database';
import { advanceFoundryRun, type FoundryDeps } from '@xbam/runtime';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';

installHarness();

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});
afterAll(async () => {
  await app?.close();
});

async function signIn(email: string): Promise<{ authorization: string }> {
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'test-password-1234' } });
  expect(response.statusCode, response.body).toBe(200);
  const { data } = response.json() as { data: { token: string } };
  return { authorization: `Bearer ${data.token}` };
}
const body = <T>(response: { json: () => unknown }): T => (response.json() as { data: T }).data;

/** A worker with no browser: every source absent. The run still completes and says so. */
const noBrowser: FoundryDeps = {
  workerId: 'api-test-worker',
  leaseMs: 60_000,
  platform: null,
  searchIndex: null,
  mirrors: [],
  resolveProfile: async () => null,
  search: async () => [],
  confirmPost: async () => null,
};

describe('Agent Foundry through the API', () => {
  it('reads a brief into a plan, and warns when no X account can read', async () => {
    const fixture = await createFixture();
    const auth = await signIn(fixture.ownerEmail);
    const response = await app.inject({
      method: 'POST',
      url: '/api/foundry/plan',
      headers: auth,
      payload: { text: 'Build an Agent modeled on @synthbuilder. It should deeply understand Pons and Robinhood Chain. Keep its autonomy selective.' },
    });
    expect(response.statusCode, response.body).toBe(200);
    const plan = body<{ brief: { handle: string; projects: string[]; autonomy: string; relationship: string }; warning: string | null }>(response);
    expect(plan.brief.handle).toBe('synthbuilder');
    expect(plan.brief.projects).toEqual(['Pons', 'Robinhood Chain']);
    expect(plan.brief.autonomy).toBe('SELECTIVE');
    expect(plan.brief.relationship).toBe('MODELED_AFTER');
    expect(plan.warning).toMatch(/No X account/);
  });

  it('starts one run at a time, shows its stages, lets the owner decide, and applies', async () => {
    const fixture = await createFixture();
    const auth = await signIn(fixture.ownerEmail);
    const start = await app.inject({
      method: 'POST',
      url: `/api/agents/${fixture.agentId}/foundry`,
      headers: auth,
      payload: { text: 'Model it on @synthbuilder, conservative.', mode: 'SETUP' },
    });
    expect(start.statusCode, start.body).toBe(200);
    const runId = body<{ run: { id: string; stages: { state: string }[] } }>(start).run.id;

    const second = await app.inject({ method: 'POST', url: `/api/agents/${fixture.agentId}/foundry`, headers: auth, payload: { text: 'again' } });
    expect(second.statusCode).toBe(409);

    // The worker's part, with no browser at all.
    const claimed = (await researchRepo.claimDueRun('api-test-worker', 60_000))!;
    expect(await advanceFoundryRun(claimed, noBrowser)).toBe('READY');

    const view = await app.inject({ method: 'GET', url: `/api/foundry/runs/${runId}`, headers: auth });
    const shown = body<{
      run: { status: string; stages: { stage: string; state: string; detail: string | null }[] };
      items: { id: string; section: string; itemKey: string }[];
      report: { uncertainty: string[] };
    }>(view);
    expect(shown.run.status).toBe('READY');
    expect(shown.run.stages.every((s) => s.state === 'DONE')).toBe(true);
    // Honest about having read nothing.
    expect(shown.report.uncertainty.join(' ')).toMatch(/No X account is connected|could not be looked up/);
    expect(shown.items.some((i) => i.section === 'MUST_NEVER')).toBe(true);

    const never = shown.items.find((i) => i.section === 'MUST_NEVER')!;
    const decided = await app.inject({ method: 'PATCH', url: `/api/foundry/items/${never.id}`, headers: auth, payload: { decision: 'ACCEPTED' } });
    expect(decided.statusCode, decided.body).toBe(200);

    const applied = await app.inject({ method: 'POST', url: `/api/foundry/runs/${runId}/apply`, headers: auth, payload: {} });
    expect(applied.statusCode, applied.body).toBe(200);
    expect(body<{ applied: { personaVersion: number | null } }>(applied).applied.personaVersion).not.toBeNull();

    const again = await app.inject({ method: 'PATCH', url: `/api/foundry/items/${never.id}`, headers: auth, payload: { decision: 'REJECTED' } });
    expect(again.statusCode).toBe(409);
  });

  it("refuses another owner's run", async () => {
    const mine = await createFixture();
    const theirs = await createFixture();
    const run = await researchRepo.createRun({ ownerId: theirs.ownerId, agentId: theirs.agentId, kind: 'FOUNDRY_SETUP', brief: {} });
    const auth = await signIn(mine.ownerEmail);
    const response = await app.inject({ method: 'GET', url: `/api/foundry/runs/${run.id}`, headers: auth });
    expect(response.statusCode).toBe(403);
  });
});
