import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Workflow and action files that GitHub will actually accept.
 *
 * A broken one does not fail usefully. The runner reports
 *
 *   Unexpected type '' encountered while reading 'action manifest root'
 *
 * as "Process completed with exit code 1", on every job at once, before a
 * single step runs -- and Actions logs need admin rights on the repository to
 * read, so that sentence is all most people see.
 *
 * It got there because a literal newline ended a `run: |` block early. The rest
 * of the shell command then sat at column 0 and became a second document, and
 * the YAML parser that checked the file took the first document and pronounced
 * it fine. So this checks the shapes a parser alone will not: one document per
 * file, every step runnable, and every line of shell still inside its block.
 */

const root = resolve(__dirname, '../..');

function filesIn(dir: string, ext: string): string[] {
  try {
    return readdirSync(resolve(root, dir))
      .filter((name) => name.endsWith(ext))
      .map((name) => `${dir}/${name}`);
  } catch {
    return [];
  }
}

const workflows = filesIn('.github/workflows', '.yml');
const actions = readdirSync(resolve(root, '.github/actions'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => `.github/actions/${entry.name}/action.yml`);

const everyFile = [...workflows, ...actions];

describe('the files GitHub reads before anything runs', () => {
  it('there are some, so this is not passing on an empty list', () => {
    expect(workflows.length).toBeGreaterThan(0);
    expect(actions.length).toBeGreaterThan(0);
  });

  it.each(everyFile)('%s is one document', (path) => {
    const text = readFileSync(resolve(root, path), 'utf8');
    // `---` at the start of a line opens a document. A file that grew a second
    // one parses fine and runs as something else entirely.
    const starts = text.split(/\r?\n/).filter((line) => line === '---' || line.startsWith('--- '));
    expect(starts.length, `${path} has ${starts.length} document markers`).toBeLessThanOrEqual(1);
  });

  it.each(everyFile)('%s keeps every shell line inside its block', (path) => {
    const lines = readFileSync(resolve(root, path), 'utf8').split(/\r?\n/);
    // Inside a `run: |` block every line is indented past the key. A line at a
    // shallower indent ends the block -- which is what a stray newline in a
    // shell string does, and what nothing else here would catch.
    let inBlock = false;
    let blockIndent = 0;
    lines.forEach((line, index) => {
      const runMatch = /^(\s*)run: \|/.exec(line);
      if (runMatch) {
        inBlock = true;
        blockIndent = runMatch[1]!.length;
        return;
      }
      if (!inBlock || line.trim() === '') return;
      const indent = /^(\s*)/.exec(line)![1]!.length;
      if (indent <= blockIndent) {
        // The block has ended. It may only end on something that looks like the
        // next key, the next list item, or a comment -- never on a fragment of
        // shell that a stray newline pushed out of its block.
        const ends = /^\s*(#|-\s|[a-zA-Z_][a-zA-Z0-9_-]*:)/.test(line);
        expect(ends, `${path}:${index + 1} ends a run block with shell: ${line.trim()}`).toBe(true);
        inBlock = false;
      }
    });
  });

  it.each(actions)('%s has the shape a composite action must have', (path) => {
    const text = readFileSync(resolve(root, path), 'utf8');
    expect(text).toMatch(/^name:/m);
    expect(text).toMatch(/^runs:/m);
    expect(text).toMatch(/^\s{2}using: composite$/m);
    // Every step runs something or uses something.
    const steps = [...text.matchAll(/^\s{4}- name: (.+)$/gm)].map((m) => m[1]);
    expect(steps.length).toBeGreaterThan(0);
  });

  it('every trap that reports a failure is complete on its own line', () => {
    // The specific break that got through: a `\n` written as a real newline
    // rather than as an escape, inside a single-quoted shell string.
    for (const path of everyFile) {
      const lines = readFileSync(resolve(root, path), 'utf8').split(/\r?\n/);
      lines.forEach((line, index) => {
        if (!line.includes('trap ')) return;
        expect(line.trimEnd().endsWith("' ERR"), `${path}:${index + 1} has a trap that does not end: ${line.trim()}`).toBe(
          true,
        );
      });
    }
  });
});
