import { createHash } from 'node:crypto';
import { agents as agentsRepo, ops, playbooks, trading, type PlaybookPinRow, type TradeMandateRow } from '@xbam/database';
import { NotFoundError, ValidationError } from '@xbam/shared';
import {
  AssetRef,
  MAX_PLAYBOOK_BYTES,
  PlaybookDocument,
  PlaybookStudioRef,
  TradeMandate,
  assetKey,
  type AssetRef as Asset,
} from '@xbam/shared/contracts';
import { lamportsToSol, solToLamports } from './mandateEditor';
import { studioPlaybook } from './studioLink';

/**
 * Running a published playbook on the local agent.
 *
 * A playbook is configuration for a PAPER mandate and the list of assets that
 * mandate may touch, and that is all it can be. The decision of what a document
 * may say is the schema in `contracts/playbook.ts`; the decision of what is
 * applied is made here, in one pure function (`planPlaybook`), so the preview
 * an owner reads and the write that follows are the same computation and
 * cannot disagree.
 *
 * ## What an import can never do
 *
 * - It writes mode PAPER and approval OWNER_APPROVES_EACH as literals. No
 *   document field is read for either, and there is nowhere in the schema to
 *   put one.
 * - It never reads a wallet and never touches capability permissions. It writes
 *   a mandate row and a pin row, in one transaction, and an audit row.
 * - It never widens the owner's own ceiling. Where the owner wrote the current
 *   mandate, each limit is the tighter of the two, and the preview says which
 *   rows were narrowed and by what.
 * - It refuses to replace a LIVE mandate. Replacing one with paper would
 *   silently end somebody's live configuration; the owner switches it
 *   themselves first.
 * - It never inherits a pause: a paused mandate stays paused.
 *
 * ## Versions are pins, not overwrites
 *
 * Each import writes a new mandate row and a new pin and retires the old ones;
 * nothing is edited. The same version with different content is refused, since
 * a version that can change is not a pin. Whether the agent still runs the pin
 * is computed from the current mandate, so an owner's own edit afterwards turns
 * the status to EDITED rather than leaving a claim that is no longer true.
 */

export type PlaybookSource = { document: unknown } | { studioId: string };

export interface PlaybookLimitRow {
  key: string;
  label: string;
  /** What the playbook says. */
  published: string;
  /** What would be written. */
  effective: string;
  /** What the agent holds now, or null when it has no mandate. */
  current: string | null;
  narrowedBy: 'YOUR_MANDATE' | 'PLAYBOOK_CAPITAL' | null;
  /** True when the written value lets the agent do more than the current mandate does. */
  widensCurrent: boolean;
}

export interface PlaybookPreview {
  sha256: string;
  playbook: { id: string; version: number; title: string; publisher: string | null };
  /** Fixed facts, shown because an owner should be able to read them rather than assume them. */
  mode: 'PAPER';
  approval: 'OWNER_APPROVES_EACH';
  capitalSol: string;
  expiresAt: string | null;
  limits: PlaybookLimitRow[];
  universe: Array<{ mint: string; decimals: number }>;
  replaces: { title: string; version: number } | null;
  /** The mandate is already this exact version and has not been edited. */
  alreadyRunning: boolean;
  notes: string[];
}

export type PlaybookRefusal = { ok: false; why: string };

export const PLAYBOOK_PROMISES = [
  'It is written as a paper mandate. Nothing here can make it live, autonomous or able to sign.',
  'Every entry still waits for you to approve it.',
  'No capability, permission or wallet is changed.',
  'Only the assets listed are in its universe, by exact mint.',
] as const;

// ---------------------------------------------------------------------------
// Reading a document nobody vouched for
// ---------------------------------------------------------------------------

/** Keys are echoed back in a sentence, so only a key that is harmless to print is named. */
function nameKey(key: string): string {
  return /^[A-Za-z0-9_.-]{1,32}$/.test(key) ? `"${key}"` : 'an unnamed field';
}

