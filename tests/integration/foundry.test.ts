import { describe, expect, it } from 'vitest';
import type { ResearchObservation } from '@xbam/shared/contracts';
import { agents as agentsRepo, foundry as foundryRepo, knowledge as knowledgeRepo, query, research as researchRepo, stances as stancesRepo } from '@xbam/database';
import { MAX_X_ATTEMPTS, advanceFoundryRun, applyFoundry, nextStage, type FabricSource, type FoundryDeps } from '@xbam/runtime';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { builderPersona } from '../support/syntheticPersonas';

installHarness();

/**
 * Agent Foundry end to end, with every outside source faked and every store
 * real. The persona is synthetic: a builder who is short by default and long
 * when technical, talks about a made-up project called Pons and a made-up
 * Robinhood Chain, and mentions faith twice.
 */

const HANDLE = 'synthbuilder';
const statusOf = (i: number) => `19000000000000${String(10000 + i)}`;

function asObservation(item: { id: string; text: string; kind: string; lang?: string | null; createdAt?: string | null }, i: number, family: 'X' | 'TWSTALKER' = 'X'): ResearchObservation {
  const id = statusOf(i);
  return {
    objectKey: `x:status:${id}`,
    family,
    kind: item.kind === 'reply' ? 'REPLY' : item.kind === 'quote' ? 'QUOTE' : 'POST',
    tier: family === 'X' ? 'PRIMARY_PLATFORM' : 'PUBLIC_MIRROR',
    completeness: 'FULL',
    canonicalUrl: `https://x.com/${HANDLE}/status/${id}`,
    originalUrl: family === 'X' ? `https://x.com/${HANDLE}/status/${id}` : `https://twstalker.com/${HANDLE}/status/${id}`,
    platform: 'x',
    externalId: id,
    author: HANDLE,
    inReplyTo: item.kind === 'reply' ? 'someone' : null,
    publishedAt: item.createdAt ?? null,
    fetchedAt: '2026-09-29T00:00:00.000Z',
    content: item.text,
    language: item.lang ?? 'en',
    meta: {},
  };
}

function deps(options: { leaseMs?: number; workerId?: string; indexed?: boolean } = {}): FoundryDeps & { mirrorAsks: number } {
  const corpus = builderPersona();
  // X shows the first 80; a mirror has 12 older ones X did not surface, plus 5 duplicates.
  const onX = corpus.slice(0, 80).map((item, i) => asObservation(item, i));
  const olderOnMirror = corpus.slice(80).map((item, i) => asObservation(item, 80 + i, 'TWSTALKER'));
  const dupes = corpus.slice(0, 5).map((item, i) => asObservation(item, i, 'TWSTALKER'));
  const state = { mirrorAsks: 0 };
  const platform: FabricSource = {
    family: 'X',
    tier: 'PRIMARY_PLATFORM',
    label: 'X',
    roles: ['PERSONA_RESEARCH'],
    optional: false,
    collect: async () => ({ state: 'AVAILABLE', detail: 'Read 80.', observations: onX, requests: 4 }),
  };
  const twstalker: FabricSource = {
    family: 'TWSTALKER',
    tier: 'PUBLIC_MIRROR',
    label: 'TwStalker',
    roles: ['SOCIAL_HISTORY'],
    optional: true,
    collect: async () => {
      state.mirrorAsks += 1;
      return { state: 'AVAILABLE', detail: 'Read 17.', observations: [...olderOnMirror, ...dupes], requests: 2 };
    },
  };
  const sotwe: FabricSource = {
    family: 'SOTWE',
    tier: 'PUBLIC_MIRROR',
    label: 'Sotwe',
    roles: ['SOCIAL_HISTORY'],
    optional: true,
    collect: async () => ({ state: 'UNAVAILABLE', detail: 'The mirror answered with a bot check, so it was left alone.', observations: [], requests: 1, challenged: true }),
  };
  // The search index points at the mirror's pages for the older posts: a
  // second family, so a whole mirror copy by the right author is grade B.
  const searchIndex: FabricSource = {
    family: 'SEARCH_ENGINE',
    tier: 'SEARCH_INDEX',
    label: 'Search engines',
    roles: ['PERSONA_RESEARCH'],
    optional: true,
    collect: async () => ({
      state: 'AVAILABLE',
      detail: 'Found 12.',
      requests: 2,
      observations: olderOnMirror.map((o) => ({ ...o, family: 'SEARCH_ENGINE', kind: 'SEARCH_RESULT', tier: 'SEARCH_INDEX', completeness: 'SNIPPET', content: o.content.slice(0, 60) })),
    }),
  };
  return {
    workerId: options.workerId ?? 'test-worker',
    leaseMs: options.leaseMs ?? 60_000,
    platform,
    searchIndex: options.indexed === false ? null : searchIndex,
    mirrors: [twstalker, sotwe],
    get mirrorAsks() {
      return state.mirrorAsks;
    },
    resolveProfile: async (handle) => ({ handle, displayName: 'Synth Builder', bio: 'building things', website: 'https://pons.example/' }),
    search: async (query) =>
      query.includes('github')
        ? [{ title: 'pons-protocol/pons-v2', snippet: '', url: 'https://github.com/pons-protocol/pons-v2' }]
        : [
            { title: 'Pons V1 docs', snippet: '', url: 'https://docs.pons.example/v1/' },
            { title: 'Pons V2 docs', snippet: '', url: 'https://docs.pons.example/v2/' },
            { title: 'Somebody blogs about Pons', snippet: '', url: 'https://randomblog.example/pons-review' },
          ],
    // Two of the older mirror-only posts turn out to be on X after all.
    confirmPost: async (statusId) => {
      const i = Number(statusId.slice(-5)) - 10000;
      return i === 80 || i === 81 ? { ...olderOnMirror[i - 80]!, family: 'X', tier: 'PRIMARY_PLATFORM', originalUrl: `https://x.com/${HANDLE}/status/${statusId}` } : null;
    },
  };
}

