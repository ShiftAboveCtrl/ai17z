import { z } from 'zod';

/**
 * Knowledge collections: a documentation site or a repository taught as one
 * source, and kept current.
 *
 * The limits are the design. A crawler somebody can point at a site is a
 * crawler somebody can point at the whole web by accident, so every collection
 * is bounded by host, path, pages, bytes and time, and the ceilings below are
 * enforced by the crawler whatever a config asks for.
 */

/** Hard ceilings. A config may ask for less, never for more. */
export const COLLECTION_CEILINGS = {
  sitePages: 500,
  siteDepth: 6,
  siteBytes: 40 * 1024 * 1024,
  siteMinutes: 15,
  repoFiles: 800,
  repoFileBytes: 400 * 1024,
  repoBytes: 40 * 1024 * 1024,
} as const;

export const DocumentationSiteConfig = z
  .object({
    /** Pages read per refresh. */
    maxPages: z.number().int().min(1).max(COLLECTION_CEILINGS.sitePages).default(150),
    /** Links followed from the first page. */
    maxDepth: z.number().int().min(0).max(COLLECTION_CEILINGS.siteDepth).default(4),
    /**
     * Where on the host the collection may go. Defaults to the directory of the
     * address given, so https://docs.example.com/v2/ stays in /v2/.
     */
    pathPrefix: z.string().max(300).optional(),
    /** Paths never read, as plain prefixes. */
    exclude: z.array(z.string().max(300)).max(40).default([]),
  })
  .strict();
export type DocumentationSiteConfig = z.infer<typeof DocumentationSiteConfig>;

export const GithubRepositoryConfig = z
  .object({
    /** A branch, tag or commit. Empty means the default branch. */
    ref: z.string().trim().max(200).optional(),
    /**
     * Folders read as documentation. Empty means the defaults: the README, a
     * docs folder and Markdown anywhere.
     */
    docPaths: z.array(z.string().max(300)).max(40).default([]),
    /**
     * Folders read as source code. Empty by default: code is taught only when
     * the owner chooses where, because a whole repository's source drowns the
     * documentation in it.
     */
    sourcePaths: z.array(z.string().max(300)).max(40).default([]),
    maxFiles: z.number().int().min(1).max(COLLECTION_CEILINGS.repoFiles).default(300),
  })
  .strict();
export type GithubRepositoryConfig = z.infer<typeof GithubRepositoryConfig>;

/**
 * What a collection is, so two generations of one product never become one.
 *
 * Pons V1 and Pons V2 are two collections: `generation: "V1"` and
 * `generation: "V2"`. Retrieval keeps them apart when a message names one and
 * labels both when it names neither.
 */
export const KnowledgeLabels = z
  .object({
    version: z.string().trim().max(40).nullable().optional(),
    generation: z.string().trim().max(40).nullable().optional(),
    effectiveDate: z.string().trim().max(40).nullable().optional(),
    authority: z.enum(['OFFICIAL', 'COMMUNITY', 'OWNER']).nullable().optional(),
  })
  .strict();
export type KnowledgeLabelsInput = z.infer<typeof KnowledgeLabels>;

export const KNOWLEDGE_FRESHNESS = ['HEALTHY', 'REFRESH_DUE', 'REFRESHING', 'CHANGED', 'FAILED', 'UNAVAILABLE', 'NEVER_READ'] as const;
export type KnowledgeFreshness = (typeof KNOWLEDGE_FRESHNESS)[number];

/** A refresh still running after this long is assumed to have died with its worker. */
const STALE_REFRESH_MS = 30 * 60_000;
/** A refresh that changed documents is shown as CHANGED for a day, so somebody notices. */
const CHANGED_WINDOW_MS = 24 * 60 * 60_000;

/**
 * The one verdict a screen shows for a source, derived from what is stored.
 *
 * Derived rather than stored, because most of it is about time: a source
 * becomes due for refresh by nothing happening, and a verdict written when the
 * last refresh ended would already be wrong.
 */
export function knowledgeFreshness(
  source: {
    indexedAt: string | null;
    lastError: string | null;
    errorKind: 'FAILED' | 'UNAVAILABLE' | null;
    refreshingSince: string | null;
    nextRefreshAt: string | null;
    lastChange: { added: number; changed: number; removed: number; at: string } | null;
  },
  now = Date.now(),
): KnowledgeFreshness {
  if (source.refreshingSince && now - Date.parse(source.refreshingSince) < STALE_REFRESH_MS) return 'REFRESHING';
  if (source.lastError) return source.errorKind === 'UNAVAILABLE' ? 'UNAVAILABLE' : 'FAILED';
  if (!source.indexedAt) return 'NEVER_READ';
  const change = source.lastChange;
  if (change && change.added + change.changed + change.removed > 0 && now - Date.parse(change.at) < CHANGED_WINDOW_MS) {
    return 'CHANGED';
  }
  if (source.nextRefreshAt && Date.parse(source.nextRefreshAt) <= now) return 'REFRESH_DUE';
  return 'HEALTHY';
}