export function parsePlaybook(raw: unknown): { ok: true; doc: PlaybookDocument; sha256: string } | PlaybookRefusal {
  let size: number;
  try {
    size = JSON.stringify(raw)?.length ?? 0;
  } catch {
    return { ok: false, why: 'That is not a playbook. Nothing was imported.' };
  }
  if (size > MAX_PLAYBOOK_BYTES) return { ok: false, why: 'That document is too large to be a playbook. Nothing was imported.' };
  const parsed = PlaybookDocument.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    if (issue.code === 'unrecognized_keys') {
      const names = issue.keys.slice(0, 3).map(nameKey).join(', ');
      return { ok: false, why: `This playbook carries ${names}, which AI17Z does not accept in a playbook. Nothing was imported and the agent is unchanged.` };
    }
    const where = issue.path.slice(0, 4).map((p) => (typeof p === 'number' ? `#${p + 1}` : String(p).slice(0, 24))).join('.');
    return { ok: false, why: `This playbook is not valid${where ? ` at ${where}` : ''}: ${issue.message.slice(0, 160)} Nothing was imported and the agent is unchanged.` };
  }
  // Serialised in the schema's own key order, so the digest does not depend on the order the sender wrote them.
  const sha256 = createHash('sha256').update(JSON.stringify(parsed.data)).digest('hex');
  return { ok: true, doc: parsed.data, sha256 };
}

// ---------------------------------------------------------------------------
// The plan: one pure function, used by the preview and by the write
// ---------------------------------------------------------------------------

type MandateBody = Omit<TradeMandate, 'id' | 'agentId'>;

export type PlaybookPlan =
  | { kind: 'REFUSE'; why: string }
  | { kind: 'UNCHANGED'; pin: PlaybookPinRow; preview: PlaybookPreview }
  | { kind: 'APPLY'; mandate: MandateBody; effective: Record<string, unknown>; preview: PlaybookPreview };

const earliest = (a: string | null, b: string | null): string | null => (a && b ? (Date.parse(a) <= Date.parse(b) ? a : b) : (a ?? b));

