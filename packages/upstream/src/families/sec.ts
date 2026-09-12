import { z } from 'zod';
import { defineUpstream, type Upstream } from '../contract';
import { perSecond } from '../quota';
import { registerUpstream } from '../registry';
import { safeFetch } from '../http';
import { UpstreamFailure, classifyStatus, classifyThrown } from '../failures';

/**
 * Company filings, from the regulator rather than from somebody's summary.
 *
 * ### EDGAR will not talk to an anonymous caller, and that was tested
 *
 * The SEC asks automated callers to declare themselves in the User-Agent with
 * an organisation and a contact email. That is not advice. Probed September
 * 2026 with a User-Agent naming this project and its public repository -- an
 * honest, reachable contact, but not an email:
 *
 *   GET /files/company_tickers.json        403  "Request Rate Threshold Exceeded"
 *   GET /submissions/CIK0000320193.json    403  "Undeclared Automated Tool"
 *
 * Both refused, immediately, on a cold connection. So access here is
 * conditional on an installation supplying a contact, and with none supplied
 * this family does not send the request at all -- collecting a 403 to discover
 * something already known is the behaviour their page exists to discourage.
 *
 * ### The contact is the owner's, and is never invented
 *
 * A developer's address compiled into a released product identifies the wrong
 * person to a regulator on every machine that runs it. There is no default and
 * no fallback: unset means unavailable, said plainly, with what to do about it.
 *
 * ### What is not verified here
 *
 * The refusal path above is proven. The success path is built from the SEC's
 * documented JSON shapes and has not been observed from this machine, because
 * observing it needs the contact this file refuses to invent. An owner who
 * configures one exercises it on their first call, and the parser is written
 * defensively for that reason -- every field is optional and a missing one is
 * reported rather than assumed.
 */

export const SEC_FAMILY = 'company_filings';

/** A company as EDGAR knows it. */
export interface CompanyRef {
  /** Ten digits, zero-padded -- the form every EDGAR path wants. */
  cik: string;
  ticker: string | null;
  name: string;
}

export interface Filing {
  /** `10-K`, `10-Q`, `8-K`, and so on, exactly as filed. */
  form: string;
  filedAt: string | null;
  /** The period the filing covers, which is not when it was filed. */
  periodOfReport: string | null;
  accessionNumber: string;
  /** The filing's own page at the regulator. */
  url: string | null;
  primaryDocument: string | null;
  description: string | null;
}

export interface CompanyRecord {
  company: CompanyRef;
  /** What the company does, as classified by the regulator. */
  sicDescription: string | null;
  exchanges: string[];
  filings: Filing[];
  /** How many the index held before filtering, so a short list is visible. */
  totalFilings: number;
}

export const SecQuery = z.discriminatedUnion('kind', [
  /** Ticker or name to CIK. */
  z.object({ kind: z.literal('resolve'), text: z.string().min(1).max(120) }),
  z.object({
    kind: z.literal('filings'),
    cik: z.string().min(1).max(20),
    /** Empty means every form. */
    forms: z.array(z.string().min(1).max(20)).max(10),
    limit: z.number().int().min(1).max(50),
  }),
]);
export type SecQuery = z.infer<typeof SecQuery>;

export interface SecAnswer {
  candidates?: CompanyRef[];
  record?: CompanyRecord;
}

/**
 * The installation's declared contact, or nothing.
 *
 * Nothing is the shipped state. See the note at the top of this file for why
 * there is no default.
 */
let contact: string | null = null;

export function useSecContact(value: string | null): void {
  // An address without an @ is not one, and sending it would declare something
  // false rather than declare nothing.
  contact = value && value.includes('@') ? value.trim() : null;
}

export function secContact(): string | null {
  return contact;
}

/** What the SEC asks for: an organisation and a way to reach it. */
function userAgent(): string {
  if (!contact) throw new UpstreamFailure('BAD_CONFIGURATION', UNSET_MESSAGE);
  return `AI17Z ${contact}`;
}

export const UNSET_MESSAGE =
  'The SEC requires automated callers to declare a contact email, and none is configured. ' +
  'Set an SEC contact address for this installation to read filings.';

/** Ten digits with leading zeros, which is what every EDGAR path expects. */
export function padCik(value: string | number): string {
  const digits = String(value).replace(/\D/g, '');
  return digits.padStart(10, '0');
}

/** Accession numbers appear dashed in the index and undashed in paths. */
export function undash(accession: string): string {
  return accession.replace(/-/g, '');
}

function filingUrl(cik: string, accession: string, document: string | null): string | null {
  if (!document) return null;
  // The leading zeros come off for the directory but stay in the JSON.
  return `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${undash(accession)}/${document}`;
}

