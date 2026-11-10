import { z } from 'zod';

/**
 * A published Trader DNA study from AI17Z Studio, as this installation reads it.
 *
 * The endpoint is specified in `docs/architecture/STUDIO_TRADER_DNA.md`. This
 * file is the allowlist, in the way `studioPaperRecord.ts` is: every object is
 * `.strict()`, so a field Studio was never meant to publish (an operator note,
 * an account identity, a holding, a private cohort) refuses the whole study
 * instead of being quietly dropped.
 *
 * ## It describes a study of other people, never a position
 *
 * A study says which behaviours of a set of wallets survived the luck filters
 * and which are only reconstructed from the chain. Nothing in it is an order,
 * a signal or an instruction, and nothing in this contract has a place to put
 * one: no follow, no watch, no mandate, no price target.
 *
 * ## Published means published
 *
 * `visibility` is the literal `PUBLISHED`. An operator run or an unpublished
 * draft that reached this installation is therefore refused by the schema even
 * if a server were wrong enough to send it. The client only ever asks for a
 * published address as well; that is the structural half, this is the check on
 * what came back.
 */

/** The id grammar of a study. Checked before an id reaches a path. */
export const TRADER_DNA_STUDY_ID = /^[a-z0-9][a-z0-9_-]{2,63}$/;

/**
 * How well a behaviour is supported, weakest last.
 *
 * `SURVIVED_FILTERS` passed the multiple-testing correction and the
 * contamination checks. `RECONSTRUCTED` was rebuilt from the chain and was not
 * shown to survive them. `CANDIDATE` is a hypothesis nobody traded and which
 * the study does not claim to be real.
 */
export const TRADER_DNA_EVIDENCE_LEVELS = ['SURVIVED_FILTERS', 'RECONSTRUCTED', 'CANDIDATE'] as const;
export const TraderDnaEvidenceLevel = z.enum(TRADER_DNA_EVIDENCE_LEVELS);
export type TraderDnaEvidenceLevel = z.infer<typeof TraderDnaEvidenceLevel>;

const Decimal = z.string().regex(/^-?\d{1,12}(\.\d{1,8})?$/, 'a plain decimal number');
const Count = z.number().int().min(0).max(100_000_000);
const Instant = z.iso.datetime();
const Sentence = z.string().min(1).max(280);

/** A wallet address exactly as the study lists it: an EVM address or a Solana public key. */
export const TraderDnaWalletAddress = z.string().regex(/^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/, 'a wallet address');

export const TraderDnaBehaviour = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    summary: Sentence,
    evidence_level: TraderDnaEvidenceLevel,
    /** Observations behind this one behaviour. Zero means there is nothing to say about it. */
    sample_size: Count,
    /** The multiple-testing adjusted p-value, as a decimal string. Null when it was not tested. */
    adjusted_p: Decimal.nullable(),
  })
  .strict();
export type TraderDnaBehaviour = z.infer<typeof TraderDnaBehaviour>;

export const TraderDnaWallet = z
  .object({
    address: TraderDnaWalletAddress,
    /** A label as the study published it. Never one this installation wrote. */
    label: Sentence.nullable(),
  })
  .strict();
export type TraderDnaWallet = z.infer<typeof TraderDnaWallet>;

export const TraderDnaContaminationFlag = z
  .object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/),
    note: Sentence,
  })
  .strict();

export const TraderDnaStudy = z
  .object({
    protocol: z.literal(1),
    source: z.literal('ai17z-studio'),
    kind: z.literal('TRADER_DNA_STUDY'),
    /** Literal, so an operator run or an unpublished draft is refused rather than relayed. */
    visibility: z.literal('PUBLISHED'),
    study_id: z.string().regex(TRADER_DNA_STUDY_ID),
    title: Sentence,
    /** When Studio produced this answer. A copy that sat in a cache is recognised by its own date. */
    generated_at: Instant,
    published_at: Instant,
    window: z.object({ start: Instant, end: Instant }).strict(),
    /** The study's overall level, as Studio states it. */
    evidence_level: TraderDnaEvidenceLevel,
    sample: z.object({ wallets: Count, trades: Count }).strict(),
    costs: z
      .object({
        fee_bps: z.number().min(0).max(10_000),
        slippage_bps: z.number().min(0).max(10_000),
        note: Sentence,
      })
      .strict(),
    luck_filters: z
      .object({
        method: z.literal('BONFERRONI'),
        /** How many hypotheses were tested, which is what the correction divides by. */
        tests: Count,
        alpha: Decimal,
        survivors: Count,
      })
      .strict(),
    contamination_flags: z.array(TraderDnaContaminationFlag).max(20),
    behaviours: z.array(TraderDnaBehaviour).max(12),
    /** Only wallets the study itself published. This installation adds none and ranks none. */
    wallets: z.array(TraderDnaWallet).max(20),
  })
  .strict()
  .superRefine((study, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (Date.parse(study.window.end) < Date.parse(study.window.start)) fail('The window ends before it starts.');
    if (study.luck_filters.survivors > study.luck_filters.tests) fail('More survivors than hypotheses tested.');
    // The count is a floor: a study cannot name more surviving behaviours than it says survived.
    const named = study.behaviours.filter((b) => b.evidence_level === 'SURVIVED_FILTERS').length;
    if (study.luck_filters.survivors < named) fail('Fewer survivors than behaviours that say they survived.');
    for (const b of study.behaviours) {
      if (b.evidence_level === 'SURVIVED_FILTERS' && b.adjusted_p === null) fail('A behaviour that survived the filters states its adjusted p-value.');
    }
    if (study.evidence_level === 'SURVIVED_FILTERS' && !study.behaviours.some((b) => b.evidence_level === 'SURVIVED_FILTERS')) {
      fail('A study that says its findings survived the filters names at least one that did.');
    }
    if (new Set(study.behaviours.map((b) => b.id)).size !== study.behaviours.length) fail('Two behaviours share an id.');
  });
export type TraderDnaStudy = z.infer<typeof TraderDnaStudy>;
