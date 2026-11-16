import {
  HOLDER_MAP_NOT_A_VERDICT,
  HOLDER_MAP_NOT_PROOF,
  holderMapBannedWord,
  holderMapPercent,
  type HolderMapEntry,
  type HolderMapForm,
  type HolderMapView,
} from '@xbam/prompts';

/**
 * Same-funder grouping for a holder map. Pure: it takes reads that were already made and decides
 * only what may be drawn and what may be joined.
 *
 * ## What a group is, and is not
 *
 * Two or more accounts whose first successful transaction in the read history brought SOL from the
 * same signing address. That is a measurement. It is not an owner: a shared funder can be a service
 * many people use, which is why the caption says "a reading, not proof of one owner" and why an
 * account first funded by a program-owned address is left out rather than joined.
 *
 * ## Absent is never zero
 *
 * A funding read that did not complete is `unavailable`, which is a different thing from `single`
 * (read, and shared with nobody). Folding the first into the second would say "nobody else shares
 * it" about an account nobody managed to look at. A supply percent that was not read is listed under
 * `notRead` and never drawn, because a missing figure drawn as a small circle is a claim.
 */

/** At most this many accounts are drawn and at most this many are read for funding. */
export const MAX_HOLDER_MAP_HOLDERS = 12;

export type FundingRead =
  | { state: 'read'; funder: string; funderIsProgram: boolean }
  | { state: 'unavailable'; reason: string };

export interface HolderReadInput {
  /** The wallet that owns the token account, where the read found one. */
  owner: string | null;
  tokenAccount: string;
  /** Per cent of the supply; null when the supply was not read. */
  sharePct: number | null;
  kind: 'WALLET' | 'PROGRAM' | 'UNKNOWN';
  /** Absent for an account that was not asked (a program, or past the ceiling). */
  funding?: FundingRead;
  readAt: string;
}

export interface HolderMapInput {
  mint: string;
  readAt: string;
  source: string;
  holders: HolderReadInput[];
}

