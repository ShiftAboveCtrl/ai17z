import { z } from 'zod';

/**
 * A playbook published on AI17Z Studio, as this installation is willing to read it.
 *
 * Importing one is configuration, never code and never a person. The schema is
 * the safety property rather than a rule the importer remembers: every object
 * is `.strict()`, so a field that is not named here is a refusal, and the
 * fields that are named can only say how much a paper mandate may spend and on
 * exactly which assets.
 *
 * What is deliberately not here, because there must be nowhere to put it:
 *   - a mode, an approval mode, or anything that says live, autonomous or signed
 *   - a capability, a permission, a Plugin, a command, a script, a path or a URL
 *   - a prompt, an instruction, a persona, a stance or a relationship
 *   - a claimed result of any kind (returns, win rate, rank)
 *   - a symbol or a name for an asset: an asset is its mint and nothing else
 *
 * The text that is carried (`title`, `publisher`) is held to a plain-name
 * grammar, so it can be shown and spoken back to an owner without being able
 * to carry an instruction.
 */
export const PLAYBOOK_SCHEMA_VERSION = 1;
/** A document this large is not a playbook, whatever it says it is. */
export const MAX_PLAYBOOK_BYTES = 64 * 1024;
export const MAX_PLAYBOOK_ASSETS = 50;

/** Letters, digits and a few joiners, starting with a letter or digit. No markup, no sentence punctuation, no newline. */
const PLAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._'-]{0,59}$/;
const PLAYBOOK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SOL = z
  .string()
  .regex(/^\d{1,9}(\.\d{1,9})?$/, 'An amount of SOL, such as 0.05.');

export const PlaybookAsset = z
  .object({
    /** The Solana mint. Shape is checked again as an `AssetRef` when the plan is built. */
    mint: z.string().min(32).max(44),
    decimals: z.number().int().min(0).max(18),
  })
  .strict();

export const PlaybookLimits = z
  .object({
    maxPerTradeSol: SOL,
    maxPerDaySol: SOL,
    maxOpenExposureSol: SOL,
    maxOpenPositions: z.number().int().min(1).max(20),
    maxSlippageBps: z.number().int().min(1).max(1_000),
    maxPriceImpactBps: z.number().int().min(1).max(2_000),
    minLiquiditySol: SOL,
    maxFeeSol: SOL,
  })
  .strict();
export type PlaybookLimits = z.infer<typeof PlaybookLimits>;

export const PlaybookDocument = z
  .object({
    schema: z.literal(PLAYBOOK_SCHEMA_VERSION),
    /** Studio's id for the playbook, which is what a later version is matched on. */
    id: z.string().regex(PLAYBOOK_ID, 'A playbook id is letters, digits, dashes and underscores.'),
    version: z.number().int().min(1).max(1_000_000),
    title: z.string().regex(PLAIN_NAME, 'A title is plain words: letters, digits and a few joiners.'),
    publisher: z.string().regex(PLAIN_NAME, 'A publisher name is plain words.').nullable().default(null),
    /** The paper capital the playbook was written for. Open exposure can never exceed it here. */
    capitalSol: SOL,
    /** Exactly these assets and no others. There is no "any token" in a playbook. */
    universe: z
      .object({
        chain: z.literal('solana'),
        assets: z.array(PlaybookAsset).min(1).max(MAX_PLAYBOOK_ASSETS),
      })
      .strict(),
    limits: PlaybookLimits,
    expiresAt: z.string().datetime().nullable().default(null),
  })
  .strict();
export type PlaybookDocument = z.infer<typeof PlaybookDocument>;

/** The reference an owner gives when the playbook is fetched from Studio rather than pasted. */
export const PlaybookStudioRef = z.object({ studioId: z.string().regex(PLAYBOOK_ID) }).strict();
