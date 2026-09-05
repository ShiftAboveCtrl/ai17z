import { readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agents as agentsRepo, ops } from '@xbam/database';
import {
  MAX_AVATAR_BYTES,
  MAX_AVATAR_EDGE,
  MIN_AVATAR_EDGE,
  clearAgentAvatar,
  currentArtifactId,
  setAgentAvatar,
  storageDir,
} from '@xbam/runtime';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { uniqueSuffix } from '../support/db';
import { fixtureBytes, pngClaiming } from '../support/imageFixtures';

installHarness();

async function anAgent(): Promise<string> {
  return (await createFixture()).agentId;
}

describe('giving an agent a face', () => {
  it('stores the file and points the agent at it', async () => {
    const agentId = await anAgent();
    const result = await setAgentAvatar(agentId, fixtureBytes('png'));

    expect(result).toMatchObject({ mime: 'image/png', width: 96, height: 72 });
    const agent = await agentsRepo.getAgent(agentId);
    expect(agent!.avatarUrl).toBe(`/api/artifacts/${result.artifactId}`);
  });

  it('writes the bytes that were sent, under the storage root', async () => {
    const agentId = await anAgent();
    const sent = fixtureBytes('png');
    const result = await setAgentAvatar(agentId, sent);

    const artifact = await ops.getArtifact(result.artifactId);
    // Relative in the row, never an absolute host path -- a stored absolute
    // path is what makes a database non-portable between machines.
    expect(artifact!.relPath.startsWith('/')).toBe(false);
    expect(artifact!.relPath).toContain('portraits');

    const onDisk = readFileSync(resolve(storageDir(), artifact!.relPath));
    expect(Buffer.compare(onDisk, sent)).toBe(0);
  });

  it('records the type it worked out, not one it was told', async () => {
    const agentId = await anAgent();
    // JPEG bytes. Nothing in this call says so.
    const result = await setAgentAvatar(agentId, fixtureBytes('jpeg'));
    const artifact = await ops.getArtifact(result.artifactId);
    expect(artifact!.mimeType).toBe('image/jpeg');
    expect(artifact!.relPath.endsWith('.jpg')).toBe(true);
  });

  it('takes each of the four formats', async () => {
    for (const [name, mime] of [
      ['png', 'image/png'],
      ['jpeg', 'image/jpeg'],
      ['gif', 'image/gif'],
      ['webp', 'image/webp'],
    ] as const) {
      const agentId = await anAgent();
      expect((await setAgentAvatar(agentId, fixtureBytes(name))).mime, name).toBe(mime);
    }
  });
});

describe('replacing one', () => {
  it('leaves exactly one picture behind', async () => {
    const agentId = await anAgent();
    const first = await setAgentAvatar(agentId, fixtureBytes('png'));
    const second = await setAgentAvatar(agentId, fixtureBytes('jpeg'));

    expect(second.artifactId).not.toBe(first.artifactId);
    // The old row is gone, and so is the file it pointed at. A replaced
    // portrait nobody can reach is just disk somebody paid for.
    expect(await ops.getArtifact(first.artifactId)).toBeNull();
    expect(await ops.getArtifact(second.artifactId)).not.toBeNull();
    expect((await agentsRepo.getAgent(agentId))!.avatarUrl).toBe(`/api/artifacts/${second.artifactId}`);
  });

  it('gives the new file its own name', async () => {
    // Overwriting one path would leave every cached copy of the old picture
    // claiming to be the new one.
    const agentId = await anAgent();
    const first = await ops.getArtifact((await setAgentAvatar(agentId, fixtureBytes('png'))).artifactId);
    const second = await ops.getArtifact((await setAgentAvatar(agentId, fixtureBytes('png'))).artifactId);
    expect(first!.relPath).not.toBe(second!.relPath);
  });

  it('does not delete anything when the old avatar was somebody else’s URL', async () => {
    const agentId = await anAgent();
    await agentsRepo.updateAgent(agentId, { avatarUrl: 'https://example.test/face.png' });
    // Nothing to delete, and nothing that could be mistaken for something to
    // delete. This must not throw.
    const result = await setAgentAvatar(agentId, fixtureBytes('png'));
    expect(result.artifactId).toBeTruthy();
  });
});

describe('removing one', () => {
  it('takes the row, the file and the reference', async () => {
    const agentId = await anAgent();
    const result = await setAgentAvatar(agentId, fixtureBytes('png'));
    const artifact = await ops.getArtifact(result.artifactId);
    const path = resolve(storageDir(), artifact!.relPath);

    await clearAgentAvatar(agentId);

    expect((await agentsRepo.getAgent(agentId))!.avatarUrl).toBeNull();
    expect(await ops.getArtifact(result.artifactId)).toBeNull();
    expect(await stat(path).catch(() => null)).toBeNull();
  });

  it('is allowed when there was never one', async () => {
    // An agent with no picture is a supported state, not a gap. Making
    // somebody choose a replacement in order to remove one is how a bad
    // picture stays.
    const agentId = await anAgent();
    await expect(clearAgentAvatar(agentId)).resolves.toBeUndefined();
  });
});