export function planPlaybook(
  doc: PlaybookDocument,
  sha256: string,
  current: TradeMandateRow | null,
  pinned: PlaybookPinRow | null,
  options: { allowDowngrade?: boolean; now?: Date } = {},
): PlaybookPlan {
  const now = options.now ?? new Date();
  if (current?.mode === 'LIVE') {
    return { kind: 'REFUSE', why: 'This agent has a live mandate. A playbook only ever writes a paper one, so switch the mandate to paper yourself first. The agent is unchanged.' };
  }
  if (doc.expiresAt && Date.parse(doc.expiresAt) <= now.getTime()) {
    return { kind: 'REFUSE', why: 'This playbook has already expired. The agent is unchanged.' };
  }
  const samePlaybook = pinned && pinned.playbookId === doc.id;
  if (samePlaybook && doc.version < pinned.version && !options.allowDowngrade) {
    return { kind: 'REFUSE', why: `This is version ${doc.version} and the agent runs version ${pinned.version}. Going back to an older version has to be asked for. The agent is unchanged.` };
  }
  if (samePlaybook && doc.version === pinned.version && pinned.contentSha256 !== sha256) {
    return { kind: 'REFUSE', why: `Studio now serves different content for version ${doc.version} than the one this agent runs. A version never changes, so this is refused and the agent is unchanged.` };
  }

  const assets: Asset[] = [];
  const seen = new Set<string>();
  for (const [i, a] of doc.universe.assets.entries()) {
    const ref = AssetRef.safeParse({ kind: 'ONCHAIN', network: 'solana', address: a.mint, decimals: a.decimals });
    if (!ref.success) return { kind: 'REFUSE', why: `Asset #${i + 1} is not a Solana mint. The agent is unchanged.` };
    const key = assetKey(ref.data);
    if (seen.has(key)) return { kind: 'REFUSE', why: `Asset #${i + 1} is listed twice. The agent is unchanged.` };
    seen.add(key);
    assets.push(ref.data);
  }

  const ownerWritten = Boolean(current && !(pinned && pinned.mandateId === current.id));
  const cap = BigInt(solToLamports(doc.capitalSol));
  if (cap <= 0n) return { kind: 'REFUSE', why: 'The playbook has no capital to trade with. The agent is unchanged.' };
  const L = doc.limits;
  const pub = {
    trade: BigInt(solToLamports(L.maxPerTradeSol)),
    day: BigInt(solToLamports(L.maxPerDaySol)),
    exposure: BigInt(solToLamports(L.maxOpenExposureSol)),
    liquidity: BigInt(solToLamports(L.minLiquiditySol)),
    fee: BigInt(solToLamports(L.maxFeeSol)),
  };
  if (pub.trade <= 0n) return { kind: 'REFUSE', why: 'The most one trade may spend has to be more than nothing. The agent is unchanged.' };
  if (pub.trade > pub.day) return { kind: 'REFUSE', why: 'One trade cannot be allowed more than a whole day. The agent is unchanged.' };

  // Each limit is the tightest of: what was published, what the capital allows,
  // and what the owner already holds. The owner's own mandate is a ceiling only
  // where the owner wrote it; one a playbook produced is shown as a change
  // instead, because the owner never chose it.
  const c = ownerWritten ? current! : null;
  const by = (published: bigint, ceiling: bigint | null, capital: bigint | null): { v: bigint; by: PlaybookLimitRow['narrowedBy'] } => {
    let v = published;
    let who: PlaybookLimitRow['narrowedBy'] = null;
    if (capital !== null && capital < v) { v = capital; who = 'PLAYBOOK_CAPITAL'; }
    if (ceiling !== null && ceiling < v) { v = ceiling; who = 'YOUR_MANDATE'; }
    return { v, by: who };
  };
  const trade0 = by(pub.trade, c ? BigInt(c.maxPerTrade) : null, cap);
  const day = by(pub.day, c ? BigInt(c.maxPerDay) : null, null);
  const trade = trade0.v > day.v ? { v: day.v, by: day.by ?? ('YOUR_MANDATE' as const) } : trade0;
  const exposure = by(pub.exposure, c ? BigInt(c.maxOpenExposure) : null, cap);
  const positions = by(BigInt(L.maxOpenPositions), c ? BigInt(c.maxOpenPositions) : null, null);
  const slippage = by(BigInt(L.maxSlippageBps), c ? BigInt(c.maxSlippageBps) : null, null);
  const impact = by(BigInt(L.maxPriceImpactBps), c ? BigInt(c.maxPriceImpactBps) : null, null);
  const fee = by(pub.fee, c ? BigInt(c.maxFeeBase) : null, null);
  // A higher liquidity floor is the stricter one.
  const liqCeiling = c ? BigInt(c.minLiquidityBase) : null;
  const liquidity = liqCeiling !== null && liqCeiling > pub.liquidity ? { v: liqCeiling, by: 'YOUR_MANDATE' as const } : { v: pub.liquidity, by: null };
  const expiresAt = earliest(doc.expiresAt, c?.expiresAt ?? null);

  if (trade.v <= 0n || day.v <= 0n || positions.v <= 0n) {
    return { kind: 'REFUSE', why: 'Your own mandate leaves this playbook nothing it may spend or hold, so there is nothing to apply. The agent is unchanged.' };
  }

  const mandate: MandateBody = {
    // Literals. No field of the document is read for either.
    mode: 'PAPER',
    approval: 'OWNER_APPROVES_EACH',
    venues: ['AMM_POOL_SOLANA'],
    networks: ['solana'],
    allowedAssets: assets,
    assetScope: 'LISTED',
    maxPerTrade: trade.v.toString(),
    maxPerDay: day.v.toString(),
    maxOpenExposure: exposure.v.toString(),
    maxOpenPositions: Number(positions.v),
    maxSlippageBps: Number(slippage.v),
    maxPriceImpactBps: Number(impact.v),
    minLiquidityBase: liquidity.v.toString(),
    maxFeeBase: fee.v.toString(),
    // An existing tighter quote age is kept; a playbook has no say in it.
    quoteMaxAgeMs: current ? Math.min(60_000, current.quoteMaxAgeMs) : 60_000,
    expiresAt,
    // An emergency stop is never lifted by an import.
    paused: current?.paused ?? false,
    protectiveExits: null,
  };
  const valid = TradeMandate.omit({ id: true, agentId: true }).safeParse(mandate);
  if (!valid.success) return { kind: 'REFUSE', why: `The mandate this would write is not valid (${valid.error.issues[0]?.message.slice(0, 120) ?? 'unknown'}). The agent is unchanged.` };

  const row = (key: string, label: string, published: string, effective: string, now: string | null, narrowedBy: PlaybookLimitRow['narrowedBy'], widens: boolean): PlaybookLimitRow => ({
    key, label, published, effective, current: now, narrowedBy, widensCurrent: widens,
  });
  const sols = (v: bigint) => `${lamportsToSol(v.toString())} SOL`;
  const cur = current;
  const limits: PlaybookLimitRow[] = [
    row('maxPerTrade', 'Most one trade may spend', sols(pub.trade), sols(trade.v), cur ? sols(BigInt(cur.maxPerTrade)) : null, trade.by, Boolean(cur) && trade.v > BigInt(cur!.maxPerTrade)),
    row('maxPerDay', 'Most in a day', sols(pub.day), sols(day.v), cur ? sols(BigInt(cur.maxPerDay)) : null, day.by, Boolean(cur) && day.v > BigInt(cur!.maxPerDay)),
    row('maxOpenExposure', 'Most held at once', sols(pub.exposure), sols(exposure.v), cur ? sols(BigInt(cur.maxOpenExposure)) : null, exposure.by, Boolean(cur) && exposure.v > BigInt(cur!.maxOpenExposure)),
    row('maxOpenPositions', 'Open positions', String(L.maxOpenPositions), String(positions.v), cur ? String(cur.maxOpenPositions) : null, positions.by, Boolean(cur) && positions.v > BigInt(cur!.maxOpenPositions)),
    row('maxSlippageBps', 'Slippage ceiling (bps)', String(L.maxSlippageBps), String(slippage.v), cur ? String(cur.maxSlippageBps) : null, slippage.by, Boolean(cur) && slippage.v > BigInt(cur!.maxSlippageBps)),
    row('maxPriceImpactBps', 'Price impact ceiling (bps)', String(L.maxPriceImpactBps), String(impact.v), cur ? String(cur.maxPriceImpactBps) : null, impact.by, Boolean(cur) && impact.v > BigInt(cur!.maxPriceImpactBps)),
    row('minLiquidity', 'Least liquidity it will trade into', sols(pub.liquidity), sols(liquidity.v), cur ? sols(BigInt(cur.minLiquidityBase)) : null, liquidity.by, Boolean(cur) && liquidity.v < BigInt(cur!.minLiquidityBase)),
    row('maxFee', 'Most in fees per trade', sols(pub.fee), sols(fee.v), cur ? sols(BigInt(cur.maxFeeBase)) : null, fee.by, Boolean(cur) && fee.v > BigInt(cur!.maxFeeBase)),
  ];
  const notes: string[] = [];
  if (limits.some((l) => l.narrowedBy === 'YOUR_MANDATE')) notes.push('Where your own mandate is tighter than the playbook, yours applies. A playbook never widens what you set.');
  if (limits.some((l) => l.narrowedBy === 'PLAYBOOK_CAPITAL')) notes.push('No limit is allowed to exceed the playbook\'s own capital.');
  if (current?.paused) notes.push('Your mandate is paused, and it stays paused.');
  if (current?.protectiveExits) notes.push('Preauthorised exits are not part of a playbook. They apply to a live mandate only and are cleared from this paper one.');
  if (ownerWritten) notes.push('Your current mandate was written by you. This replaces it with a new one and keeps the old one on record.');

  const preview: PlaybookPreview = {
    sha256,
    playbook: { id: doc.id, version: doc.version, title: doc.title, publisher: doc.publisher },
    mode: 'PAPER',
    approval: 'OWNER_APPROVES_EACH',
    capitalSol: doc.capitalSol,
    expiresAt,
    limits,
    universe: doc.universe.assets.map((a) => ({ mint: a.mint, decimals: a.decimals })),
    replaces: pinned ? { title: pinned.title, version: pinned.version } : null,
    alreadyRunning: false,
    notes,
  };

  if (samePlaybook && doc.version === pinned.version && current?.id === pinned.mandateId) {
    return { kind: 'UNCHANGED', pin: pinned, preview: { ...preview, alreadyRunning: true } };
  }
  return {
    kind: 'APPLY',
    mandate,
    effective: { mandateLimits: Object.fromEntries(limits.map((l) => [l.key, l.effective])), universe: mandate.allowedAssets.length, expiresAt },
    preview,
  };
}

