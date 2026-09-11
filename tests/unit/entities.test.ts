import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Which thing somebody meant, and what is recorded about it.
 *
 * "Mercury" is a planet, an element, a Roman god, a record label, a car marque,
 * a commune in Savoie and a given name. Picking the first is how an agent ends
 * up describing the orbital period of a record label, so ambiguity is the
 * answer here rather than a problem to hide.
 */

let responses: Record<string, { status: number; body: string }> = {};
/**
 * Labels the service knows, answered only for the ids actually requested.
 *
 * A mock that returns every label regardless of the query makes a reading that
 * resolved one id indistinguishable from one that resolved all of them, which
 * is exactly the bug worth catching.
 */
let labelTable: Record<string, string> | null = null;
const asked: string[] = [];

vi.mock('undici', () => ({
  Agent: class {
    async close() {}
  },
  async fetch(input: unknown) {
    const url = String(input);
    asked.push(url);

    if (labelTable && url.includes('props=labels&')) {
      const requested = decodeURIComponent(/[?&]ids=([^&]+)/.exec(url)?.[1] ?? '').split('|');
      const entities: Record<string, unknown> = {};
      for (const id of requested) {
        const value = labelTable[id];
        if (value) entities[id] = { id, labels: { en: { language: 'en', value } } };
      }
      return new Response(JSON.stringify({ entities }), {
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
      });
    }

    const match = Object.keys(responses).find((key) => url.includes(key));
    const answer = match ? responses[match]! : { status: 404, body: '{}' };
    return new Response(answer.body, {
      status: answer.status,
      headers: new Headers({ 'content-type': 'application/json' }),
    });
  },
}));

const {
  isEntityId,
  renderValue,
  registerEntityUpstreams,
  resetBreakerForTest,
  resetCacheForTest,
  resetLimiterForTest,
  resetUpstreamsForTest,
  familyMembers,
} = await import('@xbam/upstream');
const { registerEntityCapabilities } = await import('@xbam/runtime');
const { getCapability, resetCapabilitiesForTest } = await import('@xbam/tools');

function context() {
  return {
    agentId: 'agent-1',
    jobId: null,
    accountId: null,
    config: {},
    logger: { info() {}, warn() {}, error() {}, debug() {}, child: () => context().logger } as never,
    signal: new AbortController().signal,
  };
}

async function invoke(id: string, input: unknown) {
  const capability = getCapability(id);
  if (!capability) throw new Error(`${id} is not registered`);
  return capability.run(capability.input.parse(input) as never, context()) as Promise<Record<string, unknown>>;
}

function searchBody(hits: { id: string; label: string; description?: string }[]): string {
  return JSON.stringify({
    search: hits.map((hit) => ({ id: hit.id, label: hit.label, description: hit.description ?? null })),
  });
}

/** One entity, in the shape wbgetentities returns. */
function entityBody(
  id: string,
  claims: Record<string, unknown[]>,
  over: { label?: string; description?: string; enwiki?: string } = {},
): string {
  return JSON.stringify({
    entities: {
      [id]: {
        id,
        labels: { en: { language: 'en', value: over.label ?? 'Ada Lovelace' } },
        descriptions: { en: { language: 'en', value: over.description ?? 'English mathematician' } },
        aliases: { en: [{ value: 'Augusta Ada King' }] },
        claims,
        sitelinks: over.enwiki ? { enwiki: { url: over.enwiki } } : {},
      },
    },
  });
}

/** A statement whose value is another entity. */
function entityClaim(property: string, target: string, rank = 'normal') {
  return {
    mainsnak: {
      snaktype: 'value',
      property,
      datavalue: { type: 'wikibase-entityid', value: { 'entity-type': 'item', id: target } },
    },
    rank,
  };
}

function labelsBody(labels: Record<string, string>): string {
  return JSON.stringify({
    entities: Object.fromEntries(
      Object.entries(labels).map(([id, value]) => [id, { id, labels: { en: { language: 'en', value } } }]),
    ),
  });
}

beforeEach(() => {
  resetUpstreamsForTest();
  resetBreakerForTest();
  resetCacheForTest();
  resetLimiterForTest();
  resetCapabilitiesForTest();
  registerEntityUpstreams();
  registerEntityCapabilities();
  asked.length = 0;
  responses = {};
  labelTable = null;
});
afterEach(() => {
  resetUpstreamsForTest();
  resetCapabilitiesForTest();
});

