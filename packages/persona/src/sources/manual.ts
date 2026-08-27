import { sha256Hex } from '@xbam/shared';
import type { CorpusFetchOptions, PersonaSourceAdapter, RawCorpusItem, SourceAvailability } from './contract';

/**
 * A corpus the owner supplies directly.
 *
 * This exists so the whole persona pipeline is usable without any scraping
 * dependency at all: paste a few dozen representative posts and the same
 * normalisation, scoring and derivation runs over them.
 */
export const manualSource: PersonaSourceAdapter = {
  kind: 'manual',
  displayName: 'Pasted text',

  async availability(): Promise<SourceAvailability> {
    return { available: true, detail: 'Always available. You supply the text.', requirement: null };
  },

  async fetch(): Promise<RawCorpusItem[]> {
    // Manual corpora are written straight into the item table by the API, since
    // there is nothing to fetch. Kept here so the adapter shape is uniform.
    return [];
  },
};

/** Turns pasted text into corpus items, one per non-empty line or paragraph. */
export function itemsFromText(text: string, options: CorpusFetchOptions): RawCorpusItem[] {
  const blocks = text
    .split(/\n{2,}|\r?\n/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);

  return blocks.slice(0, options.limit).map((block) => ({
    // Content-addressed, so pasting the same text twice does not duplicate it.
    remoteId: `manual:${sha256Hex(block).slice(0, 32)}`,
    text: block,
    url: null,
    itemKind: 'post' as const,
    createdAt: null,
    raw: { source: 'manual' },
  }));
}