// ---------------------------------------------------------------------------
// The owner's two steps
// ---------------------------------------------------------------------------

async function ownedAgent(agentId: string, ownerId: string): Promise<void> {
  const agent = await agentsRepo.getAgent(agentId);
  if (!agent || agent.ownerId !== ownerId) throw new NotFoundError('Agent');
}

async function readSource(source: PlaybookSource): Promise<{ ok: true; raw: unknown } | PlaybookRefusal> {
  if ('studioId' in source) {
    const ref = PlaybookStudioRef.safeParse(source);
    if (!ref.success) return { ok: false, why: 'That is not a playbook id. Nothing was imported.' };
    const got = await studioPlaybook(ref.data.studioId);
    if (!got.ok) return { ok: false, why: `${got.why} The agent is unchanged.` };
    return { ok: true, raw: got.document };
  }
  return { ok: true, raw: source.document };
}

/** Read, parse and plan. Writes nothing. */
export async function previewPlaybook(
  agentId: string,
  ownerId: string,
  source: PlaybookSource,
  options: { allowDowngrade?: boolean; now?: Date } = {},
): Promise<{ ok: true; preview: PlaybookPreview; promises: readonly string[] } | PlaybookRefusal> {
  await ownedAgent(agentId, ownerId);
  const read = await readSource(source);
  if (!read.ok) return read;
  const parsed = parsePlaybook(read.raw);
  if (!parsed.ok) return parsed;
  const [current, pinned] = await Promise.all([trading.liveMandate(agentId), playbooks.livePin(agentId)]);
  const plan = planPlaybook(parsed.doc, parsed.sha256, current, pinned, options);
  if (plan.kind === 'REFUSE') return { ok: false, why: plan.why };
  return { ok: true, preview: plan.preview, promises: PLAYBOOK_PROMISES };
}

