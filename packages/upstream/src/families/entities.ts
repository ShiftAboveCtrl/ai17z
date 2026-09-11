import { z } from 'zod';
import { defineUpstream, type Upstream } from '../contract';
import { perMinute, perSecond } from '../quota';
import { registerUpstream } from '../registry';
import { safeFetch } from '../http';
import { UpstreamFailure, classifyStatus, classifyThrown } from '../failures';

/**
 * Things, and what is recorded about them.
 *
 * ### Bounded calls, not a query language
 *
 * Wikidata has a public SPARQL endpoint, and handing that to a model would be
 * handing it an arbitrary query language against somebody else's service --
 * unbounded cost, unbounded runtime, and a failure mode where a malformed query
 * gets the address blocked. Every question here is answered with the Action
 * API instead: search for a name, fetch one entity by id, resolve a batch of
 * ids to labels. Three shapes, all bounded, all deterministic.
 *
 * ### Their etiquette, quoted
 *
 * MediaWiki's API etiquette says there is "no hard speed limit on read
 * requests" but asks for requests "in series rather than in parallel", and that
 * every request carry "a meaningful User-Agent header" with contact
 * information. So the concurrency below is one because they asked for serial,
 * and the rates are marked SELF_IMPOSED because no number was published to
 * quote.
 *
 * ### Size is the real constraint
 *
 * Measured September 2026:
 *
 *   a search for "mercury", 7 hits                3.2 KB
 *   Ada Lovelace, labels+claims+enwiki only       122 KB   166 claims
 *   Douglas Adams, unfiltered                     311 KB
 *
 * An entity is not a small object. Everything here asks for the narrowest
 * property set that answers the question, and the capability trims again before
 * anything reaches a prompt.
 */

export const ENTITY_FAMILY = 'entity_graph';

/** A search hit. Deliberately not "the answer" -- see the capability. */
export interface EntityCandidate {
  id: string;
  label: string;
  description: string | null;
  /** What the searcher matched on, which is not always the label. */
  matchedOn: string | null;
  url: string;
}

/** One statement about an entity, rendered readably. */
export interface EntityStatement {
  property: string;
  propertyLabel: string | null;
  /** The value as text. */
  value: string;
  /** Present when the value is another entity, so it can be followed. */
  valueEntityId: string | null;
  /** Wikidata's own ranking: `preferred`, `normal`, `deprecated`. */
  rank: string;
}

export interface EntityRecord {
  id: string;
  label: string | null;
  description: string | null;
  aliases: string[];
  statements: EntityStatement[];
  /** How many statements the entity has, since the list is trimmed. */
  statementCount: number;
  /** The matching Wikipedia article, when there is one. */
  articleUrl: string | null;
  url: string;
}

export const EntityQuery = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('search'), text: z.string().min(1).max(200), limit: z.number().int().min(1).max(20) }),
  z.object({ kind: z.literal('entity'), id: z.string().min(2).max(20) }),
  /** Resolves ids to labels in one call, so a reading does not cost one request each. */
  z.object({ kind: z.literal('labels'), ids: z.array(z.string().min(2).max(20)).min(1).max(50) }),
]);
export type EntityQuery = z.infer<typeof EntityQuery>;

export interface EntityAnswer {
  candidates?: EntityCandidate[];
  entity?: EntityRecord;
  labels?: Record<string, string>;
}

/** How many statements travel out of the family. */
export const MAX_STATEMENTS = 80;

const API = 'https://www.wikidata.org/w/api.php';
const USER_AGENT = 'AI17Z/1.0 (+https://github.com/ShiftAboveCtrl/ai17z) structured-entities';

/** `Q42`, `P31` -- anything else is not an id and is refused before a request. */
export function isEntityId(value: string): boolean {
  return /^[QP]\d+$/i.test(value.trim());
}

/**
 * Renders one Wikidata value as text.
 *
 * Wikidata stores values in seven shapes and only one of them is a plain
 * string. A renderer that assumed strings would print `[object Object]` for a
 * date, a quantity and a coordinate -- which is the sort of output that looks
 * like a bug in the model rather than a bug here.
 */