/** Only a finite share inside 0..100 is a figure; anything else was not read. */
function usablePercent(value: number | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

export function buildHolderMap(input: HolderMapInput): HolderMapView {
  const rows = input.holders.slice(0, MAX_HOLDER_MAP_HOLDERS);
  const notRead: string[] = [];
  const drawn: { row: HolderReadInput; address: string; percent: number }[] = [];
  for (const row of rows) {
    const address = row.owner ?? row.tokenAccount;
    const percent = usablePercent(row.sharePct);
    if (percent === null) notRead.push(address);
    else drawn.push({ row, address, percent });
  }

  // A funding address counts only for accounts that are plain wallets and whose funder is not a program.
  const eligible = (row: HolderReadInput): string | null =>
    row.kind === 'WALLET' && row.funding?.state === 'read' && !row.funding.funderIsProgram ? row.funding.funder : null;
  const members = new Map<string, number>();
  for (const { row } of drawn) {
    const funder = eligible(row);
    if (funder) members.set(funder, (members.get(funder) ?? 0) + 1);
  }
  // Ids follow the order the groups first appear in the ranking, so the same read always draws the same ids.
  const ids = new Map<string, string>();
  for (const { row } of drawn) {
    const funder = eligible(row);
    if (funder && (members.get(funder) ?? 0) >= 2 && !ids.has(funder)) ids.set(funder, `g${ids.size + 1}`);
  }

  const holders: HolderMapEntry[] = drawn.map(({ row, address, percent }) => {
    const funder = eligible(row);
    const group = funder ? ids.get(funder) ?? null : null;
    const excluded = row.kind === 'PROGRAM' || (row.funding?.state === 'read' && row.funding.funderIsProgram);
    const funding: HolderMapEntry['funding'] = excluded ? 'excluded' : group ? 'grouped' : funder ? 'single' : 'unavailable';
    return { address, percent, funding, group, readAt: row.readAt };
  });
  const groups = [...ids.values()].map(id => ({ id, size: holders.filter(h => h.group === id).length }));
  return { mint: input.mint, readAt: input.readAt, source: input.source, holders, notRead, groups };
}

/** What the lamport balances of one transaction say about who paid one account. */
export type FirstFunding =
  | { state: 'read'; funder: string }
  | { state: 'unavailable'; reason: string };

interface TransactionShape {
  meta?: {
    err?: unknown;
    preBalances?: unknown;
    postBalances?: unknown;
    loadedAddresses?: { writable?: unknown; readonly?: unknown };
  } | null;
  transaction?: { message?: { accountKeys?: unknown; header?: { numRequiredSignatures?: unknown } } };
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);
const numbers = (value: unknown): number[] | null =>
  Array.isArray(value) && value.every(v => typeof v === 'number' && Number.isFinite(v)) ? (value as number[]) : null;

/**
 * Who paid `owner` in this transaction: the signing address whose balance fell the most while the
 * owner's rose. A transaction that did not raise the owner's balance, or that no signer paid for,
 * says nothing about funding and is reported as such rather than guessed at.
 *
 * Balances arrive as JSON numbers, exact below 2^53 lamports (about nine million SOL). A funder
 * richer than that is ordered by a rounded figure, which can only matter between two signers who
 * both paid, and the larger of the two is still the larger.
 */
export function firstFundingFromTransaction(tx: unknown, owner: string): FirstFunding {
  const value = tx as TransactionShape | null;
  const meta = value?.meta;
  const message = value?.transaction?.message;
  if (!meta || !message) return { state: 'unavailable', reason: 'transaction not available' };
  if ((meta.err ?? null) !== null) return { state: 'unavailable', reason: 'first transaction did not succeed' };
  // A versioned transaction appends the addresses it loaded to the ones it carries; balances follow that order.
  const keys = [...strings(message.accountKeys), ...strings(meta.loadedAddresses?.writable), ...strings(meta.loadedAddresses?.readonly)];
  const pre = numbers(meta.preBalances);
  const post = numbers(meta.postBalances);
  const at = keys.indexOf(owner);
  if (!pre || !post || pre.length !== keys.length || post.length !== keys.length || at < 0) {
    return { state: 'unavailable', reason: 'transaction not available' };
  }
  if (post[at]! - pre[at]! <= 0) return { state: 'unavailable', reason: 'first transaction did not fund this account' };
  const signers = typeof message.header?.numRequiredSignatures === 'number' ? message.header.numRequiredSignatures : 0;
  let funder: string | null = null;
  let paid = 0;
  for (let i = 0; i < Math.min(signers, keys.length); i += 1) {
    if (i === at) continue;
    const drop = pre[i]! - post[i]!;
    if (drop > paid) { paid = drop; funder = keys[i]!; }
  }
  return funder ? { state: 'read', funder } : { state: 'unavailable', reason: 'no signer paid this account' };
}

/**
 * A rewrite may change the voice, but it cannot drop what makes the map a reading. For the full
 * form that is every percent figure; for every form it is the read time, the source, the
 * not-a-verdict line and the not-a-proof line, and no word that turns a reading into an accusation.
 */
export function holderMapDraftRefusal(view: HolderMapView, form: HolderMapForm, draft: string): string | null {
  const banned = holderMapBannedWord(draft);
  if (banned) return `The holder map may not use the word "${banned}". Say what was read, and nothing about what it means.`;
  if (!draft.toLowerCase().includes(HOLDER_MAP_NOT_A_VERDICT)) return 'Retain the line that this is not a verdict.';
  if (!draft.includes(view.readAt) || !draft.includes(view.source)) return 'Retain the holder map read time and source.';
  if (!draft.includes(HOLDER_MAP_NOT_PROOF)) return 'Retain the line that this is a reading, not proof of one owner.';
  if (form === 'full' && view.holders.some(h => !draft.includes(holderMapPercent(h.percent)))) {
    return 'Retain every holder percent figure.';
  }
  return null;
}

/** A free-text mention of a holder map. Only a direct ask opens this branch. */
export function holderMapRequested(text: string): boolean {
  return /\bholders?\s+(?:map|picture|image)\b|\bmap\s+(?:of\s+)?(?:the\s+)?holders?\b/i.test(text);
}
