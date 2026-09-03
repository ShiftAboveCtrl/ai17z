import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectDocuments, isInside, looksLikeSecret, refusalReason, DOCUMENT_EXTENSIONS } from '@xbam/memory';

const repoRoot = resolve(__dirname, '../..');

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ai17z-knowledge-'));
  await writeFile(join(root, 'README.md'), '# Guide\n\nHow to install this on Windows and Ubuntu alike.');
  await writeFile(join(root, 'notes.txt'), 'Some plain notes worth keeping around.');
  // The accident this whole module exists to prevent.
  await writeFile(join(root, '.env'), 'AI17Z_MASTER_KEY=aVeryRealLookingSecretValue123456789\n');
  await writeFile(join(root, 'server.pem'), '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----');
  await writeFile(join(root, 'logo.png'), 'not really a png');
  await writeFile(join(root, 'main.ts'), 'export const x = 1;');
  await mkdir(join(root, 'docs'));
  await writeFile(join(root, 'docs', 'install.md'), '# Install\n\nRun the installer.');
  await mkdir(join(root, 'node_modules'));
  await writeFile(join(root, 'node_modules', 'readme.md'), '# Some dependency');
  await mkdir(join(root, '.git'));
  await writeFile(join(root, '.git', 'config.md'), '# Not this either');
  return root;
}

describe('choosing what an agent may be taught from', () => {
  it('reads the documents and nothing else', async () => {
    const { files } = await collectDocuments(await fixture());
    expect(files.map((f) => f.path)).toEqual(['README.md', 'docs/install.md', 'notes.txt']);
  });

  it('never reads a .env, which is the realistic accident', async () => {
    // Pointing a source at a project folder is the first thing anybody will do,
    // and this repository's own root contains a .env holding a master key. An
    // indexed secret is one the agent will repeat when somebody asks.
    const { files, refused } = await collectDocuments(await fixture());
    expect(files.some((f) => f.path.includes('.env'))).toBe(false);
    expect(refused.some((r) => r.path === '.env')).toBe(true);
  });

  it('excludes secrets by construction rather than by remembering to deny them', () => {
    // The include-list is the mechanism: a secret is refused because it is not
    // a document, which stays true for file types nobody has thought of.
    expect(refusalReason('.env', DOCUMENT_EXTENSIONS)).toBeTruthy();
    expect(refusalReason('id_rsa', DOCUMENT_EXTENSIONS)).toBeTruthy();
    expect(refusalReason('server.pem', DOCUMENT_EXTENSIONS)).toBeTruthy();
    expect(refusalReason('anything.sqlite', DOCUMENT_EXTENSIONS)).toBeTruthy();
    expect(refusalReason('README.md', DOCUMENT_EXTENSIONS)).toBeNull();
  });

  it('refuses a document-shaped file that still looks like credentials', () => {
    expect(refusalReason('credentials', DOCUMENT_EXTENSIONS)).toBeTruthy();
    expect(refusalReason('.npmrc', DOCUMENT_EXTENSIONS)).toBeTruthy();
  });

  it('does not walk node_modules or .git', async () => {
    const { files } = await collectDocuments(await fixture());
    expect(files.every((f) => !f.path.includes('node_modules'))).toBe(true);
    expect(files.every((f) => !f.path.startsWith('.git'))).toBe(true);
  });

  it('reports what it skipped, because that is how a wrong folder is noticed', async () => {
    const { refused } = await collectDocuments(await fixture());
    // Source code and secrets are reported; a .png is not, because nobody
    // expected a .png to be read.
    expect(refused.map((r) => r.path)).toContain('main.ts');
    expect(refused.map((r) => r.path)).not.toContain('logo.png');
  });

  it('refuses a link that leads out of the source folder', async () => {
    const root = await fixture();
    const outside = await mkdtemp(join(tmpdir(), 'ai17z-outside-'));
    await writeFile(join(outside, 'private.md'), '# Somebody else\'s notes');
    try {
      await symlink(join(outside, 'private.md'), join(root, 'sneaky.md'));
    } catch {
      return; // Windows without developer mode: no symlink, nothing to prove.
    }
    const { files, refused } = await collectDocuments(root);
    expect(files.some((f) => f.path === 'sneaky.md')).toBe(false);
    expect(refused.some((r) => r.path === 'sneaky.md')).toBe(true);
  });

  it('confines a source to the roots the installation allows', async () => {
    const root = await fixture();
    await expect(collectDocuments(root, { allowedRoots: [repoRoot] })).rejects.toThrow(/outside every folder/);
    await expect(collectDocuments(root, { allowedRoots: [root] })).resolves.toBeTruthy();
  });

  it('resolves traversal before deciding, so the check is about where a path leads', () => {
    expect(isInside('/srv/docs', '/srv/docs/guide')).toBe(true);
    expect(isInside('/srv/docs', '/srv/docs/../../etc')).toBe(false);
    expect(isInside('/srv/docs', '/srv/docs-other')).toBe(false);
    expect(isInside('/srv/docs', '/srv/docs')).toBe(true);
  });

  it('records a modification time per file, for the revision stamp', async () => {
    const { files, newestModifiedAt } = await collectDocuments(await fixture());
    expect(newestModifiedAt).toBeTruthy();
    for (const file of files) expect(Date.parse(file.modifiedAt)).not.toBeNaN();
  });
});

describe('secrets written inside a document that was allowed', () => {
  it('spots the shapes that matter', () => {
    expect(looksLikeSecret('-----BEGIN RSA PRIVATE KEY-----')).toBe('a private key');
    expect(looksLikeSecret('AI17Z_MASTER_KEY=Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5')).toBe('a master key');
    expect(looksLikeSecret('use sk-abcdefghijklmnopqrstuvwxyz12')).toBe('an API key');
    expect(looksLikeSecret('password = hunter2hunter2hunter2')).toBe('a credential');
  });

  it('leaves ordinary prose alone', () => {
    for (const text of [
      'Set AI17Z_MASTER_KEY in your .env before starting.',
      'The password field is required.',
      'Run npm run setup to generate a key.',
      'Installing on Ubuntu takes about a minute.',
    ]) {
      expect(looksLikeSecret(text)).toBeNull();
    }
  });
});