async function startRun(kind: 'FOUNDRY_SETUP' | 'FOUNDRY_IMPROVE' = 'FOUNDRY_SETUP') {
  const fixture = await createFixture();
  const run = await researchRepo.createRun({
    ownerId: fixture.ownerId,
    agentId: fixture.agentId,
    kind,
    brief: { text: 'Build an Agent modeled on @synthbuilder. Understand Pons.', handle: HANDLE, projects: ['Pons'], autonomy: 'SELECTIVE' },
  });
  return { fixture, run };
}

describe('a research-backed setup, from brief to proposal', () => {
  it('reads the persona, survives a mirror bot check, and proposes an evidence-backed setup', async () => {
    const { run } = await startRun();
    const d = deps();
    const claimed = (await researchRepo.claimDueRun(d.workerId, d.leaseMs))!;
    expect(claimed.id).toBe(run.id);
    expect(await advanceFoundryRun(claimed, d)).toBe('READY');

    const done = (await researchRepo.getRun(run.id))!;
    expect(done.status).toBe('READY');
    expect(done.stageLog.map((s) => s.stage)).toEqual([
      'UNDERSTANDING', 'FINDING_SOURCES', 'READING_X', 'SECONDARY_SOURCES', 'DEDUPLICATING', 'VOICE', 'TOPICS', 'BELIEFS', 'KNOWLEDGE', 'SAFETY', 'TESTS', 'READY',
    ]);
    expect(done.stageLog.find((s) => s.stage === 'SECONDARY_SOURCES')!.detail).toMatch(/Sotwe unavailable/);

    // One corpus: 80 from X, 12 older from the mirror, the 5 mirror duplicates collapsed.
    const evidence = await researchRepo.runEvidence(run.id, { author: HANDLE });
    expect(evidence).toHaveLength(builderPersona().length);
    expect(evidence.filter((e) => e.confirmedOnPlatform)).toHaveLength(82);

    const items = await foundryRepo.listItems(run.id);
    const by = (section: string, key?: string) => items.filter((i) => i.section === section && (!key || i.itemKey === key));

    expect(by('IDENTITY', 'identityKind')[0]!.proposedValue).toBe('INSPIRED_BY');
    const topics = by('TOPICS', 'topics')[0]!.proposedValue as string[];
    expect(topics.map((t) => t.toLowerCase())).toEqual(expect.arrayContaining(['pons', 'robinhood chain']));
    for (const stop of ['will', 'have', 'just']) expect(topics.map((t) => t.toLowerCase())).not.toContain(stop);
    expect(String(by('STYLE', 'styleGuidelines')[0]!.proposedValue)).toMatch(/Default to short, casual replies/);
    expect(by('STYLE', 'responseLength')[0]!.proposedValue).toBe('ADAPTIVE');

    const never = by('MUST_NEVER')[0]!.proposedValue as string[];
    expect(never.join(' ')).toMatch(/Never claim to be @synthbuilder/);
    expect(never.join(' ')).toMatch(/contract address/);

    // Faith is contextual, not a talking point.
    const instructions = String(by('INSTRUCTIONS')[0]?.proposedValue ?? '');
    expect(instructions).toMatch(/faith/i);
    expect(instructions).toMatch(/never bring/);
    expect(topics.map((t) => t.toLowerCase())).not.toContain('faith');

    // Official sources only, with V1 and V2 kept apart; the blog is not proposed.
    const knowledge = by('KNOWLEDGE').map((i) => i.proposedValue as { location: string; labels: { generation?: string } });
    expect(knowledge.map((k) => k.location)).toEqual(expect.arrayContaining(['https://docs.pons.example/v1', 'https://docs.pons.example/v2', 'https://github.com/pons-protocol/pons-v2']));
    expect(knowledge.map((k) => k.location).join(' ')).not.toMatch(/randomblog/);
    expect(knowledge.find((k) => k.location.endsWith('/v2'))!.labels.generation).toBe('V2');
    expect(instructions).toMatch(/V1, V2|never mix/);

    expect(by('AUTONOMY', 'automation')[0]!.proposedValue).toMatchObject({ mode: 'AUTONOMOUS' });
    expect(by('AUTONOMY', 'engagement')[0]!.proposedValue).toMatchObject({ maxRepliesPerThread: 3, maxRepliesPerPersonPerHour: 3 });

    const tests = by('TESTS').map((i) => i.proposedValue as { category: string; message: string });
    expect(tests.map((t) => t.category)).toEqual(expect.arrayContaining(['Identity question', 'Mass-tag spam', 'Scam contract', 'Version confusion']));
    // Synthetic shapes only: no test quotes the persona.
    const persona = new Set(builderPersona().map((b) => b.text.toLowerCase()));
    for (const t of tests) expect(persona.has(t.message.toLowerCase())).toBe(false);

    // Every item explains itself; evidence-backed ones cite something.
    for (const item of items) expect(item.rationale.length).toBeGreaterThan(20);
    expect(by('TOPICS', 'topics')[0]!.evidence.length).toBeGreaterThan(0);
  });

  it('learns nothing about a voice from one mirror nobody else saw', async () => {
    const { run } = await startRun();
    const d = deps({ indexed: false });
    const claimed = (await researchRepo.claimDueRun(d.workerId, d.leaseMs))!;
    expect(await advanceFoundryRun(claimed, d)).toBe('READY');
    // The mirror-only posts are still evidence an owner can see...
    const evidence = await researchRepo.runEvidence(run.id, { author: HANDLE });
    expect(evidence).toHaveLength(builderPersona().length);
    // ...but the technical register lives only there, so it is not proposed.
    const items = await foundryRepo.listItems(run.id);
    const style = items.find((i) => i.section === 'STYLE' && i.itemKey === 'styleGuidelines');
    expect(String(style?.proposedValue ?? '')).not.toMatch(/Default to short, casual replies/);
  });

  it('resumes after a lost lease at the stage after the last one committed', async () => {
    const { run } = await startRun();
    const first = deps({ workerId: 'worker-a', leaseMs: 1 });
    const claimed = (await researchRepo.claimDueRun('worker-a', 60_000))!;
    // Worker A commits two stages, then its lease runs out.
    await researchRepo.commitStage(claimed.id, 'worker-a', { stage: 'UNDERSTANDING', detail: 'ok', plan: { handle: HANDLE, projects: ['Pons'] } });
    await researchRepo.commitStage(claimed.id, 'worker-a', { stage: 'FINDING_SOURCES', detail: 'ok', plan: { handle: HANDLE, projects: ['Pons'], discovered: [], gaps: [], coverage: [], profile: null } });
    await researchRepo.deferRun(claimed.id, 'worker-a', 0, 'simulated crash');
    void first;

    const b = deps({ workerId: 'worker-b' });
    const again = (await researchRepo.claimDueRun('worker-b', 60_000))!;
    expect(nextStage(again)).toBe('READING_X');
    expect(await advanceFoundryRun(again, b)).toBe('READY');
    // Worker A cannot commit over worker B's run any more.
    expect(await researchRepo.commitStage(run.id, 'worker-a', { stage: 'READY', detail: 'late' })).toBe(false);
  });
});

