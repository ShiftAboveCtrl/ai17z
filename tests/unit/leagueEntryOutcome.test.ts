import { beforeEach, expect, it, vi } from 'vitest';
import { enterLeagueSeason } from '../../packages/runtime/src/studioLeague';
import { seasonDocument, leagueRules, seasonTimes } from '../support/leagueStudioServer';

const { agent, slot, pending, remote } = vi.hoisted(() => ({ agent: vi.fn(), slot: vi.fn(), pending: vi.fn(), remote: vi.fn() }));
vi.mock('@xbam/database', () => ({ agents: { getAgent: agent }, leagueBridge: { mandateSlot: slot, createPendingEntry: pending }, trading: {} }));
vi.mock('../../packages/runtime/src/studioLink', () => ({ studioInstallationRequest: remote }));
const now = new Date();
const input = { agentId: 'agent', ownerId: 'owner', slug: 'week-45', alias: 'Paper Scout' };
beforeEach(() => {
  vi.clearAllMocks();
  agent.mockResolvedValue({ id: 'agent', ownerId: 'owner' });
  slot.mockResolvedValue({ ok: true });
  remote.mockResolvedValue({ ok: true, status: 200, body: seasonDocument('week-45', now, seasonTimes(now), leagueRules()) });
});
it('reports an already active entry without sending another entry to Studio', async () => {
  const season = seasonDocument('week-45', now, seasonTimes(now), leagueRules()) as { season: { rules_hash: string } };
  pending.mockResolvedValue({ kind: 'RESUMED', row: { id: 'entry', status: 'ACTIVE', rulesHash: season.season.rules_hash } });
  expect(await enterLeagueSeason(input, now)).toMatchObject({ ok: true, state: 'ACTIVE', alreadyEntered: true });
  expect(remote).toHaveBeenCalledTimes(1);
});
it('refuses another owner before Studio is contacted', async () => {
  agent.mockResolvedValue({ ownerId: 'other' });
  await expect(enterLeagueSeason(input, now)).rejects.toThrow('Agent');
  expect(remote).not.toHaveBeenCalled();
});
it('preserves the not linked outcome without writing entry intent', async () => {
  remote.mockResolvedValue({ ok: false, why: 'This installation is not linked.' });
  expect(await enterLeagueSeason(input, now)).toEqual({ ok: false, why: 'This installation is not linked.' });
  expect(pending).not.toHaveBeenCalled();
});
it('refuses a closed season before writing entry intent', async () => {
  remote.mockResolvedValue({ ok: true, status: 200, body: seasonDocument('week-45', now, seasonTimes(now), leagueRules(), { season: { status: 'RUNNING' } }) });
  expect(await enterLeagueSeason(input, now)).toMatchObject({ ok: false, why: expect.stringContaining('not open') });
  expect(pending).not.toHaveBeenCalled();
});