describe('a name is not an identity', () => {
  it('returns every plausible reading rather than choosing', async () => {
    responses = {
      wbsearchentities: {
        status: 200,
        body: searchBody([
          { id: 'Q308', label: 'Mercury', description: 'first planet from the Solar System' },
          { id: 'Q925', label: 'mercury', description: 'chemical element with symbol Hg' },
          { id: 'Q1150', label: 'Mercury', description: 'Roman god of trade' },
          { id: 'Q165745', label: 'Mercury Records', description: 'American record label' },
        ]),
      },
    };
    const answer = await invoke('entity.resolve', { name: 'Mercury' });
    expect((answer.candidates as unknown[]).length).toBe(4);
    // Never resolved by taking the first.
    expect(answer.unambiguous).toBe(false);
    expect((answer.limitations as string[]).join(' ')).toMatch(/matches 4 different things/i);
  });

  it('calls a single match unambiguous without calling it right', async () => {
    responses = { wbsearchentities: { status: 200, body: searchBody([{ id: 'Q7259', label: 'Ada Lovelace' }]) } };
    const answer = await invoke('entity.resolve', { name: 'Ada Lovelace' });
    expect(answer.unambiguous).toBe(true);
    // One candidate means nothing else matched, not that this one is correct.
    expect((answer.limitations as string[])[0]).toMatch(/not a decision about which was meant/i);
  });

  it('treats no match as an answer rather than as a fact about the world', async () => {
    responses = { wbsearchentities: { status: 200, body: searchBody([]) } };
    const answer = await invoke('entity.resolve', { name: 'a thing nobody recorded' });
    expect(answer.candidates).toEqual([]);
    expect((answer.limitations as string[]).join(' ')).toMatch(/not evidence the thing does not exist/i);
  });

  it('refuses a name where an id belongs, without a request', async () => {
    await expect(invoke('entity.facts', { id: 'Ada Lovelace' })).rejects.toThrow(/not an entity id/i);
    expect(asked).toHaveLength(0);
  });

  it('knows an id when it sees one', () => {
    expect(isEntityId('Q7259')).toBe(true);
    expect(isEntityId('P31')).toBe(true);
    expect(isEntityId('Q')).toBe(false);
    expect(isEntityId('7259')).toBe(false);
    expect(isEntityId('Ada')).toBe(false);
  });
});

describe('values come in seven shapes and only one is a string', () => {
  it('renders an entity reference, keeping the id', () => {
    const rendered = renderValue({
      snaktype: 'value',
      datavalue: { type: 'wikibase-entityid', value: { id: 'Q5679' } },
    });
    expect(rendered.entityId).toBe('Q5679');
  });

  it('renders a date at the precision it was recorded', () => {
    // Wikidata records "the 1st century" as a date with low precision.
    // Printing that as a day would be inventing one.
    const day = renderValue({ snaktype: 'value', datavalue: { type: 'time', value: { time: '+1815-12-10T00:00:00Z', precision: 11 } } });
    const year = renderValue({ snaktype: 'value', datavalue: { type: 'time', value: { time: '+1815-01-01T00:00:00Z', precision: 9 } } });
    const month = renderValue({ snaktype: 'value', datavalue: { type: 'time', value: { time: '+1815-12-01T00:00:00Z', precision: 10 } } });
    expect(day.text).toBe('1815-12-10');
    expect(year.text).toBe('1815');
    expect(month.text).toBe('1815-12');
  });

  it('marks an era rather than printing a negative year', () => {
    const bce = renderValue({ snaktype: 'value', datavalue: { type: 'time', value: { time: '-0044-03-15T00:00:00Z', precision: 9 } } });
    expect(bce.text).toMatch(/BCE/);
  });

  it('renders quantities, coordinates and monolingual text', () => {
    expect(renderValue({ snaktype: 'value', datavalue: { type: 'quantity', value: { amount: '+80' } } }).text).toBe('80');
    expect(
      renderValue({ snaktype: 'value', datavalue: { type: 'globecoordinate', value: { latitude: 51.5, longitude: -0.1 } } }).text,
    ).toBe('51.5, -0.1');
    expect(
      renderValue({ snaktype: 'value', datavalue: { type: 'monolingualtext', value: { text: 'Augusta Ada Byron', language: 'en' } } }).text,
    ).toBe('Augusta Ada Byron');
  });

  it('says so when a statement deliberately has no value', () => {
    // "No value" and "unknown value" are recorded positions, not missing data.
    expect(renderValue({ snaktype: 'novalue' }).text).toBe('no value');
    expect(renderValue({ snaktype: 'somevalue' }).text).toBe('unknown value');
  });
});

