import { z } from 'zod';
import { defineCapability, registerCapability, type AnyCapability } from '@xbam/tools';
import { PaperRecordWindow } from '@xbam/shared/contracts';
import { describePaperRecord } from './studioPaperVoice';
import { studioLinkReadiness, studioPaperRecord } from './studioLink';

/**
 * What an agent may say about its owner's paper trading on AI17Z Studio.
 *
 * One read, shaped like `wallet.*`: `audience: 'OWNER'`, so it is never offered
 * in a public conversation and is refused if one names it, and
 * `unsetPermission: 'DISABLED'`, so an agent whose owner decided nothing about
 * it does not read Studio at all. What an agent says about simulated results in
 * public is a different decision with its own switches, in `studioPaperVoice.ts`.
 *
 * ## It is a read of Studio's published record, and nothing else
 *
 * The figures come from the owner's linked Studio over the installation's own
 * DPoP-bound request (`studioPaperRecord`). There is no figure computed here,
 * no local paper engine consulted and nothing remembered between calls: an
 * unreachable Studio is UNAVAILABLE with a sentence, never the last good answer
 * said again as though it were current.
 *
 * `tests/unit/noWalletCapabilities.test.ts` pins this id, its effect, its
 * audience and its default beside the wallet reads.
 */

const SOURCE = 'AI17Z Studio' as const;

const Decision = z.object({ at: z.string(), summary: z.string(), url: z.string() });

const Output = z.object({
  /** UNAVAILABLE is "could not check"; MISSING and NO_TRADES are things Studio said. */
  state: z.enum(['TRADED', 'NO_TRADES', 'MISSING', 'UNAVAILABLE']),
  /** Which way a traded window went. Null when nothing traded or nothing is known. */
  outcome: z.enum(['GAIN', 'LOSS', 'FLAT']).nullable(),
  /** Every number below belongs to this. */
  source: z.literal(SOURCE),
  simulated: z.literal(true),
  window: z.object({ label: z.string(), start: z.string(), end: z.string(), complete: z.boolean() }).nullable(),
  /** The sentence to say, attributed to Studio and saying simulated and paper. */
  statement: z.string(),
  decisions: z.array(Decision),
});

async function ready() {
  const link = await studioLinkReadiness();
  return link.linked
    ? { status: 'AVAILABLE' as const }
    : { status: 'UNAVAILABLE' as const, why: `${link.why} Link this installation to AI17Z Studio on the Plugins screen to read a paper record.` };
}

const paperRecord = defineCapability({
  id: 'studio.paper_record',
  name: 'Studio paper record',
  description:
    "The owner's simulated paper trading record as AI17Z Studio publishes it: trades, wins and losses, net result, assumed costs, " +
    'how open positions were treated, and links to what was decided. Use when the owner asks how your paper trading is going. ' +
    'Always say the figures come from Studio and are simulated paper results, give the dates, and never imply a future return or a live position.',
  category: 'ACCOUNT',
  effect: 'READ',
  risk: 'LOW',
  unsetPermission: 'DISABLED',
  audience: 'OWNER',
  input: z.object({ window: PaperRecordWindow.default('30d') }),
  output: Output,
  modelCallable: true,
  timeoutMs: 25_000,
  readiness: ready,
  async run(input) {
    const read = await studioPaperRecord(input.window);
    if (!read.ok) {
      return {
        state: 'UNAVAILABLE' as const,
        outcome: null,
        source: SOURCE,
        simulated: true as const,
        window: null,
        statement: `I cannot check the simulated paper record on Studio right now. ${read.why} I will not guess at it.`,
        decisions: [],
      };
    }
    const { record } = read;
    const { outcome, statement } = describePaperRecord(record);
    return {
      state: record.state,
      outcome,
      source: SOURCE,
      simulated: true as const,
      window: { label: record.window.label, start: record.window.start, end: record.window.end, complete: record.window.complete },
      statement,
      decisions: record.decisions.map((d) => ({ at: d.at, summary: d.summary, url: d.url })),
    };
  },
});

export const STUDIO_PAPER_CAPABILITIES = [paperRecord] as unknown as AnyCapability[];

export function registerStudioPaperCapabilities(): void {
  for (const capability of STUDIO_PAPER_CAPABILITIES) registerCapability(capability);
}
