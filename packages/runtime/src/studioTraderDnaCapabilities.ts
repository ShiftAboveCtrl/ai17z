import { z } from 'zod';
import { defineCapability, registerCapability, type AnyCapability } from '@xbam/tools';
import { TRADER_DNA_EVIDENCE_LEVELS, TRADER_DNA_STUDY_ID } from '@xbam/shared/contracts';
import { studioInstallationReady } from './studioLink';
import { describeTraderDna, describeTraderDnaUnavailable, readTraderDnaStudy } from './studioTraderDna';

/**
 * "What did that Trader DNA study find", for the owner, and nothing else.
 *
 * Shaped like `league.standing` and the Studio paper record: effect READ, risk
 * LOW, `audience: 'OWNER'` so it is never offered in a public conversation and
 * is refused if one names it, and `unsetPermission: 'DISABLED'` so an agent whose
 * owner decided nothing about it asks Studio nothing.
 *
 * ## Explains the study; has no way to follow it
 *
 * This is the whole surface: one read of one published study. It adds no watch,
 * imports no wallet as a setup, creates no mandate and no order, and no other
 * capability is registered beside it. The wallet addresses in the output are the
 * ones the study published, passed through; this file ranks, scores and picks
 * none. `tests/unit/noWalletCapabilities.test.ts` and
 * `tests/unit/studioTraderDna.test.ts` pin the id, the effect, the audience, the
 * default and the absence of a write or follow verb.
 *
 * Saying anything about a study in public is a different decision with its own
 * switches, in `studioTraderDna.ts`.
 */

const SOURCE = 'AI17Z Studio' as const;

const Output = z.object({
  /** UNAVAILABLE is "could not give a result": unreachable, unpublished, empty or stale. */
  state: z.enum(['AVAILABLE', 'UNAVAILABLE']),
  source: z.literal(SOURCE),
  studyId: z.string(),
  /** Always true. The sentence it stands for is also the end of every statement. */
  nothingTraded: z.literal(true),
  evidenceLevel: z.enum(TRADER_DNA_EVIDENCE_LEVELS).nullable(),
  sample: z.object({ wallets: z.number().int(), trades: z.number().int() }).nullable(),
  costAssumption: z.object({ feeBps: z.number(), slippageBps: z.number(), note: z.string() }).nullable(),
  window: z.object({ start: z.string(), end: z.string() }).nullable(),
  behaviours: z.array(
    z.object({
      summary: z.string(),
      evidenceLevel: z.enum(TRADER_DNA_EVIDENCE_LEVELS),
      sampleSize: z.number().int(),
      adjustedP: z.string().nullable(),
    }),
  ),
  contaminationFlags: z.array(z.string()),
  /** As the study published them. Nothing here says a wallet is worth following. */
  wallets: z.array(z.object({ address: z.string(), label: z.string().nullable() })),
  statement: z.string(),
});

const study = defineCapability({
  id: 'studio.trader_dna',
  name: 'Studio Trader DNA study',
  description:
    'A published Trader DNA study from AI17Z Studio: which trading behaviours of a set of wallets survived the luck filters and which are only reconstructed, ' +
    'with the evidence level, sample size, assumed costs and window. Use when the owner asks about a study, smart wallets or what a wallet study found. ' +
    'Always give the evidence level, the sample, the costs and the dates, say nothing was traded, and never call a wallet smart or worth copying or following. ' +
    'Takes the id of a published study.',
  category: 'ACCOUNT',
  effect: 'READ',
  risk: 'LOW',
  unsetPermission: 'DISABLED',
  audience: 'OWNER',
  input: z.object({ study: z.string().regex(TRADER_DNA_STUDY_ID, 'the id of a published study') }).strict(),
  output: Output,
  modelCallable: true,
  timeoutMs: 25_000,
  async readiness() {
    const link = await studioInstallationReady();
    return link.linked
      ? { status: 'AVAILABLE' as const }
      : { status: 'UNAVAILABLE' as const, why: `${link.why} Link this installation to AI17Z Studio on the Plugins screen to read a Trader DNA study.` };
  },
  async run(input) {
    const empty = {
      source: SOURCE,
      studyId: input.study,
      nothingTraded: true as const,
      evidenceLevel: null,
      sample: null,
      costAssumption: null,
      window: null,
      behaviours: [],
      contaminationFlags: [],
      wallets: [],
    };
    const read = await readTraderDnaStudy(input.study);
    if (!read.ok) return { ...empty, state: 'UNAVAILABLE' as const, statement: describeTraderDnaUnavailable(read.why).statement };

    const { study: s } = read;
    const said = describeTraderDna(s);
    // No figure leaves this function for a study the statement itself refused.
    if (said.state === 'UNAVAILABLE') {
      return { ...empty, state: 'UNAVAILABLE' as const, statement: said.statement };
    }
    return {
      ...empty,
      state: 'AVAILABLE' as const,
      studyId: s.study_id,
      evidenceLevel: s.evidence_level,
      sample: { wallets: s.sample.wallets, trades: s.sample.trades },
      costAssumption: { feeBps: s.costs.fee_bps, slippageBps: s.costs.slippage_bps, note: s.costs.note },
      window: { start: s.window.start, end: s.window.end },
      behaviours: s.behaviours.map((b) => ({ summary: b.summary, evidenceLevel: b.evidence_level, sampleSize: b.sample_size, adjustedP: b.adjusted_p })),
      contaminationFlags: s.contamination_flags.map((f) => f.code),
      wallets: s.wallets.map((w) => ({ address: w.address, label: w.label })),
      statement: said.statement,
    };
  },
});

export const STUDIO_TRADER_DNA_CAPABILITIES = [study] as unknown as AnyCapability[];

export function registerStudioTraderDnaCapabilities(): void {
  for (const capability of STUDIO_TRADER_DNA_CAPABILITIES) registerCapability(capability);
}
