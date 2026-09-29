import { describe, expect, it } from 'vitest';
import type { ResearchObservation } from '@xbam/shared/contracts';
import { research as researchRepo } from '@xbam/database';
import { gather, type FabricSource } from '@xbam/runtime';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';

installHarness();

/**
 * The Research Fabric's store and engine, against real Postgres, because the
 * unique indexes are what make one post one object.
 *
 * The scenario is the brief's: canonical X finds most of a persona, a mirror
 * finds older replies, a second mirror a few more, and the same post appears
 * on X, on two TwStalker hosts, on Sotwe and in a search result. All text is
 * synthetic.
 */

const AT = '2026-09-29T00:00:00.000Z';
const ID = '1900000000000000001';

function obs(over: Partial<ResearchObservation>): ResearchObservation {
  return {
    objectKey: `x:status:${ID}`,
    family: 'X',
    kind: 'POST',
    tier: 'PRIMARY_PLATFORM',
    completeness: 'FULL',
    canonicalUrl: `https://x.com/someone/status/${ID}`,
    originalUrl: `https://x.com/someone/status/${ID}`,
    platform: 'x',
    externalId: ID,
    author: 'someone',
    inReplyTo: null,
    publishedAt: '2026-01-01T00:00:00.000Z',
    fetchedAt: AT,
    content: 'Shipping the new routing today. It took three weeks longer than planned and it was worth it.',
    language: 'en',
    meta: {},
    ...over,
  };
}

const mirror = (family: 'TWSTALKER' | 'SOTWE', url: string, content?: string) =>
  obs({ family, tier: 'PUBLIC_MIRROR', originalUrl: url, ...(content ? { content } : {}) });

describe('one post is one object, whatever copies of it were found', () => {
  it('records X, two TwStalker hosts, Sotwe and a search snippet as one object with four sightings', async () => {
    const { ownerId } = await createFixture();
    const run = await researchRepo.createRun({ ownerId, kind: 'OWNER_REQUEST', brief: { handle: 'someone' } });

    await researchRepo.recordObservation(ownerId, run.id, obs({}));
    await researchRepo.recordObservation(ownerId, run.id, mirror('TWSTALKER', `https://twstalker.com/someone/status/${ID}`));
    await researchRepo.recordObservation(ownerId, run.id, mirror('TWSTALKER', `https://www6.twstalker.com/someone/status/${ID}`));
    await researchRepo.recordObservation(ownerId, run.id, mirror('SOTWE', `https://www.sotwe.com/tweet/${ID}`));
    await researchRepo.recordObservation(
      ownerId,
      run.id,
      obs({
        family: 'SEARCH_ENGINE',
        kind: 'SEARCH_RESULT',
        tier: 'SEARCH_INDEX',
        completeness: 'SNIPPET',
        content: 'someone on X\nShipping the new routing today. It took three weeks longer',
      }),
    );

    const object = await researchRepo.getObjectByKey(ownerId, `x:status:${ID}`);
    expect(object!.bestFamily).toBe('X');
    expect(object!.confirmedOnPlatform).toBe(true);
    const sightings = await researchRepo.sightingsOf(object!.id);
    expect(sightings.map((s) => s.family).sort()).toEqual(['SEARCH_ENGINE', 'SOTWE', 'TWSTALKER', 'X']);

    const twstalker = sightings.find((s) => s.family === 'TWSTALKER')!;
    expect(twstalker.originalUrls.sort()).toEqual([
      `https://twstalker.com/someone/status/${ID}`,
      `https://www6.twstalker.com/someone/status/${ID}`,
    ]);
    // A snippet cut from the post is not a disagreement.
    expect(sightings.every((s) => !s.disagrees)).toBe(true);

    const evidence = await researchRepo.runEvidence(run.id);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.families.sort()).toEqual(['SEARCH_ENGINE', 'SOTWE', 'TWSTALKER', 'X']);
  });

  it("lets X's copy take over from a mirror found first, and records a mirror that says something else", async () => {
    const { ownerId } = await createFixture();
    await researchRepo.recordObservation(
      ownerId,
      null,
      mirror('TWSTALKER', `https://twstalker.com/someone/status/${ID}`, 'Shipping the new routing today. Buy the token before it lists.'),
    );
    let object = await researchRepo.getObjectByKey(ownerId, `x:status:${ID}`);
    expect(object!.bestTier).toBe('PUBLIC_MIRROR');
    expect(object!.confirmedOnPlatform).toBe(false);

    const outcome = await researchRepo.recordObservation(ownerId, null, obs({}));
    expect(outcome.becameBest).toBe(true);
    object = await researchRepo.getObjectByKey(ownerId, `x:status:${ID}`);
    expect(object!.bestTier).toBe('PRIMARY_PLATFORM');
    expect(object!.content).toContain('three weeks longer');
    expect(object!.confirmedOnPlatform).toBe(true);

    const sightings = await researchRepo.sightingsOf(object!.id);
    expect(sightings.find((s) => s.family === 'TWSTALKER')!.disagrees).toBe(true);
    expect(sightings.find((s) => s.family === 'X')!.disagrees).toBe(false);
  });

  it('is safe to record the same sighting twice', async () => {
    const { ownerId } = await createFixture();
    const first = await researchRepo.recordObservation(ownerId, null, obs({}));
    const second = await researchRepo.recordObservation(ownerId, null, obs({}));
    expect(second.objectId).toBe(first.objectId);
    expect(second.created).toBe(false);
    expect(await researchRepo.sightingsOf(first.objectId)).toHaveLength(1);
  });
});