/**
 * Apply exactly what was previewed.
 *
 * The owner confirms a digest. The playbook is read again, so a Studio that has
 * changed its mind between the preview and the click produces a different
 * digest and a refusal, not a silent import of something nobody looked at.
 */
export async function confirmPlaybook(
  agentId: string,
  ownerId: string,
  source: PlaybookSource,
  expectedSha256: string,
  options: { allowDowngrade?: boolean; now?: Date } = {},
): Promise<{ ok: true; preview: PlaybookPreview; unchanged: boolean } | PlaybookRefusal> {
  await ownedAgent(agentId, ownerId);
  const read = await readSource(source);
  if (!read.ok) return read;
  const parsed = parsePlaybook(read.raw);
  if (!parsed.ok) return parsed;
  if (parsed.sha256 !== expectedSha256) {
    return { ok: false, why: 'The playbook is not the one you were shown: it has changed since the preview. Look at it again. The agent is unchanged.' };
  }
  let preview: PlaybookPreview | null = null;
  const result = await playbooks.applyPin(agentId, ownerId, (current, pinned) => {
    // Decided against what is in the database now, under the agent's lock.
    const plan = planPlaybook(parsed.doc, parsed.sha256, current, pinned, options);
    if (plan.kind === 'REFUSE') return { kind: 'REFUSE', why: plan.why };
    preview = plan.preview;
    if (plan.kind === 'UNCHANGED') return { kind: 'UNCHANGED', pin: plan.pin };
    return {
      kind: 'APPLY',
      mandate: plan.mandate,
      pin: {
        playbookId: parsed.doc.id,
        version: parsed.doc.version,
        title: parsed.doc.title,
        contentSha256: parsed.sha256,
        document: parsed.doc as unknown as Record<string, unknown>,
        effective: plan.effective,
      },
    };
  });
  if (result.kind === 'REFUSED') return { ok: false, why: result.why };
  if (result.kind === 'UNCHANGED') return { ok: true, preview: preview!, unchanged: true };
  await ops.audit({
    actorUserId: ownerId,
    action: 'playbook.imported',
    entityType: 'agent',
    entityId: agentId,
    data: {
      playbookId: parsed.doc.id,
      version: parsed.doc.version,
      sha256: parsed.sha256,
      mandateId: result.mandate.id,
      replaced: result.replaced ? { version: result.replaced.version, playbookId: result.replaced.playbookId } : null,
    },
  });
  return { ok: true, preview: preview!, unchanged: false };
}

