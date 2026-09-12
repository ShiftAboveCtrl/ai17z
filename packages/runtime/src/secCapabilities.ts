import { z } from 'zod';
import { defineCapability, registerCapability } from '@xbam/tools';
import {
  SEC_FAMILY,
  UNSET_MESSAGE,
  ask,
  familyHealth,
  padCik,
  secContact,
  type Provenance,
  type SecAnswer,
  type SecQuery,
} from '@xbam/upstream';

/**
 * What a company told its regulator.
 *
 * ### A primary source, and only that
 *
 * A filing is what the company said under obligation, which is worth far more
 * than a summary of it -- and is still the company speaking. A 10-K is not an
 * audit of reality, an 8-K is a disclosure of what management chose to
 * disclose, and neither becomes true by having been filed. What filing does
 * establish is that a specific organisation made a specific statement on a
 * specific date, which is exactly the thing an agent otherwise has to take from
 * somebody's blog.
 *
 * ### It is off until an owner switches it on
 *
 * The SEC refuses automated callers who do not declare a contact -- verified,
 * not assumed: an undeclared request is answered 403 "Your Request Originates
 * from an Undeclared Automated Tool". So these capabilities report themselves
 * unavailable until an installation supplies an address, and the message says
 * what to do. Nothing else in the Toolspace depends on them.
 */

const ProvenanceOut = z.object({
  source: z.string(),
  host: z.string(),
  readAt: z.string(),
  fellBackFrom: z.array(z.string()),
});

function reported(provenance: Provenance): z.infer<typeof ProvenanceOut> {
  return {
    source: provenance.upstreamId,
    host: provenance.origin,
    readAt: provenance.fetchedAt,
    fellBackFrom: provenance.fellBackFrom,
  };
}

/**
 * Readiness is a configuration question here, not a network one.
 *
 * Reporting "no source is answering" when the truth is "nobody has given it an
 * address" sends an owner looking for an outage that does not exist.
 */
async function secReadable(): Promise<{ status: 'AVAILABLE' | 'UNAVAILABLE'; why?: string }> {
  if (!secContact()) return { status: 'UNAVAILABLE', why: UNSET_MESSAGE };
  const health = await familyHealth(SEC_FAMILY);
  return health.some((entry) => entry.health.state === 'READY')
    ? { status: 'AVAILABLE' }
    : { status: 'UNAVAILABLE', why: 'The filing index is not answering.' };
}

const ALWAYS = [
  'A filing is what the company stated to its regulator on that date. It is a primary source, not an independent verification of what it says.',
];

const resolve = defineCapability({
  id: 'company.resolve',
  name: 'Find a company in the filing register',
  description:
    'Turns a ticker or company name into the registrant it refers to, with its CIK. ' +
    'Returns candidates rather than guessing when a name matches several.',
  category: 'READ',
  effect: 'READ',
  risk: 'LOW',
  input: z.object({ query: z.string().trim().min(1).max(120) }),
  output: z.object({
    query: z.string(),
    candidates: z.array(z.object({ cik: z.string(), ticker: z.string().nullable(), name: z.string() })),
    unambiguous: z.boolean(),
    limitations: z.array(z.string()),
    provenance: ProvenanceOut,
  }),
  modelCallable: true,
  timeoutMs: 30_000,
  readiness: () => secReadable(),
  async run(input) {
    const answer = await ask<SecQuery, SecAnswer>(SEC_FAMILY, { kind: 'resolve', text: input.query });
    const candidates = answer.value.candidates ?? [];
    const limitations = ['Only companies that file with the SEC are here. A company being absent means it does not file, not that it does not exist.'];
    if (candidates.length > 1) {
      limitations.push(`"${input.query}" matches ${candidates.length} registrants. Choose by name before using one.`);
    }
    return {
      query: input.query,
      candidates,
      unambiguous: candidates.length === 1,
      limitations,
      provenance: reported(answer.provenance),
    };
  },
});

const filings = defineCapability({
  id: 'company.filings',
  name: 'What a company has filed',
  description:
    'Lists a company\'s filings from the SEC, newest first, optionally limited to forms such as 10-K, 10-Q or 8-K. ' +
    'Each links to the filing itself so the primary document can be read.',
  category: 'READ',
  effect: 'READ',
  risk: 'LOW',
  input: z.object({
    /** A CIK from company.resolve. */
    cik: z.string().trim().min(1).max(20),
    /** Empty means every form. */
    forms: z.array(z.string().trim().min(1).max(20)).max(10).default([]),
    limit: z.number().int().min(1).max(25).default(10),
  }),
  output: z.object({
    company: z.object({ cik: z.string(), ticker: z.string().nullable(), name: z.string() }),
    sicDescription: z.string().nullable(),
    exchanges: z.array(z.string()),
    filings: z.array(
      z.object({
        form: z.string(),
        filedAt: z.string().nullable(),
        /** What the filing covers, which is not when it was filed. */
        periodOfReport: z.string().nullable(),
        accessionNumber: z.string(),
        /** The document itself, at the regulator. */
        url: z.string().nullable(),
        description: z.string().nullable(),
      }),
    ),
    /** How many the index held before any filter, so a short list is visible. */
    totalFilings: z.number(),
    limitations: z.array(z.string()),
    provenance: ProvenanceOut,
  }),
  modelCallable: true,
  timeoutMs: 40_000,
  readiness: () => secReadable(),
  async run(input) {
    const answer = await ask<SecQuery, SecAnswer>(SEC_FAMILY, {
      kind: 'filings',
      cik: padCik(input.cik),
      forms: input.forms,
      limit: input.limit,
    });
    const record = answer.value.record;
    if (!record) throw new Error(`Nothing was returned for CIK ${input.cik}.`);

    const limitations = [...ALWAYS];
    if (input.forms.length > 0 && record.filings.length === 0) {
      limitations.push(
        `No ${input.forms.join(' or ')} filings are in the recent index for this company. ` +
          'The index covers recent filings rather than the whole history, so older ones may exist.',
      );
    }
    if (record.filings.some((filing) => filing.periodOfReport && filing.filedAt && filing.periodOfReport !== filing.filedAt)) {
      limitations.push(
        'A filing date and the period it reports on are different things: an annual report filed in November can cover a year that ended in September.',
      );
    }

    return {
      company: record.company,
      sicDescription: record.sicDescription,
      exchanges: record.exchanges,
      filings: record.filings.map((filing) => ({
        form: filing.form,
        filedAt: filing.filedAt,
        periodOfReport: filing.periodOfReport,
        accessionNumber: filing.accessionNumber,
        url: filing.url,
        description: filing.description,
      })),
      totalFilings: record.totalFilings,
      limitations,
      provenance: reported(answer.provenance),
    };
  },
});

export function registerSecCapabilities(): void {
  registerCapability(resolve);
  registerCapability(filings);
}
