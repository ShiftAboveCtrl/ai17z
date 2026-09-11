import { z } from 'zod';
import { defineCapability, registerCapability } from '@xbam/tools';
import {
  ENTITY_FAMILY,
  ask,
  familyHealth,
  isEntityId,
  type EntityAnswer,
  type EntityQuery,
  type EntityStatement,
  type Provenance,
} from '@xbam/upstream';

/**
 * Which thing somebody meant, and what is recorded about it.
 *
 * ### Ambiguity is the answer, not a problem to hide
 *
 * "Mercury" is a planet, a chemical element, a Roman god, a record label, a car
 * marque, a commune in Savoie and a given name -- all seven come back from one
 * search. Picking the first and calling it the answer is how an agent ends up
 * describing the orbital period of a record label. So `entity.resolve` returns
 * candidates and says plainly when it cannot tell them apart; choosing is the
 * caller's problem, with the descriptions in front of them.
 *
 * ### A statement is what somebody recorded
 *
 * Wikidata is edited. A statement is evidence that an editor recorded something
 * with a source, not that it is so -- and the deprecated rank exists precisely
 * because some recorded statements are known to be wrong and kept for history.
 * The rank travels with every statement for that reason.
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

const Statement = z.object({
  property: z.string(),
  propertyLabel: z.string().nullable(),
  value: z.string(),
  /** Present when the value is another entity, so it can be looked up in turn. */
  valueEntityId: z.string().nullable(),
  /**
   * `preferred`, `normal` or `deprecated`, as the editors ranked it.
   *
   * A deprecated statement is one recorded and then known to be wrong, kept for
   * history. Presenting it alongside current ones without the rank would be
   * repeating a correction as a fact.
   */
  rank: z.string(),
});

/** How many entity ids one reading may resolve to labels. */
const MAX_LABEL_LOOKUPS = 50;

async function entitiesReadable(): Promise<{ status: 'AVAILABLE' | 'UNAVAILABLE'; why?: string }> {
  const health = await familyHealth(ENTITY_FAMILY);
  return health.some((entry) => entry.health.state === 'READY')
    ? { status: 'AVAILABLE' }
    : { status: 'UNAVAILABLE', why: 'No structured-entity source is answering.' };
}

/**
 * Turns property and entity ids into words, in one extra call.
 *
 * Without this every statement reads `P26 -> Q123456`, which is true and
 * useless. With one call per reading rather than one per statement, a
 * hundred-statement entity costs two requests instead of a hundred.
 */
async function withLabels(statements: EntityStatement[]): Promise<EntityStatement[]> {
  const wanted = new Set<string>();
  for (const statement of statements) {
    wanted.add(statement.property);
    if (statement.valueEntityId) wanted.add(statement.valueEntityId);
  }
  const ids = [...wanted].filter(isEntityId).slice(0, MAX_LABEL_LOOKUPS);
  if (ids.length === 0) return statements;

  const answer = await ask<EntityQuery, EntityAnswer>(ENTITY_FAMILY, { kind: 'labels', ids }).catch(() => null);
  const labels = answer?.value.labels ?? {};

  return statements.map((statement) => ({
    ...statement,
    propertyLabel: labels[statement.property] ?? null,
    // The id stays even when a label was found, because the id is the stable
    // thing and the label is a rendering of it.
    value: statement.valueEntityId ? (labels[statement.valueEntityId] ?? statement.value) : statement.value,
  }));
}

const resolve = defineCapability({
  id: 'entity.resolve',
  name: 'Find which thing a name refers to',
  description:
    'Finds candidate entities for a name and returns them with descriptions, so the right one can be chosen. ' +
    'Returns every plausible match rather than guessing; a name like "Mercury" has several.',
  category: 'READ',
  effect: 'READ',
  risk: 'LOW',
  input: z.object({
    name: z.string().trim().min(1).max(200),
    limit: z.number().int().min(1).max(10).default(7),
  }),
  output: z.object({
    name: z.string(),
    candidates: z.array(
      z.object({
        id: z.string(),
        label: z.string(),
        description: z.string().nullable(),
        url: z.string(),
      }),
    ),
    /**
     * Whether one candidate stands out.
     *
     * False whenever more than one plausible reading exists, which is most
     * names. Never resolved by picking the first.
     */
    unambiguous: z.boolean(),
    limitations: z.array(z.string()),
    provenance: ProvenanceOut,
  }),
  modelCallable: true,
  timeoutMs: 25_000,
  readiness: () => entitiesReadable(),
  async run(input) {
    const answer = await ask<EntityQuery, EntityAnswer>(ENTITY_FAMILY, {
      kind: 'search',
      text: input.name,
      limit: input.limit,
    });
    const candidates = answer.value.candidates ?? [];

    const limitations = [
      'These are candidate matches for a name, not a decision about which was meant.',
    ];
    if (candidates.length > 1) {
      limitations.push(
        `"${input.name}" matches ${candidates.length} different things. Choose by description before using one.`,
      );
    }
    if (candidates.length === 0) {
      limitations.push('Nothing matched that name. That is not evidence the thing does not exist.');
    }

    return {
      name: input.name,
      candidates: candidates.map((candidate) => ({
        id: candidate.id,
        label: candidate.label,
        description: candidate.description,
        url: candidate.url,
      })),
      // One candidate is not proof it is right, only that nothing else matched.
      unambiguous: candidates.length === 1,
      limitations,
      provenance: reported(answer.provenance),
    };
  },
});