// ---------------------------------------------------------------------------
// What the agent says it runs
// ---------------------------------------------------------------------------

export interface PlaybookStatus {
  /** RUNNING: the mandate is the one this import wrote. EDITED: the owner has changed the mandate since. */
  state: 'RUNNING' | 'EDITED';
  playbookId: string;
  version: number;
  title: string;
  importedAt: string;
  sentence: string;
}

/** Which playbook and version the agent runs, or null when it runs none. Computed, never stored. */
export async function playbookStatus(agentId: string): Promise<PlaybookStatus | null> {
  const [pin, current] = await Promise.all([playbooks.livePin(agentId), trading.liveMandate(agentId)]);
  if (!pin) return null;
  const running = current?.id === pin.mandateId;
  return {
    state: running ? 'RUNNING' : 'EDITED',
    playbookId: pin.playbookId,
    version: pin.version,
    title: pin.title,
    importedAt: pin.importedAt,
    sentence: running
      ? `Its paper mandate is set from the playbook "${pin.title}" (${pin.playbookId}), version ${pin.version}, imported ${pin.importedAt.slice(0, 10)}.`
      : `It was set up from the playbook "${pin.title}" (${pin.playbookId}) version ${pin.version}, but its mandate has been changed since, so it no longer runs that playbook as published.`,
  };
}

export async function playbookStatusFor(agentId: string, ownerId: string): Promise<PlaybookStatus | null> {
  await ownedAgent(agentId, ownerId);
  return playbookStatus(agentId);
}

/**
 * The asset universe a running playbook gives the agent, for the signal radar
 * and anything else that wants to look only where the playbook looks.
 *
 * Null when no playbook is running, and when the owner has edited the mandate
 * since: a universe the owner has moved on from is not one to keep reading.
 * The assets are the exact mints in the mandate, never names.
 */
export async function playbookUniverse(agentId: string): Promise<Asset[] | null> {
  const [pin, current] = await Promise.all([playbooks.livePin(agentId), trading.liveMandate(agentId)]);
  if (!pin || !current || current.id !== pin.mandateId) return null;
  return current.allowedAssets;
}

/** The sentence an API caller is given when a request is refused. */
export function refusalError(refusal: PlaybookRefusal): ValidationError {
  return new ValidationError(refusal.why);
}
