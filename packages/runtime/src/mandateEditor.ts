import { agents as agentsRepo, ops, trading, wallets as walletsRepo, type TradeMandateRow } from '@xbam/database';
import { NotFoundError, ValidationError } from '@xbam/shared';
import { z } from 'zod';

/**
 * The owner writes an agent's trading mandate, in the units they think in.
 *
 * SOL amounts and percentages in, a mandate in base units and basis points
 * out, superseding the last one so what was allowed at the time stays on
 * record. Three things are deliberately not on offer here:
 *
 * - **Autonomy.** Every entry is approved by the owner, by its exact
 *   transaction. The only thing that may happen without them is a protective
 *   exit they preauthorized, and that is a sale back to SOL inside bounds they
 *   wrote (`protectiveExits.ts`).
 * - **Another chain.** This writes a Solana mandate for the pool venue a live
 *   swap uses. The other venues keep their own paths.
 * - **A live mandate without a wallet.** LIVE needs the Solana wallet that
 *   would sign, so the owner has already decided which key that is.
 */

const SOL = z
  .string()
  .trim()
  .regex(/^\d{1,9}(\.\d{1,9})?$/, 'An amount of SOL, such as 0.05.');
const lamports = (sol: string): string => {
  const [whole, frac = ''] = sol.split('.');
  return (BigInt(whole!) * 1_000_000_000n + BigInt((frac + '000000000').slice(0, 9))).toString();
};
const sol = (base: string): string => {
  const v = BigInt(base);
  const whole = v / 1_000_000_000n;
  const frac = (v % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
};
const pct = z.number().min(1).max(95);

export const OwnerMandate = z
  .object({
    mode: z.enum(['PAPER', 'LIVE']),
    assetScope: z.enum(['LISTED', 'ANY_SOLANA_TOKEN']),
    maxPerTradeSol: SOL,
    maxPerDaySol: SOL,
    maxOpenExposureSol: SOL,
    maxOpenPositions: z.number().int().min(1).max(20),
    maxSlippageBps: z.number().int().min(1).max(1_000),
    maxPriceImpactBps: z.number().int().min(1).max(2_000),
    minLiquiditySol: SOL,
    maxFeeSol: SOL,
    expiresAt: z.string().datetime().nullable(),
    protectiveExits: z
      .object({
        stopLossPct: pct.nullable(),
        trailingPct: pct.nullable(),
        liquidityFloorSol: SOL.nullable(),
        honorStudioProtective: z.boolean(),
        maxSlippageBps: z.number().int().min(1).max(3_000),
        maxPriceImpactBps: z.number().int().min(1).max(5_000),
        maxFeeSol: SOL,
      })
      .strict()
      .nullable(),
  })
  .strict();
export type OwnerMandate = z.infer<typeof OwnerMandate>;

async function ownedAgent(agentId: string, ownerId: string): Promise<void> {
  const agent = await agentsRepo.getAgent(agentId);
  if (!agent || agent.ownerId !== ownerId) throw new NotFoundError('Agent');
}

/** The mandate as the owner wrote it, in SOL and percentages, or null when there is none. */
export function ownerView(row: TradeMandateRow | null): (OwnerMandate & { id: string; paused: boolean; createdAt: string }) | null {
  if (!row) return null;
  const p = row.protectiveExits;
  return {
    id: row.id,
    paused: row.paused,
    createdAt: row.createdAt,
    mode: row.mode === 'LIVE' ? 'LIVE' : 'PAPER',
    assetScope: row.assetScope ?? 'LISTED',
    maxPerTradeSol: sol(row.maxPerTrade),
    maxPerDaySol: sol(row.maxPerDay),
    maxOpenExposureSol: sol(row.maxOpenExposure),
    maxOpenPositions: row.maxOpenPositions,
    maxSlippageBps: row.maxSlippageBps,
    maxPriceImpactBps: row.maxPriceImpactBps,
    minLiquiditySol: sol(row.minLiquidityBase),
    maxFeeSol: sol(row.maxFeeBase),
    expiresAt: row.expiresAt,
    protectiveExits: p
      ? {
          stopLossPct: p.stopLossBps === null ? null : p.stopLossBps / 100,
          trailingPct: p.trailingBps === null ? null : p.trailingBps / 100,
          liquidityFloorSol: p.liquidityFloorBase === null ? null : sol(p.liquidityFloorBase),
          honorStudioProtective: p.honorStudioProtective,
          maxSlippageBps: p.maxSlippageBps,
          maxPriceImpactBps: p.maxPriceImpactBps,
          maxFeeSol: sol(p.maxFeeBase),
        }
      : null,
  };
}

export async function mandateOf(agentId: string, ownerId: string) {
  await ownedAgent(agentId, ownerId);
  return ownerView(await trading.liveMandate(agentId));
}

/** Writes the owner's mandate, superseding the last. */
export async function writeOwnerMandate(agentId: string, ownerId: string, raw: unknown) {
  await ownedAgent(agentId, ownerId);
  const parsed = OwnerMandate.safeParse(raw);
  if (!parsed.success) throw new ValidationError(`That mandate is not complete: ${parsed.error.issues[0]?.path.join('.') || 'it'} ${parsed.error.issues[0]?.message ?? ''}`.trim());
  const m = parsed.data;
  if (BigInt(lamports(m.maxPerTradeSol)) <= 0n) throw new ValidationError('The most one trade may spend has to be more than nothing.');
  if (BigInt(lamports(m.maxPerTradeSol)) > BigInt(lamports(m.maxPerDaySol))) throw new ValidationError('One trade cannot be allowed more than a whole day.');
  if (m.mode === 'LIVE' && !(await walletsRepo.liveWallets(agentId)).some((w) => w.family === 'SOLANA')) {
    throw new ValidationError('A live mandate needs the Solana wallet that would sign. Make or restore one first.');
  }
  if (m.protectiveExits && m.protectiveExits.stopLossPct === null && m.protectiveExits.trailingPct === null && m.protectiveExits.liquidityFloorSol === null && !m.protectiveExits.honorStudioProtective) {
    throw new ValidationError('Preauthorized exits with no trigger allow nothing. Choose at least one, or turn them off.');
  }
  const row = await trading.putMandate({
    agentId,
    ownerId,
    mandate: {
      mode: m.mode,
      approval: 'OWNER_APPROVES_EACH',
      venues: ['AMM_POOL_SOLANA'],
      networks: ['solana'],
      allowedAssets: [],
      assetScope: m.assetScope,
      maxPerTrade: lamports(m.maxPerTradeSol),
      maxPerDay: lamports(m.maxPerDaySol),
      maxOpenExposure: lamports(m.maxOpenExposureSol),
      maxOpenPositions: m.maxOpenPositions,
      maxSlippageBps: m.maxSlippageBps,
      maxPriceImpactBps: m.maxPriceImpactBps,
      minLiquidityBase: lamports(m.minLiquiditySol),
      maxFeeBase: lamports(m.maxFeeSol),
      quoteMaxAgeMs: 60_000,
      expiresAt: m.expiresAt,
      paused: false,
      protectiveExits: m.protectiveExits
        ? {
            stopLossBps: m.protectiveExits.stopLossPct === null ? null : Math.round(m.protectiveExits.stopLossPct * 100),
            trailingBps: m.protectiveExits.trailingPct === null ? null : Math.round(m.protectiveExits.trailingPct * 100),
            liquidityFloorBase: m.protectiveExits.liquidityFloorSol === null ? null : lamports(m.protectiveExits.liquidityFloorSol),
            honorStudioProtective: m.protectiveExits.honorStudioProtective,
            maxSlippageBps: m.protectiveExits.maxSlippageBps,
            maxPriceImpactBps: m.protectiveExits.maxPriceImpactBps,
            maxFeeBase: lamports(m.protectiveExits.maxFeeSol),
          }
        : null,
    },
  });
  await ops.audit({ actorUserId: ownerId, action: 'mandate.written', entityType: 'agent', entityId: agentId, data: { mandateId: row.id, mode: m.mode, assetScope: m.assetScope, maxPerTradeSol: m.maxPerTradeSol, protectiveExits: m.protectiveExits !== null } });
  return ownerView(row);
}

/** The agent's own emergency stop: nothing it trades is signed while its mandate is paused, protective exits included. */
export async function pauseOwnerMandate(agentId: string, ownerId: string, paused: boolean) {
  await ownedAgent(agentId, ownerId);
  const current = await trading.liveMandate(agentId);
  if (!current) throw new ValidationError('This agent has no mandate to pause.');
  const row = await trading.setMandatePaused(current.id, paused);
  await ops.audit({ actorUserId: ownerId, action: paused ? 'mandate.paused' : 'mandate.resumed', entityType: 'agent', entityId: agentId, data: { mandateId: current.id } });
  return ownerView(row);
}
