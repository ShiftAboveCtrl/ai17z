import { z } from 'zod';
import { defineCapability, registerCapability } from '@xbam/tools';
import {
  INTEGRITY_STATES,
  PAPER_INDEX_FAMILY,
  PREPRINT_FAMILY,
  WORK_KINDS,
  ask,
  canonicalDoi,
  familyHealth,
  parseArxivId,
  type PaperQuery,
  type PreprintQuery,
  type ScholarlyWork,
  type WorksAnswer,
} from '@xbam/upstream';

/**
 * Scholarly literature, and the six things it must not be read as saying.
 *
 *   a paper exists           is not  its claim is true
 *   a preprint               is not  a peer-reviewed article
 *   published                is not  replicated
 *   highly cited             is not  correct
 *   the abstract says X      is not  the paper proves X
 *   no retraction on record  is not  validated
 *
 * The last is the one this capability could most easily get wrong, because a
 * clean-looking answer is what an absence of data produces. `NO_KNOWN_UPDATE`
 * means the sources queried hold no such record; it is not a clearance, and
 * every answer says so.
 *
 * ### Two sources with different jobs
 *
 * Crossref is the DOI registry -- what was published, and what has happened to
 * it since. arXiv is the preprint archive -- the same work months earlier,
 * often with no DOI at all. Asking both and reporting which answered is the
 * point; flattening them into one "paper" would let an agent describe a
 * preprint as peer reviewed because a journal reference existed somewhere.
 */

const ProvenanceOut = z.object({
  source: z.string(),
  host: z.string(),
  readAt: z.string(),
  fellBackFrom: z.array(z.string()),
});

const Notice = z.object({
  state: z.enum(INTEGRITY_STATES),
  noticeDoi: z.string().nullable(),
  label: z.string(),
  /** Who supplied it. A publisher's own notice and a third-party database differ. */
  source: z.string(),
  date: z.string().nullable(),
});

const Work = z.object({
  doi: z.string().nullable(),
  arxivId: z.string().nullable(),
  /** The version actually read. A v3 can differ materially from a v1. */
  arxivVersion: z.number().nullable(),
  title: z.string().nullable(),
  authors: z.array(z.object({ name: z.string(), orcid: z.string().nullable() })),
  /** The real total; `authors` is truncated for works with thousands. */
  authorCount: z.number(),
  kind: z.enum(WORK_KINDS),
  rawType: z.string().nullable(),
  container: z.string().nullable(),
  publisher: z.string().nullable(),
  publishedAt: z.string().nullable(),
  abstract: z.string().nullable(),
  /** Where to read the primary source, never a summary of it. */
  url: z.string().nullable(),
  journalReference: z.string().nullable(),
  subjects: z.array(z.string()),
  integrity: z.enum(INTEGRITY_STATES),
  notices: z.array(Notice),
  /** Always with who counted. Indexes cover different literature. */
  citations: z.object({ count: z.number(), source: z.string(), observedAt: z.string() }).nullable(),
  source: z.string(),
});

function outward(work: ScholarlyWork): z.infer<typeof Work> {
  return {
    doi: work.doi,
    arxivId: work.arxivId,
    arxivVersion: work.arxivVersion,
    title: work.title,
    authors: work.authors,
    authorCount: work.authorCount,
    kind: work.kind,
    rawType: work.rawType,
    container: work.container,
    publisher: work.publisher,
    publishedAt: work.publishedAt,
    abstract: work.abstract,
    url: work.url,
    journalReference: work.journalReference,
    subjects: work.subjects,
    integrity: work.integrity,
    notices: work.notices,
    citations: work.citations,
    source: work.source,
  };
}

/**
 * Whether two records are the same work.
 *
 * Only a shared strong identifier counts. Two papers can carry nearly the same
 * title -- a preprint and its published version obviously do, but so do a paper
 * and its own erratum, a paper and a paper criticising it, and two unrelated
 * papers whose authors reached for the same phrase. Merging on title produces a
 * record that is confidently wrong about who wrote what.
 *
 * Where the evidence is weaker than an identifier, the records stay separate
 * and the answer says they might be related. Nothing here invents identity.
 */
export function sameWork(a: ScholarlyWork, b: ScholarlyWork): boolean {
  if (a.doi && b.doi && a.doi === b.doi) return true;
  if (a.arxivId && b.arxivId && a.arxivId === b.arxivId) return true;
  return false;
}

/** Said on every answer, because the absence of bad news is not good news. */
const ALWAYS = [
  'These records say a work exists and what was recorded about it. They do not establish that its claims are correct.',
  'An integrity state of NO_KNOWN_UPDATE means the sources queried hold no retraction or correction record. It is not a finding that the work is sound.',
];