export function renderValue(snak: Record<string, unknown>): { text: string; entityId: string | null } {
  if (snak.snaktype === 'novalue') return { text: 'no value', entityId: null };
  if (snak.snaktype === 'somevalue') return { text: 'unknown value', entityId: null };

  const datavalue = snak.datavalue as { type?: string; value?: unknown } | undefined;
  if (!datavalue) return { text: 'unknown value', entityId: null };
  const value = datavalue.value;

  switch (datavalue.type) {
    case 'wikibase-entityid': {
      const id = (value as { id?: string })?.id ?? null;
      // The id, until a label is resolved for it. Never invented.
      return { text: id ?? 'unknown entity', entityId: id };
    }
    case 'string':
      return { text: String(value), entityId: null };
    case 'monolingualtext':
      return { text: String((value as { text?: string })?.text ?? ''), entityId: null };
    case 'quantity': {
      const amount = String((value as { amount?: string })?.amount ?? '');
      // Wikidata writes a leading + on positives, which is noise to a reader.
      return { text: amount.replace(/^\+/, ''), entityId: null };
    }
    case 'time': {
      const time = String((value as { time?: string })?.time ?? '');
      const precision = (value as { precision?: number })?.precision ?? 11;
      const parsed = /^([+-])(\d+)-(\d{2})-(\d{2})/.exec(time);
      if (!parsed) return { text: time, entityId: null };
      const [, sign, year, month, day] = parsed;
      const era = sign === '-' ? ' BCE' : '';
      // Precision is not decoration: Wikidata records "the 1st century" as
      // 0050-00-00 with precision 7, and printing that as a day is inventing
      // one.
      if (precision <= 9) return { text: `${Number(year)}${era}`, entityId: null };
      if (precision === 10) return { text: `${year}-${month}${era}`, entityId: null };
      return { text: `${year}-${month}-${day}${era}`, entityId: null };
    }
    case 'globecoordinate': {
      const coordinate = value as { latitude?: number; longitude?: number };
      return { text: `${coordinate.latitude ?? '?'}, ${coordinate.longitude ?? '?'}`, entityId: null };
    }
    default:
      return { text: typeof value === 'string' ? value : JSON.stringify(value).slice(0, 200), entityId: null };
  }
}

function statementsFrom(claims: Record<string, Record<string, unknown>[]>): {
  statements: EntityStatement[];
  total: number;
} {
  const all: EntityStatement[] = [];
  for (const [property, list] of Object.entries(claims)) {
    for (const claim of list) {
      const snak = claim.mainsnak as Record<string, unknown> | undefined;
      if (!snak) continue;
      const rendered = renderValue(snak);
      all.push({
        property,
        propertyLabel: null,
        value: rendered.text,
        valueEntityId: rendered.entityId,
        // Wikidata marks superseded statements `deprecated` -- a former name, a
        // population figure since corrected. Dropping the rank would present
        // those as current facts.
        rank: String(claim.rank ?? 'normal'),
      });
    }
  }
  // Preferred first, deprecated last, so a trim keeps what the community
  // considers current rather than whatever came back first.
  const order: Record<string, number> = { preferred: 0, normal: 1, deprecated: 2 };
  all.sort((a, b) => (order[a.rank] ?? 1) - (order[b.rank] ?? 1));
  return { statements: all.slice(0, MAX_STATEMENTS), total: all.length };
}

