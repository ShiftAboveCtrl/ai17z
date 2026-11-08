import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as load } from 'yaml';

const root = resolve(__dirname, '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
type Step = { uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown> };
type Job = { needs?: string[] | string; uses?: string; steps?: Step[]; env?: Record<string, string>; permissions?: Record<string, string>; strategy?: { matrix?: { include: { arch: string; runner: string }[] } } };
type Workflow = { on: Record<string, unknown>; permissions: Record<string, string>; concurrency: { 'cancel-in-progress': boolean | string }; jobs: Record<string, Job> };
const files = readdirSync(resolve(root, '.github/workflows')).filter((f) => f.endsWith('.yml')).map((f) => `.github/workflows/${f}`);
const workflows = files.map((path) => ({ path, text: read(path), parsed: load(read(path)) as Workflow }));
const release = load(read('.github/workflows/release.yml')) as Workflow;
const ci = load(read('.github/workflows/ci.yml')) as Workflow;
const scripts = readdirSync(resolve(root, 'ci/scripts')).map((name) => `ci/scripts/${name}`);
const secret = /\$\{\{\s*secrets\./;

describe('GitHub primary and the backup boundary', () => {
  it('has a CI verdict and a tag release workflow', () => {
    expect(files.sort()).toEqual(['.github/workflows/ci.yml', '.github/workflows/release.yml']);
    expect(ci.on.push).toEqual({ branches: ['main'] });
    expect(Object.keys(ci.on)).toContain('pull_request');
    expect(release.on.push).toEqual({ tags: ['v[0-9]*', 'rehearsal-v[0-9]*'] });
    expect(Object.keys(release.on)).not.toContain('pull_request');
  });
  it('never runs PR code with a secret or on a persistent runner', () => {
    for (const workflow of workflows) {
      expect(workflow.parsed.on).not.toHaveProperty('pull_request_target');
      if (!Object.keys(workflow.parsed.on).includes('pull_request')) continue;
      expect(workflow.text).not.toMatch(secret);
      expect(workflow.text).not.toMatch(/self-hosted|ai17z-release-|privileged/);
    }
  });
  it('pins external actions and leaves checkout credentials out of the worktree', () => {
    for (const workflow of workflows) {
      for (const job of Object.values(workflow.parsed.jobs)) {
        for (const step of job.steps ?? []) {
          if (!step.uses) continue;
          expect(step.uses).toMatch(/@[0-9a-f]{40}$/);
          if (step.uses.startsWith('actions/checkout@')) expect(step.with?.['persist-credentials']).toBe(false);
        }
      }
    }
  });
  it('has a valid job graph and every script exists', () => {
    for (const workflow of workflows) {
      expect(workflow.text).not.toMatch(/^---/m);
      for (const job of Object.values(workflow.parsed.jobs)) {
        for (const name of typeof job.needs === 'string' ? [job.needs] : job.needs ?? []) expect(workflow.parsed.jobs[name]).toBeTruthy();
        for (const step of job.steps ?? []) {
          for (const match of (step.run ?? '').matchAll(/ci[\\/]scripts[\\/]([A-Za-z0-9_.-]+)/g)) expect(scripts).toContain(`ci/scripts/${match[1]}`);
        }
      }
    }
  });
  it('only the publishing job can write and only its publishing step names secrets', () => {
    for (const workflow of workflows) {
      expect(workflow.parsed.permissions).toEqual({ contents: 'read' });
      for (const [name, job] of Object.entries(workflow.parsed.jobs)) {
        expect(secret.test(JSON.stringify(job.env ?? {}))).toBe(false);
        const holders = (job.steps ?? []).filter((step) => secret.test(JSON.stringify(step)));
        if (name === 'publish') {
          expect(holders).toHaveLength(1);
          expect(job.permissions).toEqual({ contents: 'write' });
          expect(Object.keys(holders[0]!.env!).sort()).toEqual(['COSIGN_PASSWORD', 'COSIGN_PRIVATE_KEY', 'PRIVATE_IDENTIFIERS', 'RELEASE_TOKEN']);
          expect(holders[0]!.run).toContain('private-identifiers.sh history || exit 1');
          expect(holders[0]!.run).toContain('publish-release.sh');
        } else {
          expect(holders).toHaveLength(0);
          expect(job.permissions ?? {}).not.toHaveProperty('contents', 'write');
        }
      }
    }
  });
  it('gates publishing on all five native packages and full CI', () => {
    expect(release.jobs.publish!.needs).toEqual(['version', 'check', 'package-ubuntu', 'package-macos', 'package-windows']);
    expect(release.jobs.check!.uses).toBe('./.github/workflows/ci.yml');
    expect(release.jobs['package-ubuntu']!.strategy!.matrix!.include).toEqual([
      { arch: 'amd64', runner: 'ubuntu-24.04' }, { arch: 'arm64', runner: 'ubuntu-24.04-arm' },
    ]);
    expect(release.jobs['package-macos']!.strategy!.matrix!.include).toEqual([
      { arch: 'arm64', runner: 'macos-15' }, { arch: 'x64', runner: 'macos-15-intel' },
    ]);
    const text = read('.github/workflows/ci.yml');
    for (const gate of ['npm run lint', 'npm run typecheck', 'npm run release:check', 'vitest run tests/unit', 'vitest run tests/integration', 'history-scan.py', 'test_release_publish.py']) expect(text).toContain(gate);
    expect(text).toContain('postgres:16-alpine');
  });
  it('never cancels a release and cancels obsolete PR runs only', () => {
    expect(release.concurrency['cancel-in-progress']).toBe(false);
    expect(ci.concurrency['cancel-in-progress']).toBe("${{ github.event_name == 'pull_request' }}");
  });
  it('does not leave a Forgejo pipeline depending on deleted reference releases', () => {
    expect(readdirSync(resolve(root, '.forgejo/workflows')).filter((f) => f.endsWith('.yml'))).toEqual([]);
    expect(read('tools/forgejo-mirror/configure.py')).toContain('"has_actions":false');
    expect(read('tools/forgejo-mirror/sync-releases.py')).toContain('verify_sums');
  });
});

describe('the scripts read by release jobs', () => {
  const bash = scripts.filter((path) => path.endsWith('.sh'));
  it.each(bash)('%s is ASCII, LF, and parses in Git Bash', (path) => {
    const text = read(path);
    expect(text.startsWith('#!/usr/bin/env bash\n')).toBe(true);
    expect(text).not.toContain('\r');
    expect([...text].every((c) => c.charCodeAt(0) < 128)).toBe(true);
    const parsed = spawnSync('bash', ['-n', resolve(root, path)], { encoding: 'utf8' });
    expect(parsed.status, parsed.stderr).toBe(0);
  });
  it.each(scripts.filter((path) => path.endsWith('.ps1')))('%s is ASCII for Windows PowerShell', (path) => {
    expect([...read(path)].every((c) => c.charCodeAt(0) < 128)).toBe(true);
  });
});
