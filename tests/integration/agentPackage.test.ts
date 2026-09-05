import { describe, expect, it } from 'vitest';
import { NEVER_EXPORTED } from '@xbam/shared/contracts';
import { agents as agentsRepo, memories as memoriesRepo, providers as providersRepo, query } from '@xbam/database';
import {
  AGENT_PACKAGE_EXTENSION,
  MAX_PACKAGE_BYTES,
  checksumOf,
  inspectPackage,
  packAgent,
  packageFilename,
  serialisePackage,
  setAgentAvatar,
  unpackAgent,
} from '@xbam/runtime';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { uniqueSuffix } from '../support/db';
import { fixtureBytes } from '../support/imageFixtures';

installHarness();

/** An agent with enough on it that a round trip has something to prove. */
async function aFurnishedAgent() {
  const fixture = await createFixture();
  const current = await agentsRepo.getActivePersona(fixture.agentId);
  await agentsRepo.savePersonaVersion(
    fixture.agentId,
    {
      ...current,
      displayName: 'Packed',
      biography: 'Writes short, dry replies about infrastructure.',
      styleExamples: ['it works, mostly', 'that is a load bearing hack'],
      topics: ['infrastructure', 'databases'],
    } as never,
    fixture.ownerId,
  );
  await providersRepo.setModelConfig({
    agentId: fixture.agentId,
    role: 'primary',
    providerCredentialId: fixture.providerId,
    model: 'mock-echo',
    parameters: {},
  });
  await memoriesRepo.writeMemory({
    agentId: fixture.agentId,
    scope: 'PERSONA',
    memoryType: 'FACT',
    content: `The deploy window is Tuesday. ${uniqueSuffix()}`,
    summary: 'Deploy window',
    importance: 0.8,
  });
  return fixture;
}

describe('writing a package', () => {
  it('says what it is, so anything that opens it knows', async () => {
    const fixture = await aFurnishedAgent();
    const pkg = await packAgent(fixture.agentId, 'SHARE');
    expect(pkg.format).toBe('ai17z-agent');
    expect(pkg.version).toBe(1);
    expect(pkg.mode).toBe('SHARE');
  });

  it('names the version that wrote it and nothing about the machine', async () => {
    // A package is something people send each other. A stable sender id would
    // turn every shared agent into a way of learning who made it.
    const fixture = await aFurnishedAgent();
    const text = serialisePackage(await packAgent(fixture.agentId, 'SHARE'));
    expect(text).not.toContain(fixture.ownerId);
    expect(text).not.toContain(fixture.ownerEmail);
    expect(text).not.toContain(fixture.agentId);
  });

  it('offers a filename that says which mode it is', () => {
    expect(packageFilename('My Agent', 'SHARE')).toBe(`my-agent${AGENT_PACKAGE_EXTENSION}`);
    expect(packageFilename('My Agent', 'MOVE')).toBe(`my-agent-move${AGENT_PACKAGE_EXTENSION}`);
    // A name made entirely of punctuation still has to produce a filename.
    expect(packageFilename('!!!', 'SHARE')).toBe(`agent${AGENT_PACKAGE_EXTENSION}`);
  });

  it('carries no memories in a SHARE package', async () => {
    const fixture = await aFurnishedAgent();
    const pkg = await packAgent(fixture.agentId, 'SHARE');
    expect(pkg.learned).toBeNull();
    expect(serialisePackage(pkg)).not.toContain('The deploy window is Tuesday');
  });

  it('carries them in a MOVE package', async () => {
    const fixture = await aFurnishedAgent();
    const pkg = await packAgent(fixture.agentId, 'MOVE');
    expect(pkg.learned!.memories.length).toBeGreaterThan(0);
  });
});

/**
 * The rule the whole format exists to keep: a package has nowhere to put a
 * secret. Not "we remember to strip them" -- there is no field.
 */
describe('what a package can never contain', () => {
  it('has no key-shaped field anywhere in it, in either mode', async () => {
    const fixture = await aFurnishedAgent();
    for (const mode of ['SHARE', 'MOVE'] as const) {
      const text = serialisePackage(await packAgent(fixture.agentId, mode));
      const parsed = JSON.parse(text) as unknown;
      const keys: string[] = [];
      const walk = (value: unknown) => {
        if (Array.isArray(value)) return value.forEach(walk);
        if (value && typeof value === 'object') {
          for (const [k, v] of Object.entries(value)) {
            keys.push(k);
            walk(v);
          }
        }
      };
      walk(parsed);
      for (const banned of NEVER_EXPORTED) {
        expect(keys, `${banned} appears as a key in a ${mode} package`).not.toContain(banned);
      }
    }
  });

  it('does not carry the provider key the agent is configured with', async () => {
    const fixture = await createFixture();
    const marker = `sk-must-not-travel-${uniqueSuffix()}`;
    const credential = await providersRepo.createProvider({
      ownerId: fixture.ownerId,
      provider: 'openai',
      label: 'Secret',
      apiKey: marker,
      availableModels: ['gpt-4o'],
      defaultModel: 'gpt-4o',
    });
    await providersRepo.setModelConfig({
      agentId: fixture.agentId,
      role: 'primary',
      providerCredentialId: credential.id,
      model: 'gpt-4o',
      parameters: {},
    });

    const text = serialisePackage(await packAgent(fixture.agentId, 'MOVE'));
    expect(text).not.toContain(marker);
    // Not even the id of the credential, which would let an import point at
    // somebody else's key on a shared installation.
    expect(text).not.toContain(credential.id);
    // The provider is named, so an importer can say what it needs.
    expect(text).toContain('openai');
  });

  it('has no field an importer could execute or write to a chosen path', async () => {
    const fixture = await aFurnishedAgent();
    const text = serialisePackage(await packAgent(fixture.agentId, 'MOVE')).toLowerCase();
    for (const dangerous of ['"script"', '"command"', '"exec"', '"entrypoint"', '"postinstall"', '"filepath"']) {
      expect(text, `${dangerous} is present`).not.toContain(dangerous);
    }
  });
});

