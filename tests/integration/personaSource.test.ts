import { describe, expect, it } from 'vitest';
import { personaSources } from '@xbam/database';
import { personaDraftFromTraits, syncPersonaSource, getPersonaSourceAdapter } from '@xbam/persona';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';

installHarness();

const CORPUS = [
  'Builders keep building.',
  'People vote with their money.',
  'Markets always shake out the weak hands. The foundation is stronger without them.',
  'I think most short-term narratives are noise, because adoption is what actually compounds.',
  'Not predicting the future. The adoption pattern is clear.',
  'Focus on users, not politics.',
  'Huge giveaway! Retweet to enter and follow for a chance at $50,000.',
  'https://example.com/announcement',
  '#crypto #bitcoin #web3 #defi #moon',
  'Builders keep building.',
].join('\n');

describe('persona sources', () => {
  async function source(agentId: string) {
    return personaSources.upsertSource({ agentId, kind: 'manual', handle: null, label: 'pasted' });
  }

  it('ingests a pasted corpus, keeping raw evidence for everything', async () => {
    const fixture = await createFixture();
    const src = await source(fixture.agentId);
    const report = await syncPersonaSource({ sourceId: src.id, text: CORPUS });

    expect(report.error).toBeNull();
    expect(report.fetched).toBe(10);
    // The repeated line collapses before it is ever scored.
    expect(report.duplicates).toBe(1);
    expect(report.stored).toBe(9);

    const all = await personaSources.listItems({ sourceId: src.id, view: 'all', limit: 50 });
    expect(all.total).toBe(9);
    // Excluded items are still stored: exclusion is about what to learn from.
    expect(all.items.some((i) => i.excluded)).toBe(true);
    expect(all.items.every((i) => i.rawText.length > 0)).toBe(true);
  });

  it('separates useful material from noise, and says why each was dropped', async () => {
    const fixture = await createFixture();
    const src = await source(fixture.agentId);
    await syncPersonaSource({ sourceId: src.id, text: CORPUS });

    const useful = await personaSources.listItems({ sourceId: src.id, view: 'useful', limit: 50 });
    const excluded = await personaSources.listItems({ sourceId: src.id, view: 'excluded', limit: 50 });

    expect(useful.total).toBeGreaterThan(3);
    expect(excluded.total).toBeGreaterThanOrEqual(3);
    expect(excluded.items.every((i) => i.exclusionReason && i.exclusionReason.length > 0)).toBe(true);
    expect(excluded.items.some((i) => /giveaway|promotional/i.test(i.exclusionReason ?? ''))).toBe(true);
  });

  it('lets the owner overrule the machine in either direction', async () => {
    const fixture = await createFixture();
    const src = await source(fixture.agentId);
    await syncPersonaSource({ sourceId: src.id, text: CORPUS });

    const excluded = await personaSources.listItems({ sourceId: src.id, view: 'excluded', limit: 50 });
    const before = await personaSources.sourceStats(src.id);

    await personaSources.setOwnerOverride(excluded.items[0]!.id, true);
    const after = await personaSources.sourceStats(src.id);
    expect(after.useful).toBe(before.useful + 1);
    expect(after.excluded).toBe(before.excluded - 1);

    // And back again: clearing the override returns it to the machine decision.
    await personaSources.setOwnerOverride(excluded.items[0]!.id, null);
    expect((await personaSources.sourceStats(src.id)).useful).toBe(before.useful);
  });

  it('derives traits that each cite the items behind them', async () => {
    const fixture = await createFixture();
    const src = await source(fixture.agentId);
    const report = await syncPersonaSource({ sourceId: src.id, text: CORPUS });
    expect(report.traits).toBeGreaterThan(0);

    const traits = await personaSources.listTraits(fixture.agentId);
    expect(traits.some((t) => t.kind === 'style')).toBe(true);
    expect(traits.some((t) => t.kind === 'example')).toBe(true);

    // A belief is the person's own sentence, with the item it came from.
    const belief = traits.find((t) => t.kind === 'belief');
    expect(belief).toBeTruthy();
    expect(belief!.evidence.length).toBeGreaterThan(0);
    expect(belief!.evidence[0]!.text).toContain(belief!.content.slice(0, 20));
  });

  it('never derives a trait from material it excluded', async () => {
    const fixture = await createFixture();
    const src = await source(fixture.agentId);
    await syncPersonaSource({ sourceId: src.id, text: CORPUS });

    const excludedIds = new Set(
      (await personaSources.listItems({ sourceId: src.id, view: 'excluded', limit: 50 })).items.map((i) => i.id),
    );
    for (const trait of await personaSources.listTraits(fixture.agentId)) {
      for (const evidence of trait.evidence) {
        expect(excludedIds.has(evidence.id), `${trait.content} cited excluded material`).toBe(false);
      }
    }
  });

  it('produces a compact persona draft rather than the whole corpus', async () => {
    const fixture = await createFixture();
    const src = await source(fixture.agentId);
    await syncPersonaSource({ sourceId: src.id, text: CORPUS });

    const traits = await personaSources.listTraits(fixture.agentId);
    const draft = personaDraftFromTraits(traits);
    expect(draft.styleGuidelines.length).toBeGreaterThan(0);
    expect(draft.styleExamples.length).toBeLessThanOrEqual(20);
    expect(draft.topics.length).toBeLessThanOrEqual(12);
  });

  it('re-syncing does not duplicate what is already stored', async () => {
    const fixture = await createFixture();
    const src = await source(fixture.agentId);
    await syncPersonaSource({ sourceId: src.id, text: CORPUS });
    const first = await personaSources.sourceStats(src.id);

    const second = await syncPersonaSource({ sourceId: src.id, text: CORPUS });
    expect(second.stored).toBe(0);
    expect((await personaSources.sourceStats(src.id)).total).toBe(first.total);
  });

  it('reports a source it cannot run rather than pretending it worked', async () => {
    const fixture = await createFixture();
    const src = await personaSources.upsertSource({
      agentId: fixture.agentId, kind: 'x_public', handle: 'someone', label: 'X',
    });
    const availability = await getPersonaSourceAdapter('x_public').availability();

    const report = await syncPersonaSource({ sourceId: src.id, limit: 10 });
    if (availability.available) {
      // twscrape is installed here; the sync is a real network call.
      expect(report.error).toBeNull();
    } else {
      expect(report.error).toBeTruthy();
      expect((await personaSources.getSource(src.id))!.status).toBe('UNAVAILABLE');
      expect((await personaSources.getSource(src.id))!.lastError).toMatch(/twscrape|PATH/i);
    }
  });
});