const facts = defineCapability({
  id: 'entity.facts',
  name: 'What is recorded about a thing',
  description:
    'Returns recorded statements about one entity, by its id from entity.resolve. ' +
    'Statements are what editors recorded with sources, not verified fact; each carries its rank.',
  category: 'READ',
  effect: 'READ',
  risk: 'LOW',
  input: z.object({
    id: z.string().trim().min(2).max(20),
    limit: z.number().int().min(1).max(60).default(30),
  }),
  output: z.object({
    id: z.string(),
    label: z.string().nullable(),
    description: z.string().nullable(),
    aliases: z.array(z.string()),
    statements: z.array(Statement),
    /** The real total, since the list is trimmed. */
    statementCount: z.number(),
    /** The encyclopedia article, when there is one, for reading further. */
    articleUrl: z.string().nullable(),
    url: z.string(),
    limitations: z.array(z.string()),
    provenance: ProvenanceOut,
  }),
  modelCallable: true,
  timeoutMs: 40_000,
  readiness: () => entitiesReadable(),
  async run(input) {
    if (!isEntityId(input.id)) {
      // Refused here: an id that cannot be one is not worth a request, and the
      // message says where a real one comes from.
      throw new Error(`"${input.id}" is not an entity id. Use the id from entity.resolve, which looks like Q7259.`);
    }

    const answer = await ask<EntityQuery, EntityAnswer>(ENTITY_FAMILY, { kind: 'entity', id: input.id });
    const entity = answer.value.entity;
    if (!entity) throw new Error(`Nothing was returned for ${input.id}.`);

    const labelled = await withLabels(entity.statements.slice(0, input.limit));
    const limitations = [
      'These are statements editors recorded about this entity. They are sourced claims, not verified facts.',
    ];
    if (labelled.some((statement) => statement.rank === 'deprecated')) {
      limitations.push(
        'Some statements are ranked deprecated: recorded and since known to be wrong, kept for history. Do not quote those as current.',
      );
    }
    if (entity.statementCount > labelled.length) {
      limitations.push(`This entity has ${entity.statementCount} statements; the ${labelled.length} highest-ranked are here.`);
    }

    return {
      id: entity.id,
      label: entity.label,
      description: entity.description,
      aliases: entity.aliases,
      statements: labelled,
      statementCount: entity.statementCount,
      articleUrl: entity.articleUrl,
      url: entity.url,
      limitations,
      provenance: reported(answer.provenance),
    };
  },
});

const relationships = defineCapability({
  id: 'entity.relationships',
  name: 'How one thing connects to others',
  description:
    'Returns only the statements about an entity whose value is another entity, so connections can be followed. ' +
    'Each gives the other entity id, which entity.facts accepts.',
  category: 'READ',
  effect: 'READ',
  risk: 'LOW',
  input: z.object({
    id: z.string().trim().min(2).max(20),
    limit: z.number().int().min(1).max(40).default(20),
  }),
  output: z.object({
    id: z.string(),
    label: z.string().nullable(),
    relationships: z.array(Statement),
    /** How many entity-valued statements there were before trimming. */
    totalRelationships: z.number(),
    limitations: z.array(z.string()),
    provenance: ProvenanceOut,
  }),
  modelCallable: true,
  timeoutMs: 40_000,
  readiness: () => entitiesReadable(),
  async run(input) {
    if (!isEntityId(input.id)) {
      throw new Error(`"${input.id}" is not an entity id. Use the id from entity.resolve, which looks like Q7259.`);
    }

    const answer = await ask<EntityQuery, EntityAnswer>(ENTITY_FAMILY, { kind: 'entity', id: input.id });
    const entity = answer.value.entity;
    if (!entity) throw new Error(`Nothing was returned for ${input.id}.`);

    // Only statements pointing at another entity. A date of birth is a fact
    // about this thing, not a connection to another one.
    const connections = entity.statements.filter((statement) => statement.valueEntityId);
    const labelled = await withLabels(connections.slice(0, input.limit));

    const limitations = [
      'A connection recorded here is an editor\'s claim that two things are related, in the way the property names.',
    ];
    if (connections.length > labelled.length) {
      limitations.push(`There are ${connections.length} recorded connections; the ${labelled.length} highest-ranked are here.`);
    }

    return {
      id: entity.id,
      label: entity.label,
      relationships: labelled,
      totalRelationships: connections.length,
      limitations,
      provenance: reported(answer.provenance),
    };
  },
});

export function registerEntityCapabilities(): void {
  registerCapability(resolve);
  registerCapability(facts);
  registerCapability(relationships);
}
