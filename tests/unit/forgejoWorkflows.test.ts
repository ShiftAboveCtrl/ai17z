import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as load } from 'yaml';

/**
 * Workflows AI17Z Code will run, and that mean what they say.
 *
 * A broken workflow does not fail usefully. A `needs` naming a job that does
 * not exist, or a step running a script that is not there, fails at the moment
 * it matters most: on the tag. This checks what a schema cannot see, because
 * it spans files, and the properties the workflows exist to hold, so a later
 * edit cannot quietly drop one.
 *
 * Two of them are about trust, and they are the reason this file exists:
 *
 *   - **Code from a pull request runs only on `ai17z-ci`**, the runner that
 *     holds nothing, and a job there never names a secret. A pull request is
 *     somebody else's code, and a secret a job names is a secret that job can
 *     print.
 *   - **Release jobs run only on `ai17z-release-*`**, and only from a tag. The
 *     release key and the release token are named by the one step that signs
 *     and publishes.
 *
 * One property is inherited from the GitHub workflows these replaced. A literal
 * newline once ended a `run: |` block early, the rest of the shell command sat
 * at column 0 and became a second document, and the parser that checked the
 * file took the first document and pronounced it fine.
 */

const root = resolve(__dirname, '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

const workflowFiles = readdirSync(resolve(root, '.forgejo/workflows'))
  .filter((f) => f.endsWith('.yml'))
  .map((f) => `.forgejo/workflows/${f}`);
const scripts = readdirSync(resolve(root, '.forgejo/scripts')).map((f) => `.forgejo/scripts/${f}`);

type Step = { uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown>; if?: string };
type Job = {
  'runs-on'?: string;
  needs?: string | string[];
  if?: string;
  steps?: Step[];
  env?: Record<string, string>;
  strategy?: { matrix?: { include?: { runner?: string }[] } };
};
type Workflow = { on: Record<string, unknown>; jobs: Record<string, Job>; env?: Record<string, string> };

const workflows = new Map<string, Workflow>(workflowFiles.map((path) => [path, load(read(path)) as Workflow]));
const wf = (name: string) => workflows.get(`.forgejo/workflows/${name}.yml`)!;
const needsOf = (job: Job) => (Array.isArray(job.needs) ? job.needs : job.needs ? [job.needs] : []);
/** Every runner label a job can land on, a matrix's included. */
function runnersOf(job: Job): string[] {
  const label = job['runs-on'] ?? '';
  if (label.includes('${{ matrix.runner }}')) return (job.strategy?.matrix?.include ?? []).map((i) => i.runner ?? '');
  return [label];
}
const triggers = (w: Workflow) => Object.keys(w.on ?? {});
const SECRET = /\$\{\{\s*secrets\./;

describe('the files Forgejo reads before anything runs', () => {
  it('there are some, so this is not passing on an empty list', () => {
    expect(workflowFiles.sort()).toEqual([
      '.forgejo/workflows/check.yml',
      '.forgejo/workflows/package.yml',
      '.forgejo/workflows/qualify.yml',
      '.forgejo/workflows/release.yml',
    ]);
  });

  it('nothing is left behind for another forge to run but GitHub\'s public check', () => {
    // Releases have one pipeline. GitHub carries one workflow so the public
    // repository shows a verdict, and it may only check: it triggers on main
    // and pull requests, never on a tag, reads the repository and nothing
    // more, and names no secret. Forgejo ignores .github while .forgejo exists.
    expect(() => readdirSync(resolve(root, '.gitlab'))).toThrow();
    expect(readdirSync(resolve(root, '.github/workflows'))).toEqual(['ci.yml']);
    const text = read('.github/workflows/ci.yml');
    const ci = load(text) as Workflow & { permissions?: Record<string, string> };
    expect(Object.keys(ci.on).sort()).toEqual(['pull_request', 'push']);
    expect(ci.on.push).toEqual({ branches: ['main'] });
    expect(ci.permissions).toEqual({ contents: 'read' });
    expect(text).not.toMatch(SECRET);
    for (const job of Object.values(ci.jobs)) {
      for (const step of job.steps ?? []) {
        if (step.uses) expect(step.uses, `${step.uses} is not pinned to a commit`).toMatch(/@[0-9a-f]{40}$/);
      }
    }
  });

  it.each(workflowFiles)('%s is one document', (path) => {
    const starts = read(path).split(/\r?\n/).filter((line) => line === '---' || line.startsWith('--- '));
    expect(starts.length, `${path} has ${starts.length} document markers`).toBe(0);
  });

  it('every job a `needs` names exists in the same workflow', () => {
    for (const [path, w] of workflows) {
      for (const [name, job] of Object.entries(w.jobs)) {
        for (const need of needsOf(job)) expect(w.jobs[need], `${path}: ${name} needs ${need}, which does not exist`).toBeTruthy();
      }
    }
  });

  it('every script a step runs is in the repository', () => {
    const named = new Set<string>();
    for (const w of workflows.values()) {
      for (const job of Object.values(w.jobs)) {
        for (const step of job.steps ?? []) {
          for (const m of (step.run ?? '').matchAll(/\.forgejo[\\/]scripts[\\/]([A-Za-z0-9_.-]+)/g)) named.add(`.forgejo/scripts/${m[1]}`);
        }
      }
    }
    expect(named.size).toBeGreaterThan(10);
    for (const path of named) expect(scripts, `${path} is run and does not exist`).toContain(path);
  });

  it('every action is pinned to a commit, on Forgejo\'s own mirror', () => {
    // A tag can be moved; a commit cannot. And a bare `actions/checkout` is
    // resolved against whatever DEFAULT_ACTIONS_URL a server is configured
    // with, so the full address says which one this means.
    for (const [path, w] of workflows) {
      for (const job of Object.values(w.jobs)) {
        for (const step of job.steps ?? []) {
          if (!step.uses) continue;
          expect(step.uses, `${path}: ${step.uses}`).toMatch(/^https:\/\/data\.forgejo\.org\/[a-z-]+\/[a-z-]+@[0-9a-f]{40}$/);
        }
      }
    }
  });
});

describe('who runs what', () => {
  it('code from a pull request runs only on the runner that holds nothing', () => {
    for (const [path, w] of workflows) {
      if (!triggers(w).includes('pull_request')) continue;
      for (const [name, job] of Object.entries(w.jobs)) {
        expect(runnersOf(job), `${path}: ${name}`).toEqual(['ai17z-ci']);
      }
    }
  });

  it('a workflow a pull request can start names no secret, anywhere', () => {
    for (const [path, w] of workflows) {
      if (!triggers(w).includes('pull_request')) continue;
      expect(SECRET.test(read(path)), `${path} names a secret`).toBe(false);
    }
  });

  it('nothing on the pull request runner is ever privileged', () => {
    // A privileged container can reach the machine it runs on, and with it the
    // runner's own credentials; a runner declares its own labels, so those
    // credentials could start a runner claiming a release label and be handed
    // the release key. The pull request machine therefore never runs one.
    for (const [path, w] of workflows) {
      for (const [name, job] of Object.entries(w.jobs)) {
        if (!runnersOf(job).includes('ai17z-ci')) continue;
        expect(JSON.stringify(job), `${path}: ${name} asks for a privileged container on ai17z-ci`).not.toMatch(/privileged/);
      }
    }
  });

  it('package validation is started by hand, on a release runner', () => {
    const w = wf('package');
    expect(triggers(w)).toEqual(['workflow_dispatch']);
    for (const job of Object.values(w.jobs)) expect(runnersOf(job)).toEqual(['ai17z-release-linux']);
  });

  it('nothing pull_request_target: a pull request never runs with the base repository\'s secrets', () => {
    for (const [path, w] of workflows) expect(triggers(w), path).not.toContain('pull_request_target');
  });

  it('release and qualification run only from tags, only on release runners', () => {
    for (const name of ['release', 'qualify']) {
      const w = wf(name);
      expect(triggers(w)).toEqual(['push']);
      const push = w.on.push as { tags?: string[]; branches?: string[] };
      expect(push.branches).toBeUndefined();
      expect(push.tags!.length).toBeGreaterThan(0);
      for (const [job, def] of Object.entries(w.jobs)) {
        for (const runner of runnersOf(def)) expect(runner, `${name}: ${job} runs on ${runner}`).toMatch(/^ai17z-release-/);
      }
    }
  });

  it('only the step that signs and publishes is given the release key and token', () => {
    const holders: string[] = [];
    for (const [path, w] of workflows) {
      for (const [name, job] of Object.entries(w.jobs)) {
        expect(SECRET.test(JSON.stringify(job.env ?? {})), `${path}: ${name} puts a secret in the job's env`).toBe(false);
        (job.steps ?? []).forEach((step, i) => {
          if (SECRET.test(JSON.stringify(step))) holders.push(`${path}:${name}:${i}`);
        });
      }
      expect(SECRET.test(JSON.stringify(w.env ?? {})), `${path} puts a secret in the workflow's env`).toBe(false);
    }
    expect(holders).toHaveLength(1);
    const publish = wf('release').jobs.publish!;
    const step = publish.steps!.find((s) => SECRET.test(JSON.stringify(s)))!;
    // The GitHub mirror is part of publishing, and its token lives in the same
    // step for the same reason the others do.
    expect(Object.keys(step.env ?? {}).sort()).toEqual(['COSIGN_PASSWORD', 'COSIGN_PRIVATE_KEY', 'GITHUB_MIRROR_TOKEN', 'RELEASE_TOKEN']);
    expect(step.run).toContain('publish-release.sh');
    // After AI17Z Code has it, and never for a rehearsal, which publishes nothing.
    expect(step.run!.indexOf('mirror-github.sh')).toBeGreaterThan(step.run!.lastIndexOf('publish-release.sh'));
    expect(step.run!.indexOf('mirror-github.sh')).toBeGreaterThan(step.run!.indexOf('else'));
  });

  it('builds natively where there is a runner, and assembles and proves the rest', () => {
    const ubuntu = wf('release').jobs['package-ubuntu']!;
    expect(ubuntu.strategy!.matrix!.include).toEqual([{ arch: 'amd64', runner: 'ai17z-release-linux' }]);
    expect(wf('release').jobs['package-windows']!['runs-on']).toBe('ai17z-release-windows');
    // No Mac and no arm64 Linux runner: those packages are assembled on the
    // Linux release runner and refused unless their native files are the
    // natively built reference's, byte for byte.
    const assembled = wf('release').jobs['package-assembled']!;
    expect(assembled['runs-on']).toBe('ai17z-release-linux');
    const runs = (assembled.steps ?? []).map((step) => step.run ?? '').join('\n');
    expect(runs).toContain('package-assembled.sh');
    for (const target of ['macos arm64', 'macos x64', 'ubuntu arm64']) expect(runs).toContain(`"${target}"`);
    expect(read('.forgejo/scripts/package-assembled.sh')).toContain('prove-natives.sh');
    expect(JSON.stringify(assembled)).not.toMatch(/secrets\./);
    expect(JSON.stringify(assembled)).not.toContain('--privileged');
  });

  it('pins every native reference by hash, and names where it came from', () => {
    const refs = JSON.parse(read('.forgejo/native-references.json')) as Record<string, { release?: string; asset?: string; sha256?: string }>;
    for (const key of ['macos-arm64', 'macos-x64', 'ubuntu-arm64']) {
      expect(refs[key]!.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(refs[key]!.release).toMatch(/^v\d/);
      expect(refs[key]!.asset).toBeTruthy();
    }
  });
});

describe('what the release exists to hold', () => {
  const release = wf('release');

  it('publishes only after the checks and every package, in the same run', () => {
    const needs = needsOf(release.jobs.publish!);
    for (const required of ['check', 'package-ubuntu', 'package-windows', 'package-assembled']) expect(needs).toContain(required);
    // No `if:` at all, so every job it needs has to have succeeded. An
    // `always()` here would publish over red.
    expect(release.jobs.publish!.if).toBeUndefined();
  });

  it('runs the full check, both secret scans included, before anything is published', () => {
    const runs = (release.jobs.check!.steps ?? []).map((s) => s.run ?? '').join('\n');
    for (const gate of ['npm run typecheck', 'npm run lint', 'npm run release:check', 'secret-scan.sh', 'history-scan.py', 'npx vitest run', 'npm run build:web']) {
      expect(runs).toContain(gate);
    }
  });

  it('waits on no runner that is not registered', () => {
    expect(release.jobs['package-macos']).toBeUndefined();
    // A job's `if` is judged by the runner that takes it, so a job for a label
    // nobody registered is never judged and waits for ever: v1.0.0-beta.85's
    // run never finished. Every release job lands on a runner that exists.
    const labels = Object.values(release.jobs).flatMap(runnersOf);
    for (const label of labels) expect(['ai17z-release-linux', 'ai17z-release-windows']).toContain(label);
  });

  it('leaves out only a package that needs a native build, and says which', () => {
    const runs = (release.jobs['package-assembled']!.steps ?? []).map((step) => step.run ?? '').join('\n');
    // Exit 3 is prove-natives' "needs a native file nobody has built"; every
    // other failure fails the job.
    expect(runs).toContain('[ "$code" -eq 3 ]');
    expect(runs).toContain('absent-packages.txt');
    expect(read('.forgejo/scripts/prove-natives.sh')).toContain('exit 3');
    expect(read('.forgejo/scripts/publish-release.sh')).toContain('--absent "$ABSENT"');
  });

  it('one release at a time, never cancelled halfway', () => {
    expect((release as unknown as { concurrency: { 'cancel-in-progress': boolean } }).concurrency['cancel-in-progress']).toBe(false);
  });

  it('never cancels a run for main', () => {
    const c = (wf('check') as unknown as { concurrency: { 'cancel-in-progress': string } }).concurrency;
    expect(c['cancel-in-progress']).toBe("${{ github.event_name == 'pull_request' }}");
  });
});

describe('the scripts the workflows run', () => {
  const shell = scripts.filter((p) => p.endsWith('.sh'));
  const powershell = scripts.filter((p) => p.endsWith('.ps1'));

  it.each(shell)('%s is LF and ASCII, and starts as a bash script', (path) => {
    const text = read(path);
    expect(text.startsWith('#!/usr/bin/env bash\n'), `${path} has no bash shebang`).toBe(true);
    expect(text.includes('\r'), `${path} carries a carriage return`).toBe(false);
    expect([...text].every((c) => c.charCodeAt(0) < 128), `${path} is not ASCII`).toBe(true);
  });

  it.each(shell)('%s parses, as bash reads it', (path) => {
    // A script that cannot parse fails only when its job runs, which for the
    // publishing scripts is the release.
    const bash = spawnSync('bash', ['--version']);
    if (bash.error) {
      console.log(`SKIPPED: no bash here, so ${path} was not parsed. This is not a pass.`);
      return;
    }
    const parsed = spawnSync('bash', ['-n', resolve(root, path)], { encoding: 'utf8' });
    expect(parsed.status, `${path} does not parse: ${parsed.stderr}`).toBe(0);
  });

  it.each(powershell)('%s is ASCII, because Windows PowerShell reads a file with no BOM as ANSI', (path) => {
    expect([...read(path)].every((c) => c.charCodeAt(0) < 128), `${path} is not ASCII`).toBe(true);
  });

  it('every trap that reports a failure is complete on its own line', () => {
    for (const path of shell) {
      read(path).split(/\r?\n/).forEach((line, index) => {
        if (/^\s*#/.test(line) || !/^\s*trap /.test(line)) return;
        expect(/' (ERR|EXIT|EXIT INT TERM)$/.test(line.trimEnd()), `${path}:${index + 1} has a trap that does not end: ${line.trim()}`).toBe(true);
      });
    }
  });

  it('no script reads a GitLab pipeline variable any more', () => {
    for (const path of scripts) expect(read(path), path).not.toMatch(/\bCI_(COMMIT|PROJECT|PIPELINE|JOB|SERVER|API)_/);
  });
});