describe('applying what the owner accepted', () => {
  it('writes through the canonical settings, and applying twice changes nothing more', async () => {
    const { fixture, run } = await startRun();
    const d = deps();
    await advanceFoundryRun((await researchRepo.claimDueRun(d.workerId, d.leaseMs))!, d);
    const items = await foundryRepo.listItems(run.id);
    const reject = items.find((i) => i.section === 'RADAR')!;
    await foundryRepo.decideItem(reject.id, { status: 'REJECTED' });
    const topicsItem = items.find((i) => i.itemKey === 'topics')!;
    await foundryRepo.decideItem(topicsItem.id, { status: 'EDITED', ownerValue: ['Pons', 'Robinhood Chain', 'builders'] });
    await foundryRepo.acceptAll(run.id);

    const before = await agentsRepo.getActivePersona(fixture.agentId);
    const report = await applyFoundry({ runId: run.id, userId: fixture.ownerId });
    expect(report.personaVersion).toBeGreaterThan(before?.version ?? 0);
    expect(report.policyVersion).not.toBeNull();
    // No X account on this fixture: Radar is skipped with a sentence, never guessed.
    expect(report.skipped.some((s) => /no X account connected/.test(s.reason))).toBe(true);

    const persona = (await agentsRepo.getActivePersona(fixture.agentId))!;
    expect(persona.identityKind).toBe('INSPIRED_BY');
    expect(persona.topics).toEqual(['Pons', 'Robinhood Chain', 'builders']);
    expect(persona.prohibitedBehaviors.join(' ')).toMatch(/Never claim to be @synthbuilder/);
    const policy = (await agentsRepo.getActivePolicy(fixture.agentId))!;
    expect(policy.config.engagement.maxRepliesPerThread).toBe(3);

    const knowledge = await knowledgeRepo.listSources(fixture.agentId);
    expect(knowledge.length).toBeGreaterThanOrEqual(2);
    expect(knowledge.every((k) => k.nextRefreshAt !== null)).toBe(true);

    const beliefs = await stancesRepo.listActive(fixture.agentId);
    for (const b of beliefs) expect(b.pinned).toBe(false);

    const again = await applyFoundry({ runId: run.id, userId: fixture.ownerId });
    expect(again.applied).toHaveLength(0);
    expect(again.personaVersion).toBeNull();
  });
});