async function scholarReadable(): Promise<{ status: 'AVAILABLE' | 'UNAVAILABLE'; why?: string }> {
  for (const family of [PAPER_INDEX_FAMILY, PREPRINT_FAMILY]) {
    const health = await familyHealth(family);
    if (health.some((entry) => entry.health.state === 'READY')) return { status: 'AVAILABLE' };
  }
  return { status: 'UNAVAILABLE', why: 'No scholarly index is answering.' };
}

const lookup = defineCapability({
  id: 'research.paper_lookup',
  name: 'Look up a scholarly work',
  description:
    'Retrieve metadata and integrity status for an identified scholarly work, by DOI or arXiv id. ' +
    'Reports whether it is a preprint or a published article, and any retraction or correction on record.',
  category: 'READ',
  effect: 'READ',
  risk: 'LOW',
  input: z.object({
    /** A DOI in any usual form, or an arXiv id. */
    identifier: z.string().trim().min(3).max(400),
  }),
  output: z.object({
    /** What the identifier was understood to be. */
    resolvedAs: z.enum(['DOI', 'ARXIV', 'UNRECOGNISED']),
    canonical: z.string().nullable(),
    records: z.array(Work),
    /** True when two sources described the same work and were reported together. */
    linked: z.boolean(),
    limitations: z.array(z.string()),
    provenance: z.array(ProvenanceOut),
  }),
  modelCallable: true,
  timeoutMs: 45_000,
  readiness: () => scholarReadable(),
  async run(input) {
    const doi = canonicalDoi(input.identifier);
    const arxiv = doi ? null : parseArxivId(input.identifier);

    if (!doi && !arxiv) {
      // Refused here rather than at a source. An identifier that is not one
      // cannot be looked up anywhere, and asking two services to confirm that
      // spends their budget to learn nothing.
      return {
        resolvedAs: 'UNRECOGNISED' as const,
        canonical: null,
        records: [],
        linked: false,
        limitations: [
          `"${input.identifier}" is neither a DOI nor an arXiv id, so nothing was looked up. ` +
            'A DOI looks like 10.1016/j.physletb.2012.08.020; an arXiv id looks like 2401.12345.',
        ],
        provenance: [],
      };
    }

    const records: ScholarlyWork[] = [];
    const provenance: z.infer<typeof ProvenanceOut>[] = [];
    const limitations = [...ALWAYS];

    if (doi) {
      const answer = await ask<PaperQuery, WorksAnswer>(PAPER_INDEX_FAMILY, { kind: 'doi', doi }).catch(() => null);
      if (answer) {
        records.push(...answer.value.works);
        provenance.push({
          source: answer.provenance.upstreamId,
          host: answer.provenance.origin,
          readAt: answer.provenance.fetchedAt,
          fellBackFrom: answer.provenance.fellBackFrom,
        });
      } else {
        limitations.push('The DOI registry could not be reached, so nothing here reflects it.');
      }
    }

    if (arxiv) {
      const answer = await ask<PreprintQuery, WorksAnswer>(PREPRINT_FAMILY, {
        kind: 'id',
        arxivId: arxiv.id,
      }).catch(() => null);
      if (answer) {
        records.push(...answer.value.works);
        provenance.push({
          source: answer.provenance.upstreamId,
          host: answer.provenance.origin,
          readAt: answer.provenance.fetchedAt,
          fellBackFrom: answer.provenance.fellBackFrom,
        });

        // A preprint that names its own DOI can be joined to the published
        // record -- on the identifier it supplied, not on its title.
        const withDoi = answer.value.works.find((work) => work.doi);
        if (withDoi?.doi && !doi) {
          const published = await ask<PaperQuery, WorksAnswer>(PAPER_INDEX_FAMILY, {
            kind: 'doi',
            doi: withDoi.doi,
          }).catch(() => null);
          if (published) {
            records.push(...published.value.works);
            provenance.push({
              source: published.provenance.upstreamId,
              host: published.provenance.origin,
              readAt: published.provenance.fetchedAt,
              fellBackFrom: published.provenance.fellBackFrom,
            });
          }
        }
      } else {
        limitations.push('The preprint archive could not be reached, so nothing here reflects it.');
      }
    }

    if (records.length === 0) {
      limitations.push('Nothing was found for that identifier. That is not evidence the work does not exist.');
    }
    if (records.some((work) => work.kind === 'PREPRINT')) {
      limitations.push(
        'One or more of these records is a preprint. A preprint has not been through peer review, whatever it has been cited by.',
      );
    }
    if (records.some((work) => work.integrity === 'RETRACTED')) {
      limitations.unshift('This work has a retraction on record. Read the retraction notice before citing it.');
    }

    const linked = records.length > 1 && records.some((a, i) => records.some((b, j) => i !== j && sameWork(a, b)));

    return {
      resolvedAs: doi ? ('DOI' as const) : ('ARXIV' as const),
      canonical: doi ?? arxiv?.id ?? null,
      records: records.map(outward),
      linked,
      limitations,
      provenance,
    };
  },
});