function wikidata(): Upstream<EntityQuery, EntityAnswer> {
  return defineUpstream<EntityQuery, EntityAnswer>({
    id: `${ENTITY_FAMILY}.wikidata`,
    family: ENTITY_FAMILY,
    name: 'wikidata',
    description: 'Structured facts about things, people and places.',
    origin: 'www.wikidata.org',
    limit: {
      // Their etiquette asks for requests "in series rather than in parallel".
      concurrentPerProcess: 1,
      // No number is published for reads, so these are ours and say so.
      windows: [perSecond(3, { scope: 'MACHINE' }), perMinute(60, { scope: 'MACHINE' })],
    },
    timeoutMs: 20_000,
    // Structured facts change when somebody edits them, which is not often for
    // the things an agent asks about.
    freshMs: 30 * 60_000,
    rank: 1,
    cacheKey: (query) =>
      query.kind === 'search'
        ? `s:${query.text.toLowerCase()}:${query.limit}`
        : query.kind === 'entity'
          ? `e:${query.id.toUpperCase()}`
          : `l:${query.ids.map((id) => id.toUpperCase()).sort().join(',')}`,
    async fetch(query, ctx) {
      try {
        let url: string;
        if (query.kind === 'search') {
          url =
            `${API}?action=wbsearchentities&format=json&language=en&uselang=en` +
            `&search=${encodeURIComponent(query.text)}&limit=${query.limit}`;
        } else if (query.kind === 'entity') {
          if (!isEntityId(query.id)) throw new UpstreamFailure('UNSUPPORTED', `"${query.id}" is not a Wikidata id.`);
          // The narrowest property set that answers the question. Unfiltered,
          // one entity measured 311 KB.
          url =
            `${API}?action=wbgetentities&format=json&ids=${encodeURIComponent(query.id.toUpperCase())}` +
            `&props=labels|descriptions|aliases|claims|sitelinks/urls&languages=en&sitefilter=enwiki`;
        } else {
          const ids = query.ids.filter(isEntityId).map((id) => id.toUpperCase());
          if (ids.length === 0) return { labels: {} };
          url = `${API}?action=wbgetentities&format=json&ids=${ids.join('|')}&props=labels&languages=en`;
        }

        const response = await safeFetch(url, {
          signal: ctx.signal,
          headers: { accept: 'application/json', 'user-agent': USER_AGENT },
          maxBytes: 3_000_000,
        });
        const status = classifyStatus(response.status, response.headers);
        if (status) throw status;

        const body = JSON.parse(response.text) as Record<string, unknown>;
        // The Action API answers 200 with an error object, so the status code
        // alone is not the verdict.
        if (body.error) {
          const error = body.error as { code?: string; info?: string };
          throw new UpstreamFailure('BAD_RESPONSE', `Wikidata refused: ${error.info ?? error.code ?? 'unknown'}`);
        }

        if (query.kind === 'search') {
          const hits = (body.search as Record<string, unknown>[]) ?? [];
          return {
            candidates: hits.map((hit) => ({
              id: String(hit.id),
              label: String(hit.label ?? hit.id),
              description: typeof hit.description === 'string' ? hit.description : null,
              matchedOn: (hit.match as { text?: string } | undefined)?.text ?? null,
              url: `https://www.wikidata.org/wiki/${String(hit.id)}`,
            })),
          };
        }

        const entities = (body.entities as Record<string, Record<string, unknown>>) ?? {};

        if (query.kind === 'labels') {
          const labels: Record<string, string> = {};
          for (const [id, entity] of Object.entries(entities)) {
            const label = (entity.labels as Record<string, { value?: string }> | undefined)?.en?.value;
            if (label) labels[id] = label;
          }
          return { labels };
        }

        const id = query.id.toUpperCase();
        const entity = entities[id];
        // A well-formed id nobody has used is an answer, not a fault.
        if (!entity || entity.missing !== undefined) {
          throw new UpstreamFailure('NOT_FOUND', `Wikidata has no entity ${id}.`);
        }

        const { statements, total } = statementsFrom((entity.claims as Record<string, Record<string, unknown>[]>) ?? {});
        const sitelinks = entity.sitelinks as Record<string, { url?: string }> | undefined;

        return {
          entity: {
            id,
            label: (entity.labels as Record<string, { value?: string }> | undefined)?.en?.value ?? null,
            description: (entity.descriptions as Record<string, { value?: string }> | undefined)?.en?.value ?? null,
            aliases: ((entity.aliases as Record<string, { value?: string }[]> | undefined)?.en ?? [])
              .map((alias) => alias.value ?? '')
              .filter(Boolean)
              .slice(0, 10),
            statements,
            statementCount: total,
            articleUrl: sitelinks?.enwiki?.url ?? null,
            url: `https://www.wikidata.org/wiki/${id}`,
          },
        };
      } catch (error) {
        throw classifyThrown(error);
      }
    },
  });
}

export function registerEntityUpstreams(): void {
  registerUpstream(wikidata());
}
