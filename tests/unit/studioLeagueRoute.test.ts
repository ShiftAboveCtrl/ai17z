import Fastify from 'fastify';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { registerStudioRoutes } from '../../apps/api/src/routes/studio';

const { enter, session } = vi.hoisted(() => ({ enter: vi.fn(), session: vi.fn() }));
vi.mock('@xbam/runtime', () => ({ enterLeagueSeason: enter }));
vi.mock('@xbam/database', () => ({ users: { resolveSession: session }, ops: {}, studio: {} }));

const app = Fastify();
await registerStudioRoutes(app);
afterEach(() => vi.clearAllMocks());
beforeEach(() => session.mockResolvedValue({ id: 'owner' }));
const payload = { agentId: '11111111-1111-4111-8111-111111111111', slug: 'week-45', alias: 'Paper Scout' };
const request = (body: Record<string, unknown> = payload, authenticated = true) => app.inject({ method: 'POST', url: '/api/studio/league/entry', payload: body, headers: authenticated ? { authorization: 'Bearer session' } : {} });

it('requires owner authentication before entering', async () => {
  expect((await request(payload, false)).statusCode).toBe(401);
  expect(enter).not.toHaveBeenCalled();
});
it('passes the authenticated owner and explicit mandate consent to the existing helper', async () => {
  enter.mockResolvedValue({ ok: true, state: 'ACTIVE', entry: { id: 'entry' } });
  const response = await request({ ...payload, replacePaperMandate: true });
  expect(response.statusCode).toBe(200);
  expect(enter).toHaveBeenCalledWith({ ...payload, ownerId: 'owner', replacePaperMandate: true });
  expect(response.json().data.state).toBe('ACTIVE');
});
it.each(['The season is closed.', 'This installation is not linked.', 'This agent is already entered.'])('preserves the runtime outcome: %s', async (why) => {
  enter.mockResolvedValue({ ok: false, why });
  expect((await request()).json().data).toEqual({ ok: false, why });
});
it.each([{ ...payload, ownerId: 'someone-else' }, { ...payload, slug: '../bad' }, { ...payload, alias: 'https://example.test' }, { ...payload, agentId: 'bad' }])('rejects invalid input without entering', async (body) => {
  expect((await request(body)).statusCode).toBe(422);
  expect(enter).not.toHaveBeenCalled();
});
