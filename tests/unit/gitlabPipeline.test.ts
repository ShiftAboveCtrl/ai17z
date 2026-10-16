import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as load } from 'yaml';

/**
 * A pipeline GitLab will accept, and that means what it says.
 *
 * A broken pipeline does not fail usefully. GitLab refuses the whole file with
 * one line on the pipelines page, before a single job runs, and a pipeline that
 * parses but names a job that does not exist fails the same way at the moment
 * it matters most: on the tag.
 *
 * The schema GitLab's own editor uses checks each file's shape; this checks
 * what a schema cannot see, because it spans files: every job a `needs` or an
 * `extends` names exists, every stage is declared, every script a job runs is
 * there. And the properties the pipeline exists to hold, so that a later edit
 * cannot quietly drop one: publishing waits for the checks, nothing automatic
 * waits on a job this plan cannot run, and main is never cancelled.
 *
 * One property is inherited from the GitHub workflows this replaced. A literal
 * newline once ended a `run: |` block early, the rest of the shell command sat
 * at column 0 and became a second document, and the parser that checked the
 * file took the first document and pronounced it fine.
 */

const root = resolve(__dirname, '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

const pipelineFiles = ['.gitlab-ci.yml', ...readdirSync(resolve(root, '.gitlab/ci')).filter((f) => f.endsWith('.yml')).map((f) => `.gitlab/ci/${f}`)];
const scripts = readdirSync(resolve(root, '.gitlab/scripts')).map((f) => `.gitlab/scripts/${f}`);

type Job = {
  stage?: string;
  extends?: string | string[];
  needs?: (string | { job: string; optional?: boolean })[];
  rules?: { if?: string; when?: string; allow_failure?: boolean }[];
  script?: string | string[];
  before_script?: string | string[];
  interruptible?: boolean;
  id_tokens?: Record<string, { aud: string }>;
};

const RESERVED = new Set(['workflow', 'stages', 'default', 'variables', 'include']);
const docs = pipelineFiles.map((path) => ({ path, doc: load(read(path)) as Record<string, unknown> }));
const root_ = docs.find((d) => d.path === '.gitlab-ci.yml')!.doc as {
  stages: string[];
  include: { local: string }[];
  workflow: { rules: { if?: string; when?: string; auto_cancel?: { on_new_commit: string } }[] };
};
const jobs = new Map<string, Job>();
for (const { doc } of docs) {
  for (const [name, value] of Object.entries(doc)) {
    if (RESERVED.has(name) || name.startsWith('.') && !value) continue;
    if (value && typeof value === 'object' && !Array.isArray(value)) jobs.set(name, value as Job);
  }
}
const realJobs = [...jobs.entries()].filter(([name]) => !name.startsWith('.'));
const needsOf = (job: Job) => (job.needs ?? []).map((n) => (typeof n === 'string' ? n : n.job));
const linesOf = (value: string | string[] | undefined) => (Array.isArray(value) ? value : value ? [value] : []);
/** A job's own fields over the ones it extends, the way GitLab merges them. */
function resolved(name: string): Job {
  const job = jobs.get(name)!;
  const parents = Array.isArray(job.extends) ? job.extends : job.extends ? [job.extends] : [];
  return Object.assign({}, ...parents.map(resolved), job);
}

describe('the files GitLab reads before anything runs', () => {
  it('there are some, so this is not passing on an empty list', () => {
    expect(pipelineFiles.length).toBeGreaterThan(1);
    expect(realJobs.length).toBeGreaterThan(5);
  });

  it('includes every file under .gitlab/ci, and nothing that is not there', () => {
    const included = root_.include.map((i) => i.local).sort();
    expect(included).toEqual(pipelineFiles.filter((p) => p !== '.gitlab-ci.yml').sort());
  });

  it.each(pipelineFiles)('%s is one document', (path) => {
    // `---` at the start of a line opens a document. A file that grew a second
    // one parses fine and runs as something else entirely.
    const starts = read(path).split(/\r?\n/).filter((line) => line === '---' || line.startsWith('--- '));
    expect(starts.length, `${path} has ${starts.length} document markers`).toBe(0);
  });

  it('every job is in a declared stage', () => {
    for (const [name] of realJobs) {
      const stage = resolved(name).stage;
      expect(stage, `${name} has no stage`).toBeTruthy();
      expect(root_.stages, `${name} is in an undeclared stage ${stage}`).toContain(stage);
    }
  });

  it('every job a `needs` or an `extends` names exists', () => {
    for (const [name, job] of jobs) {
      for (const need of needsOf(job)) expect(jobs.has(need), `${name} needs ${need}, which does not exist`).toBe(true);
      const parents = Array.isArray(job.extends) ? job.extends : job.extends ? [job.extends] : [];
      for (const parent of parents) expect(jobs.has(parent), `${name} extends ${parent}, which does not exist`).toBe(true);
    }
  });

  it('every script a job runs is in the repository', () => {
    const named = new Set<string>();
    for (const [name] of jobs) {
      const job = resolved(name);
      for (const line of [...linesOf(job.before_script), ...linesOf(job.script)]) {
        for (const m of line.matchAll(/\.gitlab[\\/]scripts[\\/]([A-Za-z0-9_.-]+)/g)) named.add(`.gitlab/scripts/${m[1]}`);
      }
    }
    expect(named.size).toBeGreaterThan(5);
    for (const path of named) expect(scripts, `${path} is run and does not exist`).toContain(path);
  });
});

describe('the scripts the pipeline runs', () => {
  const shell = scripts.filter((p) => p.endsWith('.sh'));
  const powershell = scripts.filter((p) => p.endsWith('.ps1'));

  it.each(shell)('%s is LF and ASCII, and starts as a bash script', (path) => {
    const text = read(path);
    expect(text.startsWith('#!/usr/bin/env bash\n'), `${path} has no bash shebang`).toBe(true);
    expect(text.includes('\r'), `${path} carries a carriage return`).toBe(false);
    expect([...text].every((c) => c.charCodeAt(0) < 128), `${path} is not ASCII`).toBe(true);
  });

  it.each(powershell)('%s is ASCII, because Windows PowerShell reads a file with no BOM as ANSI', (path) => {
    expect([...read(path)].every((c) => c.charCodeAt(0) < 128), `${path} is not ASCII`).toBe(true);
  });

  it('every trap that reports a failure is complete on its own line', () => {
    // The break that got through on GitHub: a `\n` written as a real newline
    // rather than as an escape, inside a single-quoted shell string.
    for (const path of shell) {
      read(path).split(/\r?\n/).forEach((line, index) => {
        if (/^\s*#/.test(line) || !/^\s*trap /.test(line)) return;
        expect(/' (ERR|EXIT|EXIT INT TERM)$/.test(line.trimEnd()), `${path}:${index + 1} has a trap that does not end: ${line.trim()}`).toBe(true);
      });
    }
  });
});

describe('what the pipeline exists to hold', () => {
  it('never cancels a pipeline for main or for a tag', () => {
    // On GitHub a run of sequential pushes to main left most of them never
    // tested, because each push cancelled the run before it.
    for (const rule of root_.workflow.rules) {
      if (/CI_DEFAULT_BRANCH|CI_COMMIT_TAG/.test(rule.if ?? '') && rule.when !== 'never') {
        expect(rule.auto_cancel?.on_new_commit, `${rule.if} can be cancelled`).toBe('none');
      }
    }
  });

  it('publishes only after the checks and every package, in the same pipeline', () => {
    for (const name of ['publish', 'publish with macos']) {
      const needs = needsOf(resolved(name));
      for (const required of ['check', 'secret scan', 'package windows', 'package ubuntu amd64', 'package ubuntu arm64']) {
        expect(needs, `${name} does not wait for ${required}`).toContain(required);
      }
    }
  });

  it('signs with the pipeline identity, and only the publish jobs hold one', () => {
    for (const [name] of realJobs) {
      const tokens = resolved(name).id_tokens;
      if (name.startsWith('publish')) expect(tokens?.SIGSTORE_ID_TOKEN?.aud).toBe('sigstore');
      else expect(tokens, `${name} holds an id_token it has no use for`).toBeUndefined();
    }
  });

  it('leaves nothing automatic waiting on the Mac this plan cannot run', () => {
    // A job that needs an unstarted manual job would sit there for ever, and
    // every release would sit with it. Only the variant switched on by
    // AI17Z_MACOS may depend on the macOS package.
    for (const [name, job] of realJobs) {
      if (name === 'publish with macos') continue;
      expect(needsOf(job), `${name} waits on the macOS job`).not.toContain('package macos arm64');
    }
    const macosRules = resolved('package macos arm64').rules ?? [];
    const fallback = macosRules[macosRules.length - 1]!;
    expect(fallback.when).toBe('manual');
    expect(fallback.allow_failure).toBe(true);
    expect(macosRules[0]!.if).toContain('AI17Z_MACOS == "1"');
  });

  it('builds each architecture where it runs', () => {
    expect((jobs.get('package ubuntu arm64') as { tags?: string[] }).tags).toEqual(['saas-linux-small-arm64']);
    expect((jobs.get('package macos arm64') as { tags?: string[] }).tags).toEqual(['saas-macos-medium-m1']);
    expect((jobs.get('package windows') as { tags?: string[] }).tags).toEqual(['saas-windows-medium-amd64']);
  });
});
