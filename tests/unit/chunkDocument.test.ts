import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chunkDocument } from '@xbam/memory';

const root = resolve(__dirname, '../..');
const origin = { path: 'docs/example.md', revision: 'abc1234', modifiedAt: null };

describe('chunkDocument', () => {
  it('splits on headings and keeps the trail on every piece', () => {
    const doc = [
      '# Installing',
      '',
      'There are two supported ways to install, described below in full detail.',
      '',
      '## Windows',
      '',
      'Run the installer from PowerShell. It checks for Node 22 and for Docker before it starts.',
      '',
      '## Ubuntu',
      '',
      'Run the shell script. It checks for the same things and refuses a synced folder.',
    ].join('\n');

    const chunks = chunkDocument(doc, origin);
    expect(chunks).toHaveLength(3);
    expect(chunks.map((c) => c.origin.heading)).toEqual(['Installing', 'Installing > Windows', 'Installing > Ubuntu']);
    // The trail is in the text, not only the metadata: it is often the only
    // thing separating two passages that otherwise say the same words.
    expect(chunks[1]!.content.startsWith('Installing > Windows')).toBe(true);
  });

  it('carries the revision onto every chunk, so an answer can say which version it describes', () => {
    const doc = '# One\n\n' + 'a'.repeat(200) + '\n\n## Two\n\n' + 'b'.repeat(200);
    for (const chunk of chunkDocument(doc, origin)) {
      expect(chunk.origin.revision).toBe('abc1234');
      expect(chunk.origin.path).toBe('docs/example.md');
    }
  });

  it('does not treat a shell comment inside a fence as a heading', () => {
    // The failure this prevents: a code block shattered into fragments that are
    // individually meaningless, because every `# comment` line looked like a
    // section break.
    const doc = [
      '# Setup',
      '',
      'Run this:',
      '',
      '```bash',
      '# install the dependencies',
      'npm install',
      '# start it',
      'npm run dev',
      '```',
      '',
      'That is the whole procedure and it takes about a minute on a warm cache.',
    ].join('\n');

    const chunks = chunkDocument(doc, origin);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.body).toContain('npm install');
    expect(chunks[0]!.body).toContain('npm run dev');
  });

  it('folds a heading with almost nothing under it into what follows', () => {
    const doc = ['# Notes', '', 'See below.', '', '## Detail', '', 'x'.repeat(300)].join('\n');
    const chunks = chunkDocument(doc, origin);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.body).toContain('See below.');
    expect(chunks[0]!.body).toContain('x'.repeat(300));
    // The label follows the content, not the stub it was folded into.
    expect(chunks[0]!.origin.heading).toBe('Notes > Detail');
  });

  it('does not let a short section swallow the heading that identifies the next one', () => {
    // The bug this exists for: a brief "Installing" preamble absorbing the
    // Windows section beneath it, so a question about Windows retrieved a
    // passage labelled "Installing" that also contained the Ubuntu steps.
    const doc = [
      '# Installing',
      '',
      'Two supported ways.',
      '',
      '## Windows',
      '',
      'Run the installer from PowerShell. It checks for Node 22 and Docker first.',
      '',
      '## Ubuntu',
      '',
      'Run the shell script. It checks the same things and refuses a synced folder.',
    ].join('\n');

    const headings = chunkDocument(doc, origin).map((c) => c.origin.heading);
    expect(headings).toContain('Installing > Windows');
    expect(headings).toContain('Installing > Ubuntu');
  });

  it('keeps a short document rather than dropping it', () => {
    const chunks = chunkDocument('# Tiny\n\nOllama works.', origin);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.body).toBe('Ollama works.');
  });

  it('splits an over-long section at paragraph boundaries', () => {
    const paragraph = 'This sentence is here to take up room. '.repeat(12).trim();
    const doc = `# Long\n\n${[paragraph, paragraph, paragraph, paragraph].join('\n\n')}`;
    const chunks = chunkDocument(doc, origin, { maxChars: 600 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.body.length).toBeLessThanOrEqual(600);
      // Splitting must not lose the heading: every piece still says what it is.
      expect(chunk.origin.heading).toBe('Long');
    }
  });

  it('cuts a single paragraph that is itself over the limit rather than dropping it', () => {
    const doc = `# Table\n\n${'x'.repeat(2_000)}`;
    const chunks = chunkDocument(doc, origin, { maxChars: 500 });
    expect(chunks.length).toBe(4);
    expect(chunks.reduce((n, c) => n + c.body.length, 0)).toBe(2_000);
  });

  it('handles a document with no headings at all', () => {
    const chunks = chunkDocument('Just some prose, long enough to be worth keeping around as a chunk.', origin);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.origin.heading).toBe('');
  });

  it('returns nothing for an empty document instead of one empty chunk', () => {
    expect(chunkDocument('', origin)).toEqual([]);
    expect(chunkDocument('\n\n   \n', origin)).toEqual([]);
  });

  it('chunks this repository\'s own README into retrievable sections', () => {
    // The proving case, run against a real document rather than a fixture: if
    // the chunker cannot handle the project's own README, with its fenced
    // blocks and tables and six heading levels, it cannot handle anybody's.
    const readme = readFileSync(resolve(root, 'README.md'), 'utf8');
    const chunks = chunkDocument(readme, { path: 'README.md', revision: 'head', modifiedAt: null });

    expect(chunks.length).toBeGreaterThan(8);
    for (const chunk of chunks) {
      expect(chunk.body.trim().length).toBeGreaterThan(0);
      expect(chunk.content.length).toBeLessThanOrEqual(1_600);
    }
    // Every heading in the file is reachable, which is the property that makes
    // "how do I install this on Windows" answerable at all.
    const headings = chunks.map((c) => c.origin.heading).join('\n');
    expect(headings).toMatch(/install/i);
  });
});
