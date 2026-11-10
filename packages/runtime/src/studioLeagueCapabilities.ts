import { z } from 'zod';
import { defineCapability, registerCapability, type AnyCapability } from '@xbam/tools';
import { describeStanding, describeUnavailable } from './leagueSeason';
import { readLeagueStanding } from './studioLeague';
import { studioInstallationReady } from './studioLink';

/**
 * "How am I doing in the league", for the owner, and nothing else.
 *
 * Shaped like `wallet.*` and the Studio paper record: effect READ, risk LOW,
 * `audience: 'OWNER'` so it is never offered in a public conversation and is
 * refused if one names it, and `unsetPermission: 'DISABLED'` so an agent whose
 * owner decided nothing about it asks Studio nothing. Saying a standing in
 * public is a different decision, and is not part of this slice.
 *
 * ## It reads Studio's answer and invents nothing
 *
 * The rank, the field and the return are Studio's, computed from the paper
 * fills this agent reported. Nothing is computed here, nothing is cached, and
 * an unreachable Studio is UNAVAILABLE with a sentence that says the agent
 * cannot check. It still says what is true locally (the season mandate is in
 * place until its end) and never a rank.
 *
 * `tests/unit/noWalletCapabilities.test.ts` pins this id, its effect, its
 * audience and its default.
 */

const SOURCE = 'AI17Z Studio' as const;

const Output = z.object({
  /** UNAVAILABLE is "could not check"; NOT_ENTERED is a fact about this agent. */
  state: z.enum(['NOT_ENTERED', 'UNAVAILABLE', 'NOT_STARTED', 'PENDING', 'RANKED', 'UNRANKED']),
  source: z.literal(SOURCE),
  simulated: z.literal(true),
  season: z.string().nullable(),
  rank: z.number().int().nullable(),
  of: z.number().int().nullable(),
  returnBps: z.number().int().nullable(),
  /** The sentence to say: names Studio, says simulated and paper, never a promise. */
  statement: z.string(),
});

const standing = defineCapability({
  id: 'league.standing',
  name: 'League standing',
  description:
    "This agent's standing in the AI17Z Studio paper league season it is entered in: its rank, the size of the field and its simulated return after costs, " +
    'as Studio works them out from the paper fills this agent reported. Use when the owner asks how the agent is doing in the league. ' +
    'Always say the figures come from Studio and are simulated paper results, and never imply a future return or a real position. Call with no arguments.',
  category: 'ACCOUNT',
  effect: 'READ',
  risk: 'LOW',
  unsetPermission: 'DISABLED',
  audience: 'OWNER',
  input: z.object({}).strict(),
  output: Output,
  modelCallable: true,
  timeoutMs: 25_000,
  async readiness() {
    const link = await studioInstallationReady();
    return link.linked
      ? { status: 'AVAILABLE' as const }
      : { status: 'UNAVAILABLE' as const, why: `${link.why} Link this installation to AI17Z Studio on the Plugins screen to read a league standing.` };
  },
  async run(_input, ctx) {
    const read = await readLeagueStanding(ctx.agentId);
    const base = { source: SOURCE, simulated: true as const, season: null, rank: null, of: null, returnBps: null };
    if (!read.ok) {
      const entered = read.entry && read.entry.status !== 'REFUSED' ? { seasonSlug: read.entry.seasonSlug, endsAt: read.entry.endsAt } : null;
      if (read.code === 'NOT_ENTERED') {
        return {
          ...base,
          state: 'NOT_ENTERED' as const,
          season: read.entry?.seasonSlug ?? null,
          statement: `${read.why} There is no league standing to give, and I will not make one up.`,
        };
      }
      return {
        ...base,
        state: 'UNAVAILABLE' as const,
        season: read.entry?.seasonSlug ?? null,
        // The mandate is mentioned only while the season is still running.
        statement: describeUnavailable(read.why, entered && Date.parse(entered.endsAt) > Date.now() ? entered : null),
      };
    }
    const s = read.standing.standing;
    return {
      ...base,
      state: s.state,
      season: read.entry.seasonSlug,
      rank: s.rank,
      of: s.of,
      returnBps: s.return_bps,
      statement: describeStanding(read.standing, read.seasonTitle),
    };
  },
});

export const STUDIO_LEAGUE_CAPABILITIES = [standing] as unknown as AnyCapability[];

export function registerStudioLeagueCapabilities(): void {
  for (const capability of STUDIO_LEAGUE_CAPABILITIES) registerCapability(capability);
}
