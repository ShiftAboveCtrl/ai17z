import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../apps/api/src/server';
import { query } from '@xbam/database';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';

installHarness();

/**
 * Two routes with no screen, kept on purpose and therefore proved.
 *
 * `/playground` and `/compare` are the only owner-facing capability in this
 * system that nothing in Studio renders, and that is deliberate: the Lab view
 * reaches the Response Lab, which runs the real pipeline as a rehearsal, while
 * the playground holds memory, thread and research still so that two personas
 * can be compared with everything else fixed. Both questions are worth asking
 * and neither is a simplification of the other.
 *
 * A route nothing renders is a route nothing notices breaking, which is the
 * reason this file exists rather than an argument for deleting them. The
 * runtime behind them already has its own tests; what had nothing was the HTTP
 * surface: whether somebody can reach it, whether somebody else cannot, and
 * whether the property it rests on survives being reached over the network.
 */

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});
afterAll(async () => {
  await app?.close();
});

async function signIn(email: string): Promise<{ authorization: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: 'test-password-1234' },
  });
  expect(response.statusCode, response.body).toBe(200);
  const { data } = response.json() as { data: { token: string } };
  return { authorization: `Bearer ${data.token}` };
}

const counts = async () => {
  const [row] = await query<{ jobs: number; actions: number }>(
    'SELECT (SELECT count(*)::int FROM jobs) AS jobs, (SELECT count(*)::int FROM actions) AS actions',
  );
  return row!;
};