describe('what is recorded, and how certain the editors were', () => {
  it('resolves properties and targets to words in one extra call', async () => {
    responses = {
      'claims': {
        status: 200,
        body: entityBody('Q7259', { P22: [entityClaim('P22', 'Q5679')] }, { enwiki: 'https://en.wikipedia.org/wiki/Ada_Lovelace' }),
      },
      'props=labels&': { status: 200, body: labelsBody({ P22: 'father', Q5679: 'Lord Byron' }) },
    };
    const answer = await invoke('entity.facts', { id: 'Q7259' });
    const statement = (answer.statements as Record<string, unknown>[])[0]!;
    expect(statement.propertyLabel).toBe('father');
    expect(statement.value).toBe('Lord Byron');
    // The id survives the label, because the id is the stable thing.
    expect(statement.valueEntityId).toBe('Q5679');
    expect(answer.articleUrl).toBe('https://en.wikipedia.org/wiki/Ada_Lovelace');
  });

  it('resolves a label for every statement, not just the first', async () => {
    // Counting requests is not enough: one call that asks about one id is still
    // one call, and leaves every other statement reading "P101 = Q1234".
    const claims: Record<string, unknown[]> = {};
    const labels: Record<string, string> = {};
    for (let index = 0; index < 12; index += 1) {
      claims[`P${index + 100}`] = [entityClaim(`P${index + 100}`, `Q${index + 500}`)];
      labels[`P${index + 100}`] = `property ${index}`;
      labels[`Q${index + 500}`] = `thing ${index}`;
    }
    responses = { claims: { status: 200, body: entityBody('Q7259', claims) } };
    labelTable = labels;
    const answer = await invoke('entity.facts', { id: 'Q7259', limit: 12 });
    const statements = answer.statements as Record<string, unknown>[];
    expect(statements).toHaveLength(12);
    expect(statements.every((statement) => statement.propertyLabel !== null)).toBe(true);
    expect(statements.every((statement) => String(statement.value).startsWith('thing '))).toBe(true);
  });

  it('reports the real total when the family itself had to trim', async () => {
    // The family caps at MAX_STATEMENTS before the capability's own limit ever
    // applies, and the count has to survive that cap rather than describe it.
    const claims: Record<string, unknown[]> = {};
    for (let index = 0; index < 120; index += 1) claims[`P${index + 100}`] = [entityClaim(`P${index + 100}`, `Q${index}`)];
    responses = {
      claims: { status: 200, body: entityBody('Q7259', claims) },
      'props=labels&': { status: 200, body: labelsBody({}) },
    };
    const answer = await invoke('entity.facts', { id: 'Q7259', limit: 10 });
    expect((answer.statements as unknown[]).length).toBe(10);
    expect(answer.statementCount).toBe(120);
  });

  it('costs two requests however many statements there are', async () => {
    const claims: Record<string, unknown[]> = {};
    for (let index = 0; index < 30; index += 1) claims[`P${index + 100}`] = [entityClaim(`P${index + 100}`, `Q${index}`)];
    responses = {
      'claims': { status: 200, body: entityBody('Q7259', claims) },
      'props=labels&': { status: 200, body: labelsBody({}) },
    };
    await invoke('entity.facts', { id: 'Q7259', limit: 30 });
    // One for the entity and one for every label together. A request per
    // statement would be thirty.
    expect(asked).toHaveLength(2);
  });

  it('keeps the rank, because a deprecated statement is a correction', async () => {
    responses = {
      'claims': {
        status: 200,
        body: entityBody('Q7259', {
          P1: [entityClaim('P1', 'Q1', 'deprecated')],
          P2: [entityClaim('P2', 'Q2', 'preferred')],
        }),
      },
      'props=labels&': { status: 200, body: labelsBody({}) },
    };
    const answer = await invoke('entity.facts', { id: 'Q7259' });
    const statements = answer.statements as Record<string, unknown>[];
    // Preferred first: a trim must keep what editors consider current.
    expect(statements[0]!.rank).toBe('preferred');
    expect(statements.some((statement) => statement.rank === 'deprecated')).toBe(true);
    expect((answer.limitations as string[]).join(' ')).toMatch(/since known to be wrong/i);
  });

  it('says statements are claims rather than facts', async () => {
    responses = {
      'claims': { status: 200, body: entityBody('Q7259', { P22: [entityClaim('P22', 'Q5679')] }) },
      'props=labels&': { status: 200, body: labelsBody({}) },
    };
    const answer = await invoke('entity.facts', { id: 'Q7259' });
    expect((answer.limitations as string[])[0]).toMatch(/sourced claims, not verified facts/i);
  });

  it('reports the real statement count when the list was trimmed', async () => {
    const claims: Record<string, unknown[]> = {};
    for (let index = 0; index < 40; index += 1) claims[`P${index + 100}`] = [entityClaim(`P${index + 100}`, `Q${index}`)];
    responses = {
      'claims': { status: 200, body: entityBody('Q7259', claims) },
      'props=labels&': { status: 200, body: labelsBody({}) },
    };
    const answer = await invoke('entity.facts', { id: 'Q7259', limit: 5 });
    expect((answer.statements as unknown[]).length).toBe(5);
    expect(answer.statementCount).toBe(40);
    expect((answer.limitations as string[]).join(' ')).toMatch(/40 statements/);
  });

  it('treats an id nobody has used as an answer', async () => {
    responses = { 'claims': { status: 200, body: JSON.stringify({ entities: { Q999999999: { missing: '' } } }) } };
    await expect(invoke('entity.facts', { id: 'Q999999999' })).rejects.toThrow();
  });

  it('surfaces an error the API returned inside a 200', async () => {
    // The Action API answers 200 with an error object, so the status code alone
    // is not the verdict.
    responses = {
      'claims': { status: 200, body: JSON.stringify({ error: { code: 'no-such-entity', info: 'no such entity' } }) },
    };
    await expect(invoke('entity.facts', { id: 'Q7259' })).rejects.toThrow(/refused/i);
  });
});