describe('improving an existing agent', () => {
  it('assesses what the owner set against the research and changes nothing until accepted', async () => {
    const { fixture, run } = await startRun('FOUNDRY_IMPROVE');
    const existing = (await agentsRepo.getActivePersona(fixture.agentId))!;
    await agentsRepo.savePersonaVersion(
      fixture.agentId,
      { ...existing, topics: ['Pons', 'underwater basket weaving'], prohibitedBehaviors: ['Never swear.'], tone: 'Short, casual and direct.' },
      fixture.ownerId,
    );
    const owned = (await agentsRepo.getActivePersona(fixture.agentId))!;

    const d = deps();
    await advanceFoundryRun((await researchRepo.claimDueRun(d.workerId, d.leaseMs))!, d);
    const items = await foundryRepo.listItems(run.id);

    expect(items.find((i) => i.itemKey === 'topics')!.assessment).toBe('WEAK');
    // Topics research found nothing behind are one grouped item, never one per topic.
    const unsupported = items.find((i) => i.itemKey === 'unsupported-topics');
    expect(unsupported?.assessment).toBe('UNSUPPORTED');
    expect(unsupported?.currentValue).toEqual(['underwater basket weaving']);
    // The owner's own rule is kept in the proposal; rules are only ever added.
    expect(items.find((i) => i.section === 'MUST_NEVER')!.proposedValue).toEqual(expect.arrayContaining(['Never swear.']));

    // A dry run: nothing changed.
    const after = (await agentsRepo.getActivePersona(fixture.agentId))!;
    expect(after.version).toBe(owned.version);
    expect(after.topics).toEqual(owned.topics);
  });
});

