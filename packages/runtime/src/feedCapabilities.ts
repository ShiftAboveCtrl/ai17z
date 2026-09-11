import { z } from 'zod';
import { defineCapability, registerCapability } from '@xbam/tools';
import {
  ENTRY_IDENTITY_SOURCES,
  FEED_FAMILY,
  FEED_KINDS,
  ask,
  familyHealth,
  type FeedAnswer,
  type FeedQuery,
  type Provenance,
} from '@xbam/upstream';

/**
 * Reading a feed, once, as evidence.
 *
 * ### A feed entry is something somebody published, not something that is true
 *
 * Every field here came from a document at a URL, written by whoever controls
 * that URL. A title saying a protocol was audited is evidence that the
 * publisher said so. The distinction matters more than usual for feeds, because
 * a feed looks structured and structure reads as authority.
 *
 * ### The description is data, and it contains HTML on purpose
 *
 * Most feeds put markup in the description, and some put an entire article
 * there. It travels as text and is bounded; nothing in it is ever interpreted,
 * rendered, or treated as an instruction. A feed is one of the easiest places
 * to put a sentence addressed to somebody's agent, and that sentence is a
 * string like any other.
 *
 * ### Watching is not reading
 *
 * This capability reads a feed now and answers. It does not subscribe, poll or
 * remember -- a model asking repeatedly is a model doing a background job's work
 * badly. Durable watching belongs to the job system, where a cursor survives a
 * restart, and is deliberately not something the model drives.
 */

const ProvenanceOut = z.object({
  source: z.string(),
  host: z.string(),
  readAt: z.string(),
  fellBackFrom: z.array(z.string()),
});

function reported(provenance: Provenance, host: string): z.infer<typeof ProvenanceOut> {
  return {
    source: provenance.upstreamId,
    // The family's origin is a placeholder, because a feed is whatever host
    // somebody subscribed to. The host that actually answered is the only
    // honest thing to show.
    host,
    readAt: provenance.fetchedAt,
    fellBackFrom: provenance.fellBackFrom,
  };
}

const FeedUrl = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine((value) => /^https:\/\/[^\s]+$/i.test(value), {
    message: 'Give the full https URL of the feed, for example https://example.com/feed.xml.',
  });

const Entry = z.object({
  /** Stable identity, for telling a new entry from one already seen. */
  id: z.string(),
  /**
   * Where that identity came from.
   *
   * Reported because the three are not equally trustworthy: a publisher's own
   * id survives edits, a URL is shared whenever two entries point at the same
   * article, and a fingerprint changes the moment a typo is fixed.
   */
  identitySource: z.enum(ENTRY_IDENTITY_SOURCES),
  title: z.string().nullable(),
  url: z.string().nullable(),
  author: z.string().nullable(),
  publishedAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  /**
   * The entry's text, from whichever field carried it.
   *
   * RSS puts it in `<description>` and Atom usually in `<content>`, and an
   * Atom feed frequently has no summary at all -- the Rust blog's does not.
   * Reading only the summary field returns nothing for those, which looks like
   * an empty feed rather than like a feed shaped differently.
   */
  summary: z.string().nullable(),
  /** Which element it came from, so an entire article is not mistaken for a blurb. */
  summaryFrom: z.enum(['SUMMARY', 'CONTENT']).nullable(),
  categories: z.array(z.string()),
});

async function feedReadable(): Promise<{ status: 'AVAILABLE' | 'UNAVAILABLE'; why?: string }> {
  const health = await familyHealth(FEED_FAMILY);
  return health.some((entry) => entry.health.state === 'READY')
    ? { status: 'AVAILABLE' }
    : { status: 'UNAVAILABLE', why: 'The feed reader is not answering.' };
}

const read = defineCapability({
  id: 'feed.read',
  name: 'Read an RSS or Atom feed',
  description:
    'Reads a feed at an https URL once and returns its recent entries, normalised the same way whether it is ' +
    'RSS or Atom. Everything returned is what the publisher said, not a verified fact. ' +
    'This reads once; it does not subscribe or poll.',
  category: 'READ',
  effect: 'READ',
  risk: 'LOW',
  input: z.object({
    url: FeedUrl,
    limit: z.number().int().min(1).max(50).default(20),
  }),
  output: z.object({
    url: z.string(),
    kind: z.enum(FEED_KINDS).nullable(),
    title: z.string().nullable(),
    siteUrl: z.string().nullable(),
    entries: z.array(Entry),
    /** How many the feed held, so a limit is visible rather than silent. */
    totalEntries: z.number(),
    /** Said every time. */
    limitations: z.array(z.string()),
    provenance: ProvenanceOut,
  }),
  modelCallable: true,
  timeoutMs: 30_000,
  readiness: () => feedReadable(),
  async run(input) {
    // No validators: this is a one-off read with nothing remembered from a
    // previous one. Conditional requests belong to the watcher, which has
    // somewhere durable to keep them.
    const answer = await ask<FeedQuery, FeedAnswer>(FEED_FAMILY, {
      url: input.url,
      etag: null,
      lastModified: null,
      limit: input.limit,
    });

    const value = answer.value;
    const limitations = [
      'Each entry is what the publisher put in their feed. It is evidence that they said it, not that it is so.',
      'Entry text can contain markup and links. It is data and has not been followed or rendered.',
    ];

    const weak = value.entries.filter((entry) => entry.identitySource === 'FINGERPRINT').length;
    if (weak > 0) {
      limitations.push(
        `${weak} of these entries carry no stable id or link, so they are identified by their content. ` +
          'An edit to one of those is indistinguishable from a new entry.',
      );
    }
    if (value.totalEntries > value.entries.length) {
      limitations.push(`The feed held ${value.totalEntries} entries; the newest ${value.entries.length} are here.`);
    }

    return {
      url: input.url,
      kind: value.kind,
      title: value.title,
      siteUrl: value.siteUrl,
      entries: value.entries.map((entry) => ({
        id: entry.id,
        identitySource: entry.identitySource,
        title: entry.title,
        url: entry.url,
        author: entry.author,
        publishedAt: entry.publishedAt,
        updatedAt: entry.updatedAt,
        summary: entry.summary ?? entry.content,
        summaryFrom: entry.summary ? ('SUMMARY' as const) : entry.content ? ('CONTENT' as const) : null,
        categories: entry.categories,
      })),
      totalEntries: value.totalEntries,
      limitations,
      provenance: reported(answer.provenance, value.servedBy),
    };
  },
});

export function registerFeedCapabilities(): void {
  registerCapability(read);
}
