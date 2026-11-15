import { SOLANA_FAMILY, ask, isAddress, type SolanaQuery, type SolanaResult } from '@xbam/upstream';
import type { DeployerHistory } from '@xbam/prompts';

/**
 * Who created a Solana mint, read from the chain, for the evidence card.
 *
 * The address is the fee payer of the mint's own creation transaction: the
 * oldest signature that touched the mint, and only when that transaction
 * contains an `initializeMint` for exactly this mint. Nothing here comes from a
 * post, a handle or an index's say-so.
 *
 * **Absent is never zero.** A mint with a thousand or more signatures cannot
 * have its oldest one proved with a single page, so the answer is "unavailable"
 * rather than the oldest one seen. A failed read, a failed transaction or a
 * creation this cannot recognise are the same answer.
 *
 * The creation fee payer is not necessarily a person: a launchpad can pay for
 * the launches it relays. The card says "creation fee payer" for that reason.
 */

const PAGE = 1000;
/** A creator never changes, so a proved answer is kept. Bounded so a long run cannot grow it for ever. */
const KNOWN_LIMIT = 500;
const known = new Map<string, { address: string; createdAt: string | null; source: string; fetchedAt: string }>();

export function resetDeployerCacheForTest(): void {
  known.clear();
}

async function read(method: SolanaQuery['method'], params: unknown[]) {
  const answer = await ask<SolanaQuery, SolanaResult>(SOLANA_FAMILY, { method, params, commitment: 'finalized' });
  return { result: answer.value.result, source: answer.provenance.upstreamId, fetchedAt: answer.provenance.fetchedAt };
}

interface ParsedInstruction { parsed?: { type?: unknown; info?: { mint?: unknown } } }

function initializesMint(transaction: unknown, mint: string): boolean {
  const tx = transaction as { transaction?: { message?: { instructions?: ParsedInstruction[] } };
    meta?: { err?: unknown; innerInstructions?: { instructions?: ParsedInstruction[] }[] } } | null;
  if (!tx || tx.meta?.err !== null) return false;
  const all = [...(tx.transaction?.message?.instructions ?? []),
    ...(tx.meta?.innerInstructions ?? []).flatMap(inner => inner.instructions ?? [])];
  return all.some(ix => (ix.parsed?.type === 'initializeMint' || ix.parsed?.type === 'initializeMint2') && ix.parsed.info?.mint === mint);
}

/** The creation fee payer of one mint, or null when it cannot be proved. */
export async function readMintCreator(mint: string): Promise<{ address: string; createdAt: string | null; source: string; fetchedAt: string } | null> {
  if (!isAddress(mint)) return null;
  const cached = known.get(mint);
  if (cached) return cached;
  try {
    const signatures = await read('getSignaturesForAddress', [mint, { limit: PAGE }]);
    const list = signatures.result;
    if (!Array.isArray(list) || list.length === 0 || list.length >= PAGE) return null;
    const oldest = list[list.length - 1] as { signature?: unknown; err?: unknown };
    if (typeof oldest.signature !== 'string' || oldest.err) return null;
    const transaction = await read('getTransaction', [oldest.signature,
      { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'finalized' }]);
    const tx = transaction.result as { blockTime?: unknown; transaction?: { message?: { accountKeys?: ({ pubkey?: unknown } | string)[] } } } | null;
    if (!initializesMint(tx, mint)) return null;
    const first = tx?.transaction?.message?.accountKeys?.[0];
    const address = typeof first === 'string' ? first : first?.pubkey;
    if (typeof address !== 'string' || !isAddress(address)) return null;
    const blockTime = typeof tx?.blockTime === 'number' && Number.isFinite(tx.blockTime) ? new Date(tx.blockTime * 1000).toISOString() : null;
    const value = { address, createdAt: blockTime, source: transaction.source, fetchedAt: transaction.fetchedAt };
    if (known.size >= KNOWN_LIMIT) known.delete(known.keys().next().value as string);
    known.set(mint, value);
    return value;
  } catch {
    // Deliberate: any failed read is "unavailable" on the card, never a failed card.
    return null;
  }
}

export interface IndexLaunches {
  developer: string | null;
  developerLaunches: number | null;
  source: string;
  fetchedAt: string | null;
  observedAt: string | null;
}

/**
 * The deployer section for one mint. The index's launch count is used only when
 * the index names the very address the chain gave, so two attributions that
 * disagree print nothing rather than somebody else's count.
 */
export async function readDeployerHistory(mint: string, index: IndexLaunches): Promise<DeployerHistory> {
  const creator = await readMintCreator(mint);
  const agrees = !!creator && index.developer === creator.address;
  return {
    address: creator?.address ?? null,
    createdAt: creator?.createdAt ?? null,
    source: creator?.source ?? SOLANA_FAMILY,
    fetchedAt: creator?.fetchedAt ?? null,
    otherLaunches: agrees ? index.developerLaunches : null,
    launchesSource: index.source,
    launchesFetchedAt: index.fetchedAt,
    launchesObservedAt: index.observedAt,
    launchesMaxAgeMs: 5 * 60_000,
    // No source can list a deployer's other mints with exact reads, so none is claimed.
    earlier: [],
  };
}
