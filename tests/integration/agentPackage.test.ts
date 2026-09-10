import { describe, expect, it } from 'vitest';
import { NEVER_EXPORTED } from '@xbam/shared/contracts';
import {
  agents as agentsRepo,
  capabilityPermissions as capabilityPermissionsRepo,
  memories as memoriesRepo,
  pipelines as pipelinesRepo,
  providers as providersRepo,
  query,
} from '@xbam/database';
import {
  AGENT_PACKAGE_EXTENSION,
  MAX_PACKAGE_BYTES,
  capabilitySettings,
  checksumOf,
  inspectPackage,
  packAgent,
  packageFilename,
  serialisePackage,
  registerXCapabilities,
  setAgentAvatar,
  setCapabilityPermission,
  unpackAgent,
} from '@xbam/runtime';
import { resetCapabilitiesForTest } from '@xbam/tools';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { uniqueSuffix } from '../support/db';
import { fixtureBytes } from '../support/imageFixtures';

installHarness();

/** An agent with enough on it that a round trip has something to prove. */
/** An agent whose primary model points at a provider with a real key. */
async function anAgentWithProvider() {
  const fixture = await createFixture();
  const apiKey = `sk-travelling-${uniqueSuffix()}`;
  const label = `Carried ${uniqueSuffix()}`;
  const credential = await providersRepo.createProvider({
    ownerId: fixture.ownerId,
    provider: 'openai',
    label,
    apiKey,
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
  return { ...fixture, apiKey, label, credentialId: credential.id };
}

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
        // `credentials` is now a real field: a MOVE can be asked to carry API
        // keys. Neither of these packages was, so the guarantee is that it is
        // present and empty -- checked below rather than by its absence.
        if (banned === 'credentials' || banned === 'credential') continue;
        expect(keys, `${banned} appears as a key in a ${mode} package`).not.toContain(banned);
      }
      // The guarantee that replaced it, and the stronger one: a package nobody
      // asked to carry keys carries none, and says so.
      const pkg = parsed as { credentials: unknown[]; containsCredentials: boolean };
      expect(pkg.credentials, `a ${mode} package invented credentials`).toEqual([]);
      expect(pkg.containsCredentials).toBe(false);
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

/**
 * Carrying API keys, which is the one thing a package can do that makes the
 * file itself a secret.
 *
 * Moving your own agent to your own machine and then re-typing four keys is a
 * chore with no security benefit -- the keys were on the first machine and are
 * going to the second either way. So it is offered, and everything about it is
 * arranged so nobody does it by accident:
 *
 *   - off unless asked for, and refused outright on a SHARE package, which is
 *     the mode that is meant to be safe to hand to a stranger
 *   - declared in a field a reader sees before the credentials themselves
 *   - counted from the document by the inspection, never read from that field
 *   - named in the filename, because a folder listing is where somebody is
 *     about to attach it to an email
 */
describe('a package that carries API keys', () => {
  it('carries none unless asked', async () => {
    const fixture = await anAgentWithProvider();
    const pkg = await packAgent(fixture.agentId, 'MOVE');
    expect(pkg.credentials).toEqual([]);
    expect(pkg.containsCredentials).toBe(false);
  });

  it('carries the ones its models use when asked', async () => {
    const fixture = await anAgentWithProvider();
    const pkg = await packAgent(fixture.agentId, 'MOVE', { includeCredentials: true });
    expect(pkg.containsCredentials).toBe(true);
    expect(pkg.credentials).toHaveLength(1);
    expect(pkg.credentials[0]!.apiKey).toBe(fixture.apiKey);
    expect(pkg.credentials[0]!.label).toBe(fixture.label);
  });

  it('refuses on a SHARE package rather than silently dropping them', async () => {
    // Silently dropping would be worse than refusing: somebody who asked for
    // their keys and got a file without them finds out at the worst moment.
    const fixture = await anAgentWithProvider();
    await expect(packAgent(fixture.agentId, 'SHARE', { includeCredentials: true })).rejects.toThrow(/MOVE/);
  });

  it('says so in the filename', () => {
    expect(packageFilename('My Agent', 'MOVE', true)).toContain('SECRET');
    expect(packageFilename('My Agent', 'MOVE', false)).not.toContain('SECRET');
  });

  it('is covered by the checksum', async () => {
    // Adding credentials to what the writer hashes without adding them to what
    // the reader hashes made every keyed export report itself damaged.
    const fixture = await anAgentWithProvider();
    const pkg = await packAgent(fixture.agentId, 'MOVE', { includeCredentials: true });
    const summary = inspectPackage(JSON.stringify(pkg));
    expect(summary.checksumOk, 'a sound package reported itself damaged').toBe(true);
  });

  it('is announced before anybody imports, and counted rather than quoted', async () => {
    const fixture = await anAgentWithProvider();
    const pkg = await packAgent(fixture.agentId, 'MOVE', { includeCredentials: true });
    const summary = inspectPackage(JSON.stringify(pkg));
    expect(summary.credentials).toBe(1);
    expect(summary.notes[0], 'the warning is not first').toMatch(/API key/i);
    expect(summary.notes[0]).toMatch(/password/i);
  });

  it('does not claim the agent needs keys when it brought them', async () => {
    const fixture = await anAgentWithProvider();
    const withKeys = inspectPackage(JSON.stringify(await packAgent(fixture.agentId, 'MOVE', { includeCredentials: true })));
    expect(withKeys.notes.join(' ')).not.toMatch(/carry no credential/);

    const without = inspectPackage(JSON.stringify(await packAgent(fixture.agentId, 'MOVE')));
    expect(without.notes.join(' ')).toMatch(/carry no credential/);
  });

  it('re-seals the key on arrival rather than storing what the file held', async () => {
    // The file carries it in the clear because it has to cross machines. It
    // must not stay that way once it lands.
    const fixture = await anAgentWithProvider();
    const raw = JSON.stringify(await packAgent(fixture.agentId, 'MOVE', { includeCredentials: true }));

    // A different owner, because that is what "another machine" means here:
    // importing onto the installation that already has the provider is the
    // duplicate-label case, which has its own test below.
    const elsewhere = await createFixture();
    const result = await unpackAgent({ ownerId: elsewhere.ownerId, raw, createdBy: elsewhere.ownerId, name: 'Imported' });
    expect(result.imported.credentials).toBe(1);

    const rows = await query<{ id: string; sealed: boolean }>(
      'select id, sealed_api_key is not null as sealed from provider_credentials order by created_at desc limit 1',
    );
    expect(rows[0]!.sealed, 'the key was not sealed on arrival').toBe(true);
    await expect(providersRepo.getDecryptedApiKey(rows[0]!.id)).resolves.toBe(fixture.apiKey);
  });

  it('leaves an existing provider of the same name alone, and says so', async () => {
    // A provider label is unique per owner. Replacing somebody's working
    // credential with one out of a file is not a decision an import gets to
    // make, and failing on a database constraint is not an error anybody can
    // act on.
    const fixture = await anAgentWithProvider();
    const raw = JSON.stringify(await packAgent(fixture.agentId, 'MOVE', { includeCredentials: true }));

    const result = await unpackAgent({ ownerId: fixture.ownerId, raw, createdBy: fixture.ownerId, name: 'Second copy' });
    expect(result.imported.credentials).toBe(0);
    expect(result.skipped.join(' ')).toMatch(/already here/);
  });

  it('can be told not to bring them', async () => {
    const fixture = await anAgentWithProvider();
    const raw = JSON.stringify(await packAgent(fixture.agentId, 'MOVE', { includeCredentials: true }));
    const before = (await query<{ n: string }>('select count(*)::text as n from provider_credentials'))[0]!.n;

    const result = await unpackAgent({
      ownerId: fixture.ownerId,
      raw,
      createdBy: fixture.ownerId,
      name: 'No keys please',
      includeCredentials: false,
    });
    expect(result.imported.credentials).toBe(0);
    const after = (await query<{ n: string }>('select count(*)::text as n from provider_credentials'))[0]!.n;
    expect(after).toBe(before);
  });

  it('refuses a hand-edited package that hides its keys', async () => {
    // containsCredentials is what a reader checks first, so it is not allowed
    // to disagree with what the document holds.
    const fixture = await anAgentWithProvider();
    const pkg = await packAgent(fixture.agentId, 'MOVE', { includeCredentials: true });
    const lying = JSON.stringify({ ...pkg, containsCredentials: false });
    expect(inspectPackage(lying).valid).toBe(false);
  });
});

/**
 * An imported agent has to be an agent, not a shape.
 *
 * A package carries persona, policy, models and memories, and deliberately no
 * pipeline: the graph is stock, and shipping one would import somebody else's
 * wiring along with their character. So the stock pipeline has to be created on
 * arrival -- and was not.
 *
 * What that looked like was an agent that imported cleanly, showed its whole
 * character, its memories and its models, and then refused to start with "this
 * agent has no pipeline. Reopen the agent page, which creates one." Reopening
 * the agent page creates nothing; nothing on that path ever did. So the
 * software sent people round a loop of its own making, on the one screen where
 * they had done everything right.
 *
 * Every other way of making an agent already did this -- creating one,
 * duplicating one, the importer from AI4CZ, and the test fixtures. Import was
 * the only path that did not, which is exactly why it went unnoticed.
 */
describe('an imported agent can actually be started', () => {
  it('arrives with the stock pipeline', async () => {
    const fixture = await aFurnishedAgent();
    const raw = JSON.stringify(await packAgent(fixture.agentId, 'SHARE'));

    const result = await unpackAgent({
      ownerId: fixture.ownerId,
      raw,
      createdBy: fixture.ownerId,
      name: `Imported ${uniqueSuffix()}`,
    });

    const pipeline = await pipelinesRepo.getActivePipeline(result.agentId);
    expect(pipeline, 'an imported agent has no pipeline and cannot be started').not.toBeNull();
  });

  it('gets a pipeline that is actually usable, not merely a row', async () => {
    const fixture = await aFurnishedAgent();
    const raw = JSON.stringify(await packAgent(fixture.agentId, 'MOVE'));
    const result = await unpackAgent({
      ownerId: fixture.ownerId,
      raw,
      createdBy: fixture.ownerId,
      name: `Imported ${uniqueSuffix()}`,
    });

    const pipeline = await pipelinesRepo.getActivePipeline(result.agentId);
    // The stock graph, so the imported agent behaves like every other one.
    expect(pipeline?.nodes.length ?? 0).toBeGreaterThan(1);
    expect(pipeline?.edges.length ?? 0).toBeGreaterThan(0);
  });

  it('does not disturb the pipeline of the agent it came from', async () => {
    const fixture = await aFurnishedAgent();
    const before = await pipelinesRepo.getActivePipeline(fixture.agentId);
    const raw = JSON.stringify(await packAgent(fixture.agentId, 'SHARE'));
    await unpackAgent({
      ownerId: fixture.ownerId,
      raw,
      createdBy: fixture.ownerId,
      name: `Imported ${uniqueSuffix()}`,
    });
    const after = await pipelinesRepo.getActivePipeline(fixture.agentId);
    expect(after?.version).toBe(before?.version);
  });
});

/**
 * What an owner decided about Toolspace, travelling with the agent.
 *
 * It did not. `PortableAgent` has carried `capabilities` since before Toolspace
 * existed and that field means *channel* capabilities -- REPLY, POST, LIKE,
 * REPOST, what an agent may do through an account. There was no field for the
 * registry at all, so exporting an agent and importing it dropped every
 * capability decision its owner had made. Reads default to allowed so they came
 * back by themselves; writes default to disabled, so an agent that could like
 * and repost quietly could not, and nothing said why.
 */
describe('the capabilities an agent may reach for', () => {
  it('travels, with what it was set up with', async () => {
    const fixture = await aFurnishedAgent();
    resetCapabilitiesForTest();
    registerXCapabilities();

    await setCapabilityPermission({ agentId: fixture.agentId, capabilityId: 'x.like', permission: 'ALLOWED' });
    await capabilityPermissionsRepo.setConfig({
      agentId: fixture.agentId,
      capabilityId: 'x.search',
      permission: 'OWNER_APPROVAL',
      config: { maxResults: 5 },
    });

    const pkg = await packAgent(fixture.agentId, 'SHARE');
    const carried = new Map(pkg.agent.toolspace.map((c) => [c.id, c]));
    expect(carried.get('x.like')?.permission).toBe('ALLOWED');
    expect(carried.get('x.search')?.permission).toBe('OWNER_APPROVAL');
    expect(carried.get('x.search')?.config).toEqual({ maxResults: 5 });

    const imported = await unpackAgent({
      ownerId: fixture.ownerId,
      raw: serialisePackage(pkg),
      createdBy: fixture.ownerId,
      name: `Copy ${uniqueSuffix()}`,
    });
    const settings = await capabilitySettings(imported.agentId);
    expect(settings.permissions.get('x.like')).toBe('ALLOWED');
    expect(settings.permissions.get('x.search')).toBe('OWNER_APPROVAL');
    expect(settings.configs.get('x.search')).toEqual({ maxResults: 5 });
  });

  it('says so rather than inventing a capability this installation lacks', async () => {
    // The registry is process-wide and in memory. A decision about something
    // that is not registered here is worth reporting and not worth storing.
    const fixture = await aFurnishedAgent();
    resetCapabilitiesForTest();
    registerXCapabilities();
    await setCapabilityPermission({ agentId: fixture.agentId, capabilityId: 'x.like', permission: 'ALLOWED' });

    const pkg = await packAgent(fixture.agentId, 'SHARE');
    pkg.agent.toolspace.push({ id: 'moon.read_craters', permission: 'ALLOWED', config: {} });
    const raw = serialisePackage({
      ...pkg,
      checksum: checksumOf({ agent: pkg.agent, avatar: pkg.avatar, learned: pkg.learned, credentials: pkg.credentials }),
    });

    const report = await unpackAgent({ ownerId: fixture.ownerId, raw, createdBy: fixture.ownerId, name: `Copy ${uniqueSuffix()}` });
    // `skipped` is where an import says what it could not carry.
    expect(report.skipped.join(' ')).toMatch(/moon\.read_craters/);
    // The one that does exist is unaffected by the one that does not.
    expect((await capabilitySettings(report.agentId)).permissions.get('x.like')).toBe('ALLOWED');
  });

  it('strips anything key-shaped out of the settings, the way a tool’s are', async () => {
    const fixture = await aFurnishedAgent();
    resetCapabilitiesForTest();
    registerXCapabilities();
    await capabilityPermissionsRepo.setConfig({
      agentId: fixture.agentId,
      capabilityId: 'x.search',
      permission: 'ALLOWED',
      config: { maxResults: 5, apiKey: 'sk-should-never-travel' },
    });

    const pkg = await packAgent(fixture.agentId, 'SHARE');
    const carried = pkg.agent.toolspace.find((c) => c.id === 'x.search');
    expect(carried?.config).toEqual({ maxResults: 5 });
    expect(JSON.stringify(pkg)).not.toContain('sk-should-never-travel');
  });

  it('counts them where somebody inspecting before importing will see them', async () => {
    const fixture = await aFurnishedAgent();
    resetCapabilitiesForTest();
    registerXCapabilities();
    await setCapabilityPermission({ agentId: fixture.agentId, capabilityId: 'x.like', permission: 'ALLOWED' });

    const summary = inspectPackage(serialisePackage(await packAgent(fixture.agentId, 'SHARE')));
    expect(summary.valid).toBe(true);
    expect(summary.counts.toolspace).toBeGreaterThan(0);
    expect(summary.notes.join(' ')).toMatch(/switched on/i);
  });
});

/**
 * A file from a newer build, and the sentence somebody needs to read.
 *
 * The version gate existed and could never fire for the only change that
 * produces it: the schemas are strict, so an unknown field failed the parse
 * first and the owner was told "Unrecognized key" about a file that is
 * perfectly good and one upgrade away from readable.
 */
describe('a package written by a newer AI17Z', () => {
  it('says to update rather than that the file is broken', async () => {
    const fixture = await aFurnishedAgent();
    const pkg = await packAgent(fixture.agentId, 'SHARE');
    const fromTheFuture = {
      ...pkg,
      agent: { ...pkg.agent, version: 99, somethingThisBuildHasNoPlaceFor: true },
    };

    const summary = inspectPackage(JSON.stringify(fromTheFuture));
    expect(summary.valid).toBe(false);
    expect(summary.problem).toMatch(/newer AI17Z/i);
    expect(summary.problem).toMatch(/Update before reading it/i);
  });
});

/**
 * What the document import could not carry, reaching whoever imported it.
 *
 * `skipped` says "what could not be, and why. Never silent." Unpacking a
 * package took the agent id off `importAgent`'s result and threw the rest away,
 * so a package naming a tool this installation does not have imported quietly
 * and said nothing about it.
 */
describe('a package that names something this installation has not got', () => {
  it('says so, rather than importing quietly', async () => {
    const fixture = await aFurnishedAgent();
    const pkg = await packAgent(fixture.agentId, 'SHARE');
    pkg.agent.tools.push({ key: 'not.a.real.tool', enabled: true, config: {} });
    const raw = serialisePackage({
      ...pkg,
      checksum: checksumOf({ agent: pkg.agent, avatar: pkg.avatar, learned: pkg.learned, credentials: pkg.credentials }),
    });

    const report = await unpackAgent({ ownerId: fixture.ownerId, raw, createdBy: fixture.ownerId, name: `Copy ${uniqueSuffix()}` });
    expect(report.skipped.join(' ')).toMatch(/not\.a\.real\.tool/);
  });
});
