import { shortAddress } from './evidenceCard';

/**
 * The holder map's words, in one place.
 *
 * Every line here says what was read, where and when. None says what a reader should
 * conclude, none names a person or a handle, and the same lines are pinned into the
 * picture's payload so the pixels and the text twin cannot drift apart. The wording
 * was fixed before any of the code that renders it.
 */

/** What a single account's first funding read came to. `grouped` needs two or more accounts. */
export type HolderFunding = 'grouped' | 'single' | 'unavailable' | 'excluded';

export interface HolderMapEntry {
  /** The holder's wallet where the read found one, otherwise its token account. Public on-chain, never a name. */
  address: string;
  /** Per cent of supply, from exact integers. Always a read value: an unread one is in `notRead`, not here. */
  percent: number;
  funding: HolderFunding;
  /** `g1`, `g2`... and only when `funding` is `grouped`. Never the funding address itself. */
  group: string | null;
  readAt: string;
}

export interface HolderMapView {
  mint: string;
  readAt: string;
  /** The upstream that answered, in the same form every card reading carries. */
  source: string;
  holders: HolderMapEntry[];
  /** Accounts whose supply percent was not available: listed, never drawn as a small circle. */
  notRead: string[];
  groups: { id: string; size: number }[];
}

/** `full` lists every account, `compact` is one line, `note` says the map could not be read. */
export type HolderMapForm = 'full' | 'compact' | 'note';

export interface HolderMapOnCard {
  form: HolderMapForm;
  /** Absent only for `note`. */
  view: HolderMapView | null;
}

/** The card's own closing words. They are also part of the picture. */
export const HOLDER_MAP_NOT_A_VERDICT = 'not a verdict, reads can be wrong';
export const HOLDER_MAP_NOT_PROOF = 'This is a reading, not proof of one owner.';
export const HOLDER_MAP_SHARED_SERVICE = 'A shared funding address can also be a service that many people use.';
export const HOLDER_MAP_EXCLUSION = 'Accounts owned or first funded by a program, such as a pool or an exchange program, are left out of grouping';
export const HOLDER_MAP_NOT_READ = 'Holder map: not read, the holder read did not complete.';
export const HOLDER_MAP_TITLE = 'Holder map, largest accounts read';
const NO_GROUP = 'No two accounts show the same first funding address in this read.';
const FUNDING_NOT_READ = 'Funding was not read for these accounts, so no grouping is shown.';

export function holderMapCaption(readAt: string, source: string): string {
  return `Same first funding address, read at ${readAt}, from ${source}.`;
}

/** The figure as the twin prints it, so the refusal and the renderer cannot disagree. */
export function holderMapPercent(percent: number): string {
  return `${percent.toFixed(2)}%`;
}

/**
 * Words that turn a reading into an accusation or a recommendation. The map never uses
 * them, and a rewrite that introduces one is refused. `unsafe` and `safely` are included
 * on purpose: "safe" is a verdict whatever its prefix.
 */
const BANNED = /\b(?:bundl\w*|sybil\w*|insider\w*|dev[\s-]+wallets?|rug\w*|scam\w*|(?:un)?safe\w*|smart[\s-]+money|whales?|cabal|fake|fraud\w*|suspicious|danger\w*|bullish|bearish|avoid|buy|sell|trusted|legit\w*)\b/i;

export function holderMapBannedWord(text: string): string | null {
  return BANNED.exec(text)?.[0]?.toLowerCase() ?? null;
}

const letter = (id: string) => String.fromCharCode(64 + Number(id.slice(1)));

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function fundingPhrase(view: HolderMapView, index: number): string {
  const entry = view.holders[index]!;
  if (entry.funding === 'grouped') {
    const others = view.holders.flatMap((h, i) => i !== index && h.group === entry.group ? [`#${i + 1}`] : []);
    return `same first funding address as ${others.join(', ')} (group ${letter(entry.group!)})`;
  }
  if (entry.funding === 'single') return 'first funding address read, not shared in this read';
  if (entry.funding === 'excluded') return 'left out of grouping';
  return 'funding unavailable';
}

/**
 * The lines a reader gets when the picture is missing, and that sit under the picture when it is
 * not. `full` and `compact` come from the same view, so they say the same thing at two lengths.
 */
export function renderHolderMapLines(map: HolderMapOnCard): string[] {
  if (map.form === 'note' || !map.view) return [HOLDER_MAP_NOT_READ];
  const view = map.view;
  const groups = view.groups.length;
  if (map.form === 'compact') {
    return [`Holder map: ${plural(view.holders.length, 'account', 'accounts')} read, ${plural(groups, 'group', 'groups')} sharing a first funding address, read at ${view.readAt}, from ${view.source}. ${HOLDER_MAP_NOT_PROOF}`];
  }
  const readAny = view.holders.some(h => h.funding === 'grouped' || h.funding === 'single');
  const excluded = view.holders.filter(h => h.funding === 'excluded').length;
  return [
    HOLDER_MAP_TITLE,
    ...view.holders.map((h, i) => `#${i + 1} ${shortAddress(h.address)}: ${holderMapPercent(h.percent)} of supply, ${fundingPhrase(view, i)}`),
    ...(groups > 0
      ? view.groups.map(g => `Group ${letter(g.id)}: ${plural(g.size, 'account shows', 'accounts show')} the same first funding address.`)
      : [readAny ? NO_GROUP : FUNDING_NOT_READ]),
    ...(excluded > 0 ? [`${HOLDER_MAP_EXCLUSION} (${excluded} here).`] : []),
    ...(view.notRead.length > 0 ? [`Not read: ${plural(view.notRead.length, 'account', 'accounts')}, supply percent was not available.`] : []),
    holderMapCaption(view.readAt, view.source),
    HOLDER_MAP_NOT_PROOF,
    HOLDER_MAP_SHARED_SERVICE,
  ];
}