describe('a queued run says why it is waiting', () => {
  it('names a missing browser worker, then a worker short of memory, then nothing', async () => {
    const { query, workers, STANDARD_WORK } = await import('@xbam/database');
    const { foundryRunView } = await import('@xbam/runtime');
    const fixture = await createFixture();
    const run = await researchRepo.createRun({ ownerId: fixture.ownerId, agentId: fixture.agentId, kind: 'FOUNDRY_SETUP', brief: { text: 'x' } as never });
    await query('DELETE FROM workers');

    expect((await foundryRunView(run.id))!.waitingFor).toMatch(/No worker with a browser/);

    const report = (available: boolean) =>
      workers.heartbeat({ id: 'native-proof', role: 'browser', browserCapable: true, jobsCapable: false, tools: { [STANDARD_WORK]: { available, detail: available ? 'Running background work.' : 'The machine this worker runs on is very short of memory.' } } });
    await report(false);
    expect((await foundryRunView(run.id))!.waitingFor).toMatch(/short of memory.*nothing is lost/);

    await report(true);
    expect((await foundryRunView(run.id))!.waitingFor).toBeNull();
  });
});

describe('a persona X would not show', () => {
  const withPlatform = (collect: FabricSource['collect']): FoundryDeps => ({
    ...deps(),
    platform: { family: 'X', tier: 'PRIMARY_PLATFORM', label: 'X', roles: ['PERSONA_RESEARCH'], optional: false, collect },
    mirrors: [],
  });

  it('waits rather than building a persona from a failed read, and stops saying why after the bound', async () => {
    const { run } = await startRun();
    const d = withPlatform(async () => ({
      state: 'UNAVAILABLE',
      detail: 'X says @synthbuilder has 237 posts, and showed none of them, so the read failed rather than finding an empty account.',
      observations: [],
      requests: 2,
      retryAfterMs: 15 * 60_000,
    }));
    const claimed = (await researchRepo.claimDueRun(d.workerId, d.leaseMs))!;
    expect(await advanceFoundryRun(claimed, d)).toBe('DEFERRED');
    expect(await foundryRepo.listItems(run.id)).toEqual([]);

    await query(`UPDATE research_runs SET attempts = $2, next_attempt_at = now() WHERE id = $1`, [run.id, MAX_X_ATTEMPTS]);
    const again = (await researchRepo.claimDueRun(d.workerId, d.leaseMs))!;
    expect(await advanceFoundryRun(again, d)).toBe('FAILED');
    const done = (await researchRepo.getRun(run.id))!;
    expect(done.status).toBe('FAILED');
    expect(done.stageLog.at(-1)!.detail).toMatch(/would not show @synthbuilder's timeline .* Nothing was proposed/);
    expect(await foundryRepo.listItems(run.id)).toEqual([]);
  });

  it('stops at once, with the reason, when the account cannot be read at all', async () => {
    const { run } = await startRun();
    const d = withPlatform(async () => ({
      state: 'UNAVAILABLE',
      detail: 'That account is protected.',
      observations: [],
      requests: 2,
      fatal: 'That account is protected, so its posts are not public and AI17Z cannot read them.',
    }));
    const claimed = (await researchRepo.claimDueRun(d.workerId, d.leaseMs))!;
    expect(await advanceFoundryRun(claimed, d)).toBe('FAILED');
    const done = (await researchRepo.getRun(run.id))!;
    expect(done.stageLog.at(-1)!.detail).toMatch(/protected.*Nothing was proposed/);
    expect(await foundryRepo.listItems(run.id)).toEqual([]);
  });

  it('an account X itself shows as empty is honestly low data, not a failure', async () => {
    const { run } = await startRun();
    const d = withPlatform(async () => ({ state: 'AVAILABLE', detail: '@synthbuilder has no public posts AI17Z can read.', observations: [], requests: 2 }));
    const claimed = (await researchRepo.claimDueRun(d.workerId, d.leaseMs))!;
    expect(await advanceFoundryRun(claimed, d)).toBe('READY');
    const done = (await researchRepo.getRun(run.id))!;
    expect(done.stageLog.find((s) => s.stage === 'VOICE')!.detail).toMatch(/0 measurements from 0 items/);
  });
});