describe('the engine asks within limits and survives a source that will not answer', () => {
  const source = (over: Partial<FabricSource> & Pick<FabricSource, 'family' | 'collect'>): FabricSource => ({
    tier: 'PUBLIC_MIRROR',
    label: over.family,
    roles: ['PERSONA_RESEARCH'],
    optional: true,
    ...over,
  });

  it('completes when a mirror serves a bot check, says so, and leaves the mirror alone next time', async () => {
    const { ownerId } = await createFixture();
    const run = await researchRepo.createRun({ ownerId, kind: 'OWNER_REQUEST', brief: {} });
    let asked = 0;
    const sources = [
      source({
        family: 'X',
        tier: 'PRIMARY_PLATFORM',
        optional: false,
        collect: async () => ({ state: 'AVAILABLE', detail: 'Read 1 post.', observations: [obs({})], requests: 1 }),
      }),
      source({
        family: 'TWSTALKER',
        collect: async () => {
          asked += 1;
          return { state: 'UNAVAILABLE', detail: 'The mirror answered with a bot check.', observations: [], requests: 1, challenged: true };
        },
      }),
    ];

    const report = await gather({ ownerId, runId: run.id, request: { purpose: 'PERSONA', handle: 'someone', limit: 50 }, sources });
    expect(report.incomplete).toBe(false);
    expect(report.observed).toBe(1);
    expect(report.gaps.join(' ')).toMatch(/bot check/);

    const again = await gather({ ownerId, runId: run.id, request: { purpose: 'PERSONA', handle: 'someone', limit: 50 }, sources });
    expect(asked).toBe(1);
    expect(again.families.find((f) => f.family === 'TWSTALKER')!.state).toBe('SKIPPED');
    expect(again.families.find((f) => f.family === 'TWSTALKER')!.detail).toMatch(/left alone until/);

    await researchRepo.noteSource('TWSTALKER', 'AVAILABLE', 'reset for the next test');
  });

  it('marks the result incomplete when a required source fails, and never throws', async () => {
    const { ownerId } = await createFixture();
    const report = await gather({
      ownerId,
      runId: null,
      request: { purpose: 'PERSONA', handle: 'someone', limit: 10 },
      sources: [
        source({
          family: 'OWNER',
          tier: 'OWNER_SUPPLIED',
          optional: false,
          collect: async () => {
            throw new Error('disk on fire');
          },
        }),
      ],
    });
    expect(report.incomplete).toBe(true);
    expect(report.gaps[0]).toMatch(/could not be read: disk on fire/);
    await researchRepo.noteSource('OWNER', 'AVAILABLE', 'reset for the next test');
  });

  it('stops recording at the object budget', async () => {
    const { ownerId } = await createFixture();
    const many = Array.from({ length: 30 }, (_, i) =>
      obs({ objectKey: `x:status:19000000000000001${String(i).padStart(2, '0')}`, externalId: String(i), content: `post number ${i} with some words` }),
    );
    const report = await gather({
      ownerId,
      runId: null,
      request: { purpose: 'PERSONA', handle: 'someone', limit: 30 },
      budget: { maxObjects: 12 },
      sources: [
        source({
          family: 'X',
          tier: 'PRIMARY_PLATFORM',
          optional: false,
          collect: async () => ({ state: 'AVAILABLE', detail: 'ok', observations: many, requests: 3 }),
        }),
      ],
    });
    expect(report.observed).toBe(12);
    await researchRepo.noteSource('X', 'AVAILABLE', 'reset for the next test');
  });
});