describe('looking inside before importing', () => {
  it('counts what is really there rather than what the file claims', async () => {
    const fixture = await aFurnishedAgent();
    const pkg = await packAgent(fixture.agentId, 'MOVE');
    // A package that described itself as harmless is exactly the one worth
    // checking, so the summary is built from the parsed document.
    const lying = { ...pkg, agent: { ...pkg.agent, name: 'Innocent' } };
    const summary = inspectPackage(JSON.stringify(lying));
    expect(summary.counts.memories).toBe(pkg.learned!.memories.length);
  });

  it('reports a file that is not a package, without throwing', () => {
    for (const junk of ['', 'not json at all', '{}', '[]', '{"format":"something-else"}']) {
      const summary = inspectPackage(junk);
      expect(summary.valid).toBe(false);
      expect(summary.problem).toBeTruthy();
    }
  });

  it('refuses an unknown field rather than letting it ride along', async () => {
    const fixture = await aFurnishedAgent();
    const pkg = await packAgent(fixture.agentId, 'SHARE');
    const tampered = JSON.stringify({ ...pkg, somethingExtra: { run: 'rm -rf /' } });
    expect(inspectPackage(tampered).valid).toBe(false);
  });

  it('notices a checksum that does not match', async () => {
    const fixture = await aFurnishedAgent();
    const pkg = await packAgent(fixture.agentId, 'SHARE');
    const edited = { ...pkg, agent: { ...pkg.agent, name: 'Edited By Hand' } };
    const summary = inspectPackage(JSON.stringify(edited));
    expect(summary.valid).toBe(true);
    expect(summary.checksumOk).toBe(false);
    expect(summary.notes.join(' ')).toMatch(/damaged or was edited/i);
  });

  it('warns that a move package carries learned material', async () => {
    const fixture = await aFurnishedAgent();
    const summary = inspectPackage(serialisePackage(await packAgent(fixture.agentId, 'MOVE')));
    expect(summary.notes.join(' ')).toMatch(/only if it is your own agent/i);
  });

  it('says a model role brings no credential with it', async () => {
    const fixture = await aFurnishedAgent();
    const summary = inspectPackage(serialisePackage(await packAgent(fixture.agentId, 'SHARE')));
    expect(summary.notes.join(' ')).toMatch(/no credential/i);
  });

  it('refuses a file too large to be an agent', () => {
    const huge = `{"padding":"${'x'.repeat(MAX_PACKAGE_BYTES + 10)}"}`;
    expect(inspectPackage(huge).problem).toMatch(/larger than/i);
  });
});

describe('reading one back', () => {
  it('creates a new agent rather than touching the one it came from', async () => {
    const fixture = await aFurnishedAgent();
    const text = serialisePackage(await packAgent(fixture.agentId, 'SHARE'));

    const result = await unpackAgent({ ownerId: fixture.ownerId, raw: text, createdBy: fixture.ownerId });

    expect(result.agentId).not.toBe(fixture.agentId);
    // The original is untouched, which is what stops a shared file overwriting
    // somebody's work.
    expect(await agentsRepo.getAgent(fixture.agentId)).not.toBeNull();
  });

  it('brings the persona across', async () => {
    const fixture = await aFurnishedAgent();
    const text = serialisePackage(await packAgent(fixture.agentId, 'SHARE'));
    const { agentId } = await unpackAgent({ ownerId: fixture.ownerId, raw: text, createdBy: fixture.ownerId });

    const persona = await agentsRepo.getActivePersona(agentId);
    expect(persona!.biography).toContain('short, dry replies');
    expect(persona!.styleExamples).toContain('that is a load bearing hack');
  });

  it('brings memories across for a MOVE, and not for a SHARE', async () => {
    const fixture = await aFurnishedAgent();

    const share = await unpackAgent({
      ownerId: fixture.ownerId,
      raw: serialisePackage(await packAgent(fixture.agentId, 'SHARE')),
      createdBy: fixture.ownerId,
    });
    expect(share.imported.memories).toBe(0);

    const move = await unpackAgent({
      ownerId: fixture.ownerId,
      raw: serialisePackage(await packAgent(fixture.agentId, 'MOVE')),
      createdBy: fixture.ownerId,
    });
    expect(move.imported.memories).toBeGreaterThan(0);

    const [count] = await query<{ n: number }>('SELECT count(*)::int AS n FROM memories WHERE agent_id = $1', [
      move.agentId,
    ]);
    expect(count!.n).toBe(move.imported.memories);
  });

  it('refuses a package whose checksum does not match its contents', async () => {
    // Half an agent imported silently is the outcome the checksum exists to
    // prevent, so this refuses rather than warns.
    const fixture = await aFurnishedAgent();
    const pkg = await packAgent(fixture.agentId, 'SHARE');
    const edited = JSON.stringify({ ...pkg, agent: { ...pkg.agent, name: 'Edited' } });

    await expect(
      unpackAgent({ ownerId: fixture.ownerId, raw: edited, createdBy: fixture.ownerId }),
    ).rejects.toThrow(/does not match its own checksum/i);
  });

  it('refuses a file that is not a package at all', async () => {
    const fixture = await createFixture();
    await expect(
      unpackAgent({ ownerId: fixture.ownerId, raw: '{"hello":"world"}', createdBy: fixture.ownerId }),
    ).rejects.toThrow();
  });
});