const search = defineCapability({
  id: 'research.paper_search',
  name: 'Find scholarly works',
  description:
    'Find scholarly works and preprints by title, topic or author. Results identify literature; ' +
    'they do not establish that a paper\'s claims are true. Say which source a result came from.',
  category: 'READ',
  effect: 'READ',
  risk: 'LOW',
  input: z.object({
    query: z.string().trim().min(3).max(300),
    limit: z.number().int().min(1).max(10).default(5),
    /** Whether to also search the preprint archive, which is slower. */
    includePreprints: z.boolean().default(true),
  }),
  output: z.object({
    query: z.string(),
    results: z.array(Work),
    /** What each index said it had, which is not what came back. */
    totals: z.array(z.object({ source: z.string(), matched: z.number().nullable() })),
    /** Sources that could not be searched, so a short list is not mistaken for a thorough one. */
    notSearched: z.array(z.object({ source: z.string(), why: z.string() })),
    limitations: z.array(z.string()),
    provenance: z.array(ProvenanceOut),
  }),
  modelCallable: true,
  timeoutMs: 60_000,
  readiness: () => scholarReadable(),
  async run(input) {
    const results: ScholarlyWork[] = [];
    const totals: { source: string; matched: number | null }[] = [];
    const notSearched: { source: string; why: string }[] = [];
    const provenance: z.infer<typeof ProvenanceOut>[] = [];

    const index = await ask<PaperQuery, WorksAnswer>(PAPER_INDEX_FAMILY, {
      kind: 'search',
      query: input.query,
      limit: input.limit,
    }).catch((error: { kind?: string }) => ({ failed: error?.kind ?? 'failed' }) as const);

    if ('failed' in index) {
      notSearched.push({ source: 'crossref', why: `the DOI registry could not be searched (${index.failed})` });
    } else {
      results.push(...index.value.works);
      totals.push({ source: 'crossref', matched: index.value.totalMatched });
      provenance.push({
        source: index.provenance.upstreamId,
        host: index.provenance.origin,
        readAt: index.provenance.fetchedAt,
        fellBackFrom: index.provenance.fellBackFrom,
      });
    }

    if (input.includePreprints) {
      const pre = await ask<PreprintQuery, WorksAnswer>(PREPRINT_FAMILY, {
        kind: 'search',
        query: input.query,
        limit: input.limit,
      }).catch((error: { kind?: string }) => ({ failed: error?.kind ?? 'failed' }) as const);

      if ('failed' in pre) {
        notSearched.push({ source: 'arxiv', why: `the preprint archive could not be searched (${pre.failed})` });
      } else {
        // Only a shared identifier merges records. A preprint and its published
        // version have near-identical titles and are genuinely two records of
        // one work; two unrelated papers can also share a title, and nothing
        // here can tell those apart from the strings.
        for (const work of pre.value.works) {
          if (!results.some((existing) => sameWork(existing, work))) results.push(work);
        }
        totals.push({ source: 'arxiv', matched: pre.value.totalMatched });
        provenance.push({
          source: pre.provenance.upstreamId,
          host: pre.provenance.origin,
          readAt: pre.provenance.fetchedAt,
          fellBackFrom: pre.provenance.fellBackFrom,
        });
      }
    }

    const limitations = [...ALWAYS];
    if (results.some((work) => work.kind === 'PREPRINT')) {
      limitations.push('Results marked PREPRINT have not been peer reviewed.');
    }
    if (notSearched.length > 0) {
      limitations.unshift(
        `${notSearched.length} of the sources could not be searched (${notSearched.map((entry) => entry.source).join(', ')}), ` +
          'so this is a partial view.',
      );
    }

    return {
      query: input.query,
      results: results.slice(0, input.limit * 2).map(outward),
      totals,
      notSearched,
      limitations,
      provenance,
    };
  },
});

export function registerScholarCapabilities(): void {
  registerCapability(lookup);
  registerCapability(search);
}
