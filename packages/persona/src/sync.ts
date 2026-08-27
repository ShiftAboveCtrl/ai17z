import { createLogger, errorMessage } from '@xbam/shared';
import { personaSources } from '@xbam/database';
import { analyse } from './normalize';
import { classifyItem } from './score';
import { deriveProfile, type CorpusItem, type DerivedProfile } from './derive';
import { getPersonaSourceAdapter, itemsFromText, type RawCorpusItem } from './sources/index';

const log = createLogger('persona-sync');

export interface SyncReport {
  sourceId: string;
  fetched: number;
  stored: number;
  duplicates: number;
  useful: number;
  excluded: number;
  traits: number;
  profile: DerivedProfile['summary'] | null;
  error: string | null;
}

/**
 * Ingests a corpus and derives a persona from it.
 *
 * The order matters: normalise, then fingerprint, then score, then store. A
 * repost and its original collapse before either is scored, so campaign
 * duplicates cannot dominate what the agent learns.
 *
 * Raw text is always kept, even for items that are excluded. The exclusion is a
 * decision about what to *learn* from, not a reason to lose evidence.
 */
export async function syncPersonaSource(input: {
  sourceId: string;
  limit?: number;
  /** For manual sources: the text the owner pasted. */
  text?: string;
  incremental?: boolean;
}): Promise<SyncReport> {
  const source = await personaSources.getSource(input.sourceId);
  if (!source) throw new Error('That persona source no longer exists.');

  const report: SyncReport = {
    sourceId: source.id,
    fetched: 0, stored: 0, duplicates: 0, useful: 0, excluded: 0, traits: 0,
    profile: null, error: null,
  };

  await personaSources.setSourceStatus(source.id, 'SYNCING', { lastError: null });

  try {
    const adapter = getPersonaSourceAdapter(source.kind);
    const limit = input.limit ?? 2000;

    let raw: RawCorpusItem[];
    if (source.kind === 'manual') {
      raw = itemsFromText(input.text ?? '', { handle: source.handle ?? '', limit });
    } else {
      const availability = await adapter.availability();
      if (!availability.available) {
        await personaSources.setSourceStatus(source.id, 'UNAVAILABLE', {
          lastError: `${availability.detail} ${availability.requirement ?? ''}`.trim(),
        });
        report.error = availability.detail;
        return report;
      }
      raw = await adapter.fetch({
        handle: source.handle ?? '',
        limit,
        since: input.incremental === false ? null : source.syncCursor,
        includeReplies: source.config.includeReplies !== false,
        includeQuotes: source.config.includeQuotes !== false,
      });
    }

    report.fetched = raw.length;
    const seenFingerprints = new Set<string>();
    let newestRemoteId: string | null = null;

    for (const item of raw) {
      newestRemoteId ??= item.remoteId;
      const meta = analyse(item.text);

      // Within-batch duplicates never reach the database.
      if (seenFingerprints.has(meta.fingerprint)) {
        report.duplicates += 1;
        continue;
      }
      seenFingerprints.add(meta.fingerprint);

      const verdict = classifyItem(item.text, meta);
      const { created } = await personaSources.storeItem({
        sourceId: source.id,
        remoteId: item.remoteId,
        url: item.url,
        itemKind: item.itemKind,
        rawText: item.text,
        normalizedText: meta.normalized,
        contentHash: meta.fingerprint,
        remoteCreatedAt: item.createdAt,
        raw: item.raw,
        styleScore: verdict.style,
        personaScore: verdict.persona,
        beliefScore: verdict.belief,
        knowledgeScore: verdict.knowledge,
        noiseScore: verdict.noise,
        classification: verdict.classification,
        excluded: verdict.excluded,
        exclusionReason: verdict.exclusionReason,
      });
      if (created) report.stored += 1;
      else report.duplicates += 1;
    }

    const stats = await personaSources.sourceStats(source.id);
    report.useful = stats.useful;
    report.excluded = stats.excluded;

    // Derive from everything selected, not just this batch, so an incremental
    // sync produces a profile informed by the whole corpus.
    const selected = await personaSources.selectedItems(source.id);
    const corpus: CorpusItem[] = selected.map((item) => ({
      id: item.id,
      text: item.rawText,
      styleScore: item.styleScore,
      beliefScore: item.beliefScore,
      classification: item.classification,
    }));

    const profile = deriveProfile(corpus);
    report.traits = await personaSources.replaceTraits(source.agentId, source.id, profile.traits);
    report.profile = profile.summary;

    await personaSources.setSourceStatus(source.id, 'READY', {
      touchSynced: true,
      syncCursor: newestRemoteId,
      lastError: null,
    });
    log.info('persona source synced', {
      sourceId: source.id, fetched: report.fetched, stored: report.stored, traits: report.traits,
    });
    return report;
  } catch (error) {
    const message = errorMessage(error);
    await personaSources.setSourceStatus(source.id, 'ERROR', { lastError: message.slice(0, 500) });
    report.error = message;
    log.warn('persona source sync failed', { sourceId: source.id, message });
    return report;
  }
}

/**
 * Turns derived traits into persona fields the owner can edit.
 *
 * A compact profile plus a small example set, never the raw corpus: injecting
 * thousands of posts into every prompt is the thing this whole subsystem exists
 * to avoid.
 */
export function personaDraftFromTraits(traits: Array<{ kind: string; content: string; confidence: number }>): {
  personality: string;
  styleGuidelines: string;
  topics: string[];
  styleExamples: string[];
} {
  const of = (kind: string) => traits.filter((t) => t.kind === kind).sort((a, b) => b.confidence - a.confidence);
  return {
    personality: of('belief').slice(0, 5).map((t) => t.content).join('\n'),
    styleGuidelines: of('style').map((t) => t.content).join('\n'),
    topics: of('topic').slice(0, 12).map((t) => t.content),
    styleExamples: of('example').slice(0, 20).map((t) => t.content),
  };
}
