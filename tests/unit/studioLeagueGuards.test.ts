import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agents, leagueBridge, trading, type LeagueEntryRow } from '@xbam/database';
import { LeagueSeasonDocument } from '@xbam/shared/contracts';
import { enterLeagueSeason, readLeagueSeason, readLeagueStanding, reportLeagueFills, sweepLeagueBridge } from '../../packages/runtime/src/studioLeague';
import { studioInstallationRequest } from '../../packages/runtime/src/studioLink';
import { leagueRules, seasonDocument, seasonTimes } from '../support/leagueStudioServer';

vi.mock('../../packages/runtime/src/studioLink', async (original) => ({
  ...await original<typeof import('../../packages/runtime/src/studioLink')>(),
  studioInstallationRequest: vi.fn(),
}));

const now = new Date('2026-11-09T10:00:00.000Z');
const document = () => LeagueSeasonDocument.parse(seasonDocument('week-45', now, seasonTimes(now), leagueRules()));
const entry = (): LeagueEntryRow => {
  const doc = document();
  return {
    id: randomUUID(), agentId: randomUUID(), ownerId: randomUUID(), entryKey: randomUUID(),
    seasonSlug: 'week-45', alias: 'Night Owl', replacePaperMandate: false, season: doc,
    rulesHash: doc.season.rules_hash, startsAt: doc.season.starts_at, endsAt: doc.season.ends_at,
    fillsAcceptedUntil: doc.season.fills_accepted_until, remoteEntryId: 'ent_1', mandateId: randomUUID(),
    status: 'ACTIVE', statusReason: null, lastProblem: null, lastSeasonCheckAt: null,
    createdAt: now.toISOString(), updatedAt: now.toISOString(),
  };
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(studioInstallationRequest).mockReset();
  vi.stubEnv('AI17Z_LEAGUE_JOURNAL', '1');
});

afterEach(() => vi.unstubAllEnvs());

describe('the local journal switch', () => {
  it.each([undefined, '', '0', 'true', 'yes'])('is off for %s, including production, before any database or HTTP work', async (value) => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('AI17Z_LEAGUE_JOURNAL', value);
    const getAgent = vi.spyOn(agents, 'getAgent').mockRejectedValue(new Error('database reached'));
    const open = vi.spyOn(leagueBridge, 'openEntries').mockRejectedValue(new Error('database reached'));
    const live = vi.spyOn(leagueBridge, 'liveEntryOf').mockRejectedValue(new Error('database reached'));
    const fills = vi.spyOn(leagueBridge, 'fillsOf').mockRejectedValue(new Error('database reached'));
    expect(await readLeagueSeason('week-45', now)).toMatchObject({ ok: false, status: 503 });
    expect(await enterLeagueSeason({ agentId: 'a', ownerId: 'o', slug: 'week-45', alias: 'Night Owl' }, now)).toMatchObject({ ok: false, status: 503 });
    expect(await sweepLeagueBridge(now)).toMatchObject({ entries: 0, recorded: 0, accepted: 0 });
    expect(await reportLeagueFills(entry(), now)).toMatchObject({ recorded: 0, accepted: 0 });
    expect(await readLeagueStanding('a', now)).toMatchObject({ ok: false, code: 'UNAVAILABLE', status: 503 });
    for (const call of [getAgent, open, live, fills, studioInstallationRequest]) expect(call).not.toHaveBeenCalled();
  });
});

describe('frozen entry facts', () => {
  it.each(['rulesHash', 'startsAt', 'endsAt', 'fillsAcceptedUntil'] as const)('refuses a local %s mismatch before copying or sending fills', async (field) => {
    const row = entry();
    row[field] = field === 'rulesHash' ? 'b'.repeat(64) : new Date(Date.parse(row[field]) + 1000).toISOString();
    const readFills = vi.spyOn(leagueBridge, 'fillsOf').mockResolvedValue([]);
    vi.spyOn(leagueBridge, 'paperFillsUnderMandate').mockResolvedValue([]);
    const note = vi.spyOn(leagueBridge, 'noteProblem').mockResolvedValue();
    const end = vi.spyOn(leagueBridge, 'endEntry').mockResolvedValue();
    const pause = vi.spyOn(trading, 'setMandatePaused').mockResolvedValue(null);
    await reportLeagueFills(row, now);
    expect(readFills).not.toHaveBeenCalled();
    expect(studioInstallationRequest).not.toHaveBeenCalled();
    expect(note).toHaveBeenCalledWith(row.id, expect.stringMatching(/frozen|match/));
    expect(end).toHaveBeenCalled();
    expect(pause).toHaveBeenCalledWith(row.mandateId, true);
  });

  it.each([503, 403, 409])('preserves Studio refusal %i without treating it as a season', async (status) => {
    vi.mocked(studioInstallationRequest).mockResolvedValue({ ok: true, status, body: { error: 'refused' }, sentence: 'Studio refused this request.' });
    expect(await readLeagueSeason('week-45', now)).toMatchObject({ ok: false, status, why: 'Studio refused this request.' });
  });
});