describe('the playground over HTTP', () => {
  it('answers, and says which model answered', async () => {
    const fixture = await createFixture();
    const headers = await signIn(fixture.ownerEmail);

    const response = await app.inject({
      method: 'POST',
      url: `/api/agents/${fixture.agentId}/playground`,
      headers,
      payload: { message: 'What do you make of this?', fromHandle: 'alice' },
    });

    expect(response.statusCode, response.body).toBe(200);
    const { data } = response.json() as { data: { provider: string; model: string; raw: string; final: string } };
    expect(data.provider).toBeTruthy();
    expect(data.model).toBeTruthy();
    // Both halves, because the whole point of the screen this would be is what
    // the model said beside what AI17Z made of it.
    expect(data.raw.length).toBeGreaterThan(0);
    expect(data.final.length).toBeGreaterThan(0);
  });

  it('creates no job and no action, reached over the network as well', async () => {
    // The safety is structural rather than a flag, and a route is exactly where
    // a structural property stops being structural: a caller supplies a body,
    // and a body is the thing that once carried a nested
    // `{ options: { dryRun: true } }` that was silently ignored while an
    // autonomous agent replied to a stranger. So it is asserted here too, of
    // the whole database, rather than trusted from the layer below.
    const fixture = await createFixture();
    const headers = await signIn(fixture.ownerEmail);
    const before = await counts();

    const response = await app.inject({
      method: 'POST',
      url: `/api/agents/${fixture.agentId}/playground`,
      headers,
      payload: { message: 'Reply to this if you can.' },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(await counts()).toEqual(before);
  });

  it('belongs to its owner and to nobody else', async () => {
    const mine = await createFixture();
    const theirs = await createFixture();
    const headers = await signIn(theirs.ownerEmail);

    const response = await app.inject({
      method: 'POST',
      url: `/api/agents/${mine.agentId}/playground`,
      headers,
      payload: { message: 'Let me try your agent.' },
    });

    expect([403, 404]).toContain(response.statusCode);
  });

  it('refuses an empty message rather than sending one', async () => {
    const fixture = await createFixture();
    const headers = await signIn(fixture.ownerEmail);

    const response = await app.inject({
      method: 'POST',
      url: `/api/agents/${fixture.agentId}/playground`,
      headers,
      payload: { message: '   ' },
    });

    // 422 rather than 400: the body parsed, and it is the value that is
    // unacceptable. What matters is that nothing ran.
    expect(response.statusCode).toBe(422);
  });

  it('compares roles in one call, and records a failure rather than throwing it', async () => {
    // One provider out of credit must not blank a comparison the others
    // answered, which is the reason this route exists separately from running
    // the playground several times from a caller.
    const fixture = await createFixture();
    const headers = await signIn(fixture.ownerEmail);
    const before = await counts();

    const response = await app.inject({
      method: 'POST',
      url: `/api/agents/${fixture.agentId}/compare`,
      headers,
      payload: { message: 'Say something.', roles: ['PRIMARY', 'not-a-role'] },
    });

    expect(response.statusCode, response.body).toBe(200);
    const { data } = response.json() as {
      data: { entries: { role: string; result: unknown | null; failed: string | null }[] };
    };
    // One entry per role asked for, in the order asked. A role that could not
    // answer is an entry saying so rather than a missing one, which is the
    // whole point: a comparison with a hole in it is still a comparison.
    expect(data.entries).toHaveLength(2);
    expect(data.entries.map((entry) => entry.role)).toEqual(['PRIMARY', 'not-a-role']);
    for (const entry of data.entries) {
      expect(entry.result === null || entry.failed === null).toBe(true);
    }
    expect(await counts()).toEqual(before);
  });
});

describe('where an owner reads who leads somewhere new', () => {
  it('has one route for it, not two', async () => {
    // `/growth/bridges` returned `bridgesFor` on its own while
    // `/api/agents/:id/people` returns the same call with the relationship and
    // whatever has been read about the person attached. Nothing rendered the
    // first, so nothing would have failed when the two stopped agreeing.
    //
    // Retired rather than given a surface of its own, for the reason the
    // `narratives` table was retired: two answers to one question is the thing
    // this codebase keeps saying it does not want.
    const fixture = await createFixture();
    const headers = await signIn(fixture.ownerEmail);

    const gone = await app.inject({
      method: 'GET',
      url: `/api/agents/${fixture.agentId}/growth/bridges`,
      headers,
    });
    expect(gone.statusCode).toBe(404);

    // And the one that remains still answers, which is what makes the removal
    // safe rather than merely smaller.
    const people = await app.inject({
      method: 'GET',
      url: `/api/agents/${fixture.agentId}/people`,
      headers,
    });
    expect(people.statusCode, people.body).toBe(200);
    const { data } = people.json() as { data: { items: unknown[] } };
    expect(Array.isArray(data.items)).toBe(true);
  });

  it('answers what a capability may do from one place, not two', async () => {
    // The flat `/toolspace` list and `/toolspace/packs` were the same content
    // in two shapes, and only the second was rendered. That cost something:
    // the flat one was what an individual switch reloaded while every row on
    // screen came from the pack view, so changing a capability refreshed
    // nothing an owner could see. The screen stopped asking; the route stayed.
    const fixture = await createFixture();
    const headers = await signIn(fixture.ownerEmail);

    const gone = await app.inject({
      method: 'GET',
      url: `/api/agents/${fixture.agentId}/toolspace`,
      headers,
    });
    expect(gone.statusCode).toBe(404);

    // The one that is rendered still carries every capability, which is what
    // made removing the other one a removal rather than a loss.
    const packs = await app.inject({
      method: 'GET',
      url: `/api/agents/${fixture.agentId}/toolspace/packs`,
      headers,
    });
    expect(packs.statusCode, packs.body).toBe(200);
    // Both halves, because "every capability there is" is packs plus ungrouped
    // and a view missing either would be the subset this just removed.
    // How many there are depends on which families the process registered, so
    // the shape is what is asserted rather than a count.
    const view = packs.json() as { data: { packs: { items: unknown[] }[]; ungrouped: unknown[] } };
    expect(Array.isArray(view.data.packs)).toBe(true);
    expect(Array.isArray(view.data.ungrouped)).toBe(true);
  });
});