describe('connections are only the statements that point somewhere', () => {
  it('excludes values that are not entities', async () => {
    responses = {
      'claims': {
        status: 200,
        body: entityBody('Q7259', {
          P22: [entityClaim('P22', 'Q5679')],
          P569: [
            {
              mainsnak: { snaktype: 'value', property: 'P569', datavalue: { type: 'time', value: { time: '+1815-12-10T00:00:00Z', precision: 11 } } },
              rank: 'normal',
            },
          ],
        }),
      },
      'props=labels&': { status: 200, body: labelsBody({ P22: 'father', Q5679: 'Lord Byron' }) },
    };
    const answer = await invoke('entity.relationships', { id: 'Q7259' });
    // A date of birth is a fact about this thing, not a connection to another.
    expect(answer.totalRelationships).toBe(1);
    expect((answer.relationships as Record<string, unknown>[])[0]!.valueEntityId).toBe('Q5679');
  });
});

describe('being a good guest', () => {
  it('asks serially, as their etiquette requests, and marks the rates as ours', () => {
    // MediaWiki publishes no number for reads and asks for requests "in series
    // rather than in parallel", so claiming a published limit would be
    // inventing one.
    const wikidata = familyMembers('entity_graph')[0]!;
    expect(wikidata.limit.concurrentPerProcess).toBe(1);
    expect(wikidata.limit.windows.every((window) => window.source === 'SELF_IMPOSED')).toBe(true);
    expect(wikidata.limit.windows.every((window) => window.scope === 'MACHINE')).toBe(true);
  });

  it('never asks for the unfiltered entity, which is three hundred kilobytes', async () => {
    responses = {
      'claims': { status: 200, body: entityBody('Q7259', {}) },
      'props=labels&': { status: 200, body: labelsBody({}) },
    };
    await invoke('entity.facts', { id: 'Q7259' });
    // Measured: Douglas Adams unfiltered is 311 KB, and with this property
    // filter one entity is 122 KB.
    expect(asked[0]).toContain('props=labels');
    expect(asked[0]).toContain('languages=en');
  });
});