describe('the picture travels with it', () => {
  it('comes out and goes back in', async () => {
    const fixture = await aFurnishedAgent();
    await setAgentAvatar(fixture.agentId, fixtureBytes('png'));

    const pkg = await packAgent(fixture.agentId, 'SHARE');
    expect(pkg.avatar).toMatchObject({ mime: 'image/png' });

    const { agentId, imported } = await unpackAgent({
      ownerId: fixture.ownerId,
      raw: serialisePackage(pkg),
      createdBy: fixture.ownerId,
    });
    expect(imported.avatar).toBe(true);
    // A fresh artifact of its own, not a reference to the original's.
    const avatarUrl = (await agentsRepo.getAgent(agentId))!.avatarUrl;
    expect(avatarUrl).toMatch(/^\/api\/artifacts\//);
    expect(avatarUrl).not.toBe((await agentsRepo.getAgent(fixture.agentId))!.avatarUrl);
  });

  it('refuses a picture that is not one, and imports the agent anyway', async () => {
    // A hostile package should not be able to stop an import; it should be
    // unable to land the payload, and say so.
    const fixture = await aFurnishedAgent();
    const pkg = await packAgent(fixture.agentId, 'SHARE');
    const withSvg = {
      ...pkg,
      avatar: { mime: 'image/png' as const, base64: Buffer.from('<svg><script>alert(1)</script></svg>').toString('base64') },
    };
    const repaired = { ...withSvg, checksum: checksumOf({ agent: withSvg.agent, avatar: withSvg.avatar, learned: withSvg.learned }) };

    const result = await unpackAgent({
      ownerId: fixture.ownerId,
      raw: JSON.stringify(repaired),
      createdBy: fixture.ownerId,
    });

    expect(result.agentId).toBeTruthy();
    expect(result.imported.avatar).toBe(false);
    expect(result.skipped.join(' ')).toMatch(/picture was not imported/i);
  });
});

/**
 * The property that makes this worth having at all: an agent written on one
 * installation reads correctly on another. Simulated with two owners, which is
 * the part that actually differs -- nothing in a package is installation-bound.
 */
describe('across installations', () => {
  it('imports under a different owner without carrying the first one', async () => {
    const source = await aFurnishedAgent();
    const destination = await createFixture();

    const text = serialisePackage(await packAgent(source.agentId, 'MOVE'));
    const { agentId } = await unpackAgent({
      ownerId: destination.ownerId,
      raw: text,
      createdBy: destination.ownerId,
    });

    const imported = await agentsRepo.getAgent(agentId);
    expect(imported!.ownerId).toBe(destination.ownerId);
    expect(imported!.ownerId).not.toBe(source.ownerId);
  });

  it('survives a round trip unchanged, so exporting a copy matches the original', async () => {
    const source = await aFurnishedAgent();
    const first = await packAgent(source.agentId, 'SHARE');

    const { agentId } = await unpackAgent({
      ownerId: source.ownerId,
      raw: serialisePackage(first),
      createdBy: source.ownerId,
    });
    const second = await packAgent(agentId, 'SHARE');

    // The document, not the envelope: exportedAt and the name differ by design.
    expect(second.agent.persona).toEqual(first.agent.persona);
    expect(second.agent.policy).toEqual(first.agent.policy);
    expect(second.agent.models).toEqual(first.agent.models);
  });

  it('renames on import when asked, without changing anything else', async () => {
    const source = await aFurnishedAgent();
    const text = serialisePackage(await packAgent(source.agentId, 'SHARE'));
    const { agentId } = await unpackAgent({
      ownerId: source.ownerId,
      raw: text,
      name: 'A Different Name',
      createdBy: source.ownerId,
    });

    expect((await agentsRepo.getAgent(agentId))!.name).toBe('A Different Name');
    expect((await agentsRepo.getActivePersona(agentId))!.biography).toContain('short, dry replies');
  });
});
