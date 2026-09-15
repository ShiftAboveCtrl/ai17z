import { beforeEach, describe, expect, it } from 'vitest';
import { repoSources } from '@xbam/database';
import { registerGithubCapabilities } from '@xbam/runtime';
import { getCapability, listCapabilities, registerBuiltinCapabilities, resetCapabilitiesForTest } from '@xbam/tools';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';

installHarness();

/**
 * What an agent may ask about a project it follows.
 *
 * Against a real database because the boundary being tested is a row: an agent
 * may read the watches its owner pointed it at, and nothing else. A mock would
 * test whichever boundary the mock was written to have.
 *
 * The important property is not that these return data. It is that they answer
 * from what AI17Z recorded and never call GitHub -- so a model cannot make an
 * agent hammer somebody else's API by asking the same question in a loop, every
 * answer carries the URL the fact came from, and what an agent can say about a
 * project is exactly what its owner can see on the screen.
 */

beforeEach(() => {
  resetCapabilitiesForTest();
  registerBuiltinCapabilities();
  registerGithubCapabilities();
});

async function agentWatching(repo: string | null) {
  const fixture = await createFixture();
  if (repo) {
    const source = await repoSources.watchRepo({
      ownerUserId: fixture.ownerId,
      agentId: fixture.agentId,
      repo,
      kinds: ['RELEASE', 'COMMIT'],
    });
    await repoSources.recordRepoEvent({
      sourceId: source.id,
      kind: 'RELEASE',
      remoteId: 'v1.0.0-beta.20',
      title: 'AI17Z Beta 1.0.0 (20)',
      body: 'One place AI17Z reads X from, and an account you can get rid of.',
      url: 'https://github.com/example/proj/releases/tag/v1.0.0-beta.20',
      occurredAt: new Date().toISOString(),
    });
    await repoSources.recordRepoEvent({
      sourceId: source.id,
      kind: 'COMMIT',
      remoteId: 'abc123',
      title: 'Stop force-killing Chrome before its cookies are flushed',
      url: 'https://github.com/example/proj/commit/abc123',
      occurredAt: new Date().toISOString(),
    });
  }
  return fixture;
}

/**
 * Run a capability the way the loop does, minus the permission machinery.
 *
 * `AnyCapability` erases its input type -- deliberately, so nothing can call one
 * without going through the schema -- and these tests are about what the
 * implementations answer rather than about the permission gate, which
 * `packsOff.test.ts` already covers. The cast is local and named for that.
 */
const run = async <T>(id: string, input: unknown, agentId: string): Promise<T> => {
  const capability = getCapability(id)!;
  const invoke = capability.run as unknown as (i: unknown, c: unknown) => Promise<T>;
  return invoke(capability.input.parse(input), ctx(agentId));
};

const ctx = (agentId: string) => ({
  agentId,
  jobId: null,
  accountId: null,
  config: {},
  logger: console as never,
  signal: new AbortController().signal,
});

describe('what a project did', () => {
  it('answers from what AI17Z recorded, with a link for each', async () => {
    const agent = await agentWatching('example/proj');
    const result = await run<{ events: { title: string; url: string }[] }>(
      'github.read_activity',
      { limit: 10 },
      agent.agentId,
    );
    expect(result.events.length).toBe(2);
    for (const event of result.events) {
      // A claim about a project with no URL behind it is a claim nobody can
      // check, which is the whole reason the row keeps one.
      expect(event.url).toMatch(/^https:\/\/github\.com\//);
    }
  });

  it('filters to one kind when asked', async () => {
    const agent = await agentWatching('example/proj');
    const result = await run<{ events: { kind: string }[] }>(
      'github.read_activity',
      { kind: 'RELEASE', limit: 10 },
      agent.agentId,
    );
    expect(result.events.map((event) => event.kind)).toEqual(['RELEASE']);
  });

  it('says it follows nothing rather than answering about nothing', async () => {
    const agent = await agentWatching(null);
    const result = await run<{ events: unknown[]; detail: string }>(
      'github.read_activity',
      { limit: 10 },
      agent.agentId,
    );
    expect(result.events).toEqual([]);
    expect(result.detail).toMatch(/does not follow any repository/);
  });

  it('refuses a repository its owner never pointed it at', async () => {
    const agent = await agentWatching('example/proj');
    const result = await run<{ events: unknown[]; detail: string }>(
      'github.read_activity',
      { repo: 'someone/else', limit: 10 },
      agent.agentId,
    );
    // An agent cannot reach a project nobody asked it to follow, and it cannot
    // add a watch either.
    expect(result.events).toEqual([]);
    expect(result.detail).toMatch(/does not follow someone\/else/);
  });

  it('will not read another agent’s watches', async () => {
    const mine = await agentWatching('example/proj');
    const stranger = await agentWatching('private/thing');

    const result = await run<{ events: unknown[] }>(
      'github.read_activity',
      { repo: 'private/thing', limit: 10 },
      mine.agentId,
    );
    expect(result.events).toEqual([]);
    expect(stranger.agentId).not.toBe(mine.agentId);
  });
});

describe('what was in a release', () => {
  it('returns the notes as published', async () => {
    const agent = await agentWatching('example/proj');
    const result = await run<{ found: boolean; tag: string | null; notes: string; detail: string }>(
      'github.read_release',
      { repo: 'example/proj' },
      agent.agentId,
    );
    expect(result.found).toBe(true);
    expect(result.tag).toBe('v1.0.0-beta.20');
    expect(result.notes).toContain('One place AI17Z reads X from');
    // The instruction travels with the answer: an agent that embellishes a
    // changelog invents a feature somebody will look for.
    expect(result.detail).toMatch(/Do not describe anything that is not in them/);
  });

  it('says it has not read a release rather than approximating one', async () => {
    const agent = await agentWatching('example/proj');
    const result = await run<{ found: boolean; detail: string }>(
      'github.read_release',
      { repo: 'example/proj', tag: 'v9.9.9' },
      agent.agentId,
    );
    // A plausible invented changelog is worse than an admission.
    expect(result.found).toBe(false);
    expect(result.detail).toMatch(/has not recorded a release tagged v9\.9\.9/);
  });
});

describe('the boundary', () => {
  it('has nothing in the github family that is not a read', () => {
    const family = listCapabilities().filter((capability) => capability.id.startsWith('github.'));
    expect(family.map((capability) => capability.id).sort()).toEqual([
      'github.read_activity',
      'github.read_release',
    ]);
    for (const capability of family) {
      // WRITE here would mean a model could act on somebody's repository. There
      // is no configuration that should produce it and no code path that could.
      expect(capability.effect, capability.id).toBe('READ');
    }
  });

  it('bounds how much one answer may bring back', () => {
    const input = getCapability('github.read_activity')!.input;
    expect(input.safeParse({ limit: 500 }).success).toBe(false);
    expect((input.parse({}) as { limit: number }).limit).toBe(10);
  });

  it('refuses a repository name that is not one', () => {
    const input = getCapability('github.read_release')!.input;
    expect(input.safeParse({ repo: 'not a repo' }).success).toBe(false);
    expect(input.safeParse({ repo: 'owner/name' }).success).toBe(true);
  });
});