describe('what it refuses, and what it says', () => {
  const agentId = () => anAgent();

  it('refuses an empty file', async () => {
    await expect(setAgentAvatar(await agentId(), Buffer.alloc(0))).rejects.toThrow(/empty/i);
  });

  it('refuses an SVG, and says why', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    await expect(setAgentAvatar(await agentId(), svg)).rejects.toThrow(/SVG is not accepted/i);
  });

  it('refuses something that is not an image at all', async () => {
    await expect(setAgentAvatar(await agentId(), Buffer.from('%PDF-1.7'))).rejects.toThrow(/PNG, JPEG, GIF or WebP/);
  });

  it('refuses one too small to look like anything', async () => {
    const error = await setAgentAvatar(await agentId(), fixtureBytes('png_tiny')).catch((e: Error) => e);
    // Says the size it got and the size it needs, not "invalid image".
    expect(String(error)).toMatch(/16x16/);
    expect(String(error)).toContain(String(MIN_AVATAR_EDGE));
  });

  it('refuses one whose header claims a size nothing could display', async () => {
    // A few hundred bytes on disk declaring 60000 x 60000. The cap has to read
    // the header, because the file size says nothing about this.
    const error = await setAgentAvatar(await agentId(), pngClaiming(60000, 60000)).catch((e: Error) => e);
    expect(String(error)).toMatch(/60000x60000/);
    expect(String(error)).toContain(String(MAX_AVATAR_EDGE));
  });

  it('refuses one that is simply too many bytes', async () => {
    // Valid header, absurd payload.
    const huge = Buffer.concat([fixtureBytes('png'), Buffer.alloc(MAX_AVATAR_BYTES + 1)]);
    const error = await setAgentAvatar(await agentId(), huge).catch((e: Error) => e);
    expect(String(error)).toMatch(/limit is 5MB/i);
  });

  it('writes nothing when it refuses', async () => {
    const id = await agentId();
    await setAgentAvatar(id, Buffer.from('not an image')).catch(() => undefined);
    expect((await agentsRepo.getAgent(id))!.avatarUrl).toBeNull();
  });

  it('keeps the old picture when a new one is refused', async () => {
    // The failure that would hurt most: losing the face you had because the
    // replacement was wrong.
    const id = await anAgent();
    const good = await setAgentAvatar(id, fixtureBytes('png'));
    await setAgentAvatar(id, Buffer.from('not an image')).catch(() => undefined);

    expect((await agentsRepo.getAgent(id))!.avatarUrl).toBe(`/api/artifacts/${good.artifactId}`);
    expect(await ops.getArtifact(good.artifactId)).not.toBeNull();
  });
});

describe('reading an avatar url', () => {
  it('recognises one AI17Z stored', () => {
    expect(currentArtifactId('/api/artifacts/2b1c9f4e-0000-4000-8000-000000000001')).toBe(
      '2b1c9f4e-0000-4000-8000-000000000001',
    );
  });

  it('does not claim somebody else’s URL', () => {
    for (const url of [
      'https://example.test/face.png',
      'https://example.test/api/artifacts/2b1c9f4e-0000-4000-8000-000000000001',
      '/api/artifacts/../../etc/passwd',
      '/api/artifacts/not-a-uuid',
      null,
      '',
    ]) {
      expect(currentArtifactId(url), String(url)).toBeNull();
    }
  });
});

/**
 * The boundary, stated as a test because it is the one that cannot be walked
 * back once it is crossed.
 *
 * Changing the picture on an AI17Z agent must never change the profile picture
 * of the real, public X account it posts from. They are two different things
 * that happen to both be pictures: one is how an agent looks in a local admin
 * screen, the other is a public identity a person should decide to change.
 */
describe('it never touches the X account', () => {
  const source = readFileSync(resolve(__dirname, '../../packages/runtime/src/avatar.ts'), 'utf8');

  it('imports nothing that can reach a channel', () => {
    expect(source).not.toMatch(/@xbam\/channels/);
    expect(source).not.toMatch(/@xbam\/browser/);
  });

  it('has no path that could update a remote profile', () => {
    for (const forbidden of ['updateProfile', 'setProfileImage', 'uploadProfile', 'browser_tasks', 'browserTasks']) {
      expect(source, `${forbidden} appears in the avatar code`).not.toContain(forbidden);
    }
  });

  it('leaves the connected account exactly as it was', async () => {
    const fixture = await createFixture();
    const { accounts } = await import('@xbam/database');
    const account = await accounts.createAccount({
      ownerId: fixture.ownerId,
      channel: 'x',
      handle: `av${uniqueSuffix()}`.slice(0, 15),
      displayName: 'Connected',
    });
    await accounts.linkAgentAccount({ agentId: fixture.agentId, accountId: account.id, actionType: 'REPLY' });
    const before = await accounts.getAccount(account.id);
    expect(before).not.toBeNull();

    await setAgentAvatar(fixture.agentId, fixtureBytes('png'));
    await clearAgentAvatar(fixture.agentId);

    // Every column, not a chosen field. A picture pushed to X would show up
    // somewhere in here, and picking which columns to compare is how it would
    // not.
    expect(await accounts.getAccount(account.id)).toEqual(before);
  });

  it('queues no browser work', async () => {
    // The API records browser intent in a table the worker reads. Nothing here
    // may put anything in it: that is the only route from this code to a real
    // Chrome, so an empty table is the proof.
    const fixture = await createFixture();
    const { query } = await import('@xbam/database');
    const [before] = await query<{ n: number }>('SELECT count(*)::int AS n FROM browser_tasks');

    await setAgentAvatar(fixture.agentId, fixtureBytes('png'));

    const [after] = await query<{ n: number }>('SELECT count(*)::int AS n FROM browser_tasks');
    expect(after!.n).toBe(before!.n);
  });
});
