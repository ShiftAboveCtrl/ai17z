import { z } from 'zod';
import { SignalWatch } from './radar';

export const STUDIO_RISK_PATH = '/api/v1/installation/risk-watches';
export const STUDIO_RISK_SNAPSHOT_MS = 15 * 60_000;
export const StudioRiskKind = z.enum(['LIQUIDITY_BELOW', 'TOP_HOLDERS_ABOVE', 'DEVELOPER_SHARE_ABOVE']);
const Mint = SignalWatch.shape.address.refine(value => !value.startsWith('0x'), 'Use an exact Solana mint.');
const Time = z.string().datetime({ offset: true });
export const StudioRiskWatch = z.object({
  id: z.string().uuid(), mint: Mint, kind: StudioRiskKind,
  threshold: z.number().finite().positive().max(1e12),
  interval_seconds: z.number().int().min(900).max(86400),
}).strict().refine(w => w.kind === 'LIQUIDITY_BELOW' || (w.threshold >= 0.1 && w.threshold <= 99.9), 'A share threshold is between 0.1 and 99.9 percent.');
export type StudioRiskWatch = z.infer<typeof StudioRiskWatch>;
export const StudioRiskWatchlist = z.object({
  protocol: z.literal(1), generated_at: Time,
  watches: z.array(StudioRiskWatch).max(5).refine(
    watches => new Set(watches.map(w => w.id)).size === watches.length && new Set(watches.map(w => `${w.mint}:${w.kind}`)).size === watches.length,
    'Each watch identity and mint condition must be unique.',
  ),
}).strict();
const Reading = z.object({ value: z.number().finite().nonnegative().max(1e15), observed_at: Time }).strict();
export const StudioRiskObservation = z.object({
  observation_id: z.string().regex(/^[a-f0-9]{64}$/), watch_id: z.string().uuid(),
  watch_revision: z.string().regex(/^[a-f0-9]{64}$/),
  source: z.literal('jupiter'), mint: Mint,
  before: Reading.nullable(), after: Reading,
}).strict();
export type StudioRiskObservation = z.infer<typeof StudioRiskObservation>;
export const StudioRiskObservationBatch = z.object({
  protocol: z.literal(1), observations: z.array(StudioRiskObservation).min(1).max(50),
}).strict();
export const StudioRiskAcknowledgement = z.object({
  protocol: z.literal(1), accepted: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(50),
}).strict();