function sec(): Upstream<SecQuery, SecAnswer> {
  return defineUpstream<SecQuery, SecAnswer>({
    id: `${SEC_FAMILY}.edgar`,
    family: SEC_FAMILY,
    name: 'edgar',
    description: 'Company filings as submitted to the SEC.',
    origin: 'data.sec.gov',
    limit: {
      concurrentPerProcess: 1,
      // They publish ten a second and say it is "carefully monitored to
      // preserve equitable access". Half of that is plenty for reading a
      // filing index and leaves their ceiling alone.
      windows: [perSecond(5, { scope: 'MACHINE', source: 'PUBLISHED' })],
    },
    timeoutMs: 25_000,
    // A filing index changes when something is filed, which is rarely.
    freshMs: 30 * 60_000,
    rank: 1,
    cacheKey: (query) =>
      query.kind === 'resolve' ? `r:${query.text.toLowerCase()}` : `f:${padCik(query.cik)}:${query.forms.join(',')}:${query.limit}`,
    async fetch(query, ctx) {
      try {
        // Checked before anything is sent. Without a contact every request is a
        // 403, and collecting one to learn that is the behaviour their guidance
        // exists to prevent.
        const agent = userAgent();

        if (query.kind === 'resolve') {
          const response = await safeFetch('https://www.sec.gov/files/company_tickers.json', {
            signal: ctx.signal,
            headers: { accept: 'application/json', 'user-agent': agent },
            // Every listed company, which is a few thousand rows.
            maxBytes: 5_000_000,
          });
          const status = classifyStatus(response.status, response.headers);
          if (status) throw status;

          const body = JSON.parse(response.text) as Record<string, { cik_str?: number; ticker?: string; title?: string }>;
          const wanted = query.text.trim().toLowerCase();
          const rows = Object.values(body).filter((row) => row && typeof row === 'object');

          // An exact ticker beats a name that merely contains the text: asking
          // for "AA" should not answer with every company whose name has "aa"
          // in it before the one whose ticker is AA.
          const exact = rows.filter((row) => (row.ticker ?? '').toLowerCase() === wanted);
          const partial = rows.filter(
            (row) =>
              (row.ticker ?? '').toLowerCase() !== wanted &&
              ((row.title ?? '').toLowerCase().includes(wanted) || (row.ticker ?? '').toLowerCase().includes(wanted)),
          );

          return {
            candidates: [...exact, ...partial].slice(0, 10).map((row) => ({
              cik: padCik(row.cik_str ?? 0),
              ticker: row.ticker ?? null,
              name: row.title ?? 'unknown',
            })),
          };
        }

        const cik = padCik(query.cik);
        const response = await safeFetch(`https://data.sec.gov/submissions/CIK${cik}.json`, {
          signal: ctx.signal,
          headers: { accept: 'application/json', 'user-agent': agent },
          maxBytes: 10_000_000,
        });
        if (response.status === 404) throw new UpstreamFailure('NOT_FOUND', `EDGAR has no company with CIK ${cik}.`);
        const status = classifyStatus(response.status, response.headers);
        if (status) throw status;

        const body = JSON.parse(response.text) as Record<string, unknown>;
        const recent = (body.filings as { recent?: Record<string, unknown[]> } | undefined)?.recent ?? {};

        // Column arrays rather than rows: EDGAR returns each field as its own
        // parallel array, so a row is an index across all of them.
        const forms = (recent.form as string[]) ?? [];
        const wanted = new Set(query.forms.map((form) => form.toUpperCase()));
        const filings: Filing[] = [];
        for (let index = 0; index < forms.length && filings.length < query.limit; index += 1) {
          const form = forms[index] ?? '';
          if (wanted.size > 0 && !wanted.has(form.toUpperCase())) continue;
          const accession = String((recent.accessionNumber as string[])?.[index] ?? '');
          if (!accession) continue;
          const document = ((recent.primaryDocument as string[]) ?? [])[index] ?? null;
          filings.push({
            form,
            filedAt: ((recent.filingDate as string[]) ?? [])[index] ?? null,
            // What the filing covers, which is not the date it was filed. A
            // 10-K filed in November reports the year that ended in September.
            periodOfReport: ((recent.reportDate as string[]) ?? [])[index] || null,
            accessionNumber: accession,
            url: filingUrl(cik, accession, document),
            primaryDocument: document,
            description: ((recent.primaryDocDescription as string[]) ?? [])[index] || null,
          });
        }

        return {
          record: {
            company: {
              cik,
              ticker: Array.isArray(body.tickers) ? ((body.tickers as string[])[0] ?? null) : null,
              name: typeof body.name === 'string' ? body.name : 'unknown',
            },
            sicDescription: typeof body.sicDescription === 'string' ? body.sicDescription : null,
            exchanges: Array.isArray(body.exchanges) ? (body.exchanges as string[]).slice(0, 5) : [],
            filings,
            totalFilings: forms.length,
          },
        };
      } catch (error) {
        throw classifyThrown(error);
      }
    },
  });
}

export function registerSecUpstreams(): void {
  registerUpstream(sec());
}
