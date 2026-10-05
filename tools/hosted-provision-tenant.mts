#!/usr/bin/env tsx
/**
 * Provisions one tenant end to end, driven by AI17Z's own step machine.
 *
 *   npm run hosted:provision -- --tenant lab-one            the real list, which stops
 *   npm run hosted:provision -- --tenant lab-one --lab      every step attestation does not gate
 *   npm run hosted:provision -- --tenant lab-one --rollback
 *   npm run hosted:provision -- --tenant lab-one --dry-run
 *
 * Both halves of this already worked and had been proved separately: the
 * provisioning statements against a real Postgres, and a guest booted from a
 * rendered plan running the canonical AI17Z. Nothing joined them, so no
 * request had ever produced a running tenant, and the original Phase 1 barrier
 * asked for exactly that.
 *
 * What makes this more than a shell script calling the same things in order:
 * every step comes from `stepsFor`, `nextAction` decides what runs next from
 * what was recorded rather than from where a loop got to, a failure rolls back
 * in `rollbackOrder` rather than unwinding by hand, and `mayMarkReady` refuses
 * to finish on anything less than evidence the host and the guest gave back.
 * A step that returned is a step that returned; it is not a boundary.
 *
 * ## It walks the confidential list, because that is the one the lab matches
 *
 * `ATTESTED_PROVISIONING_STEPS`. The guest boots before anything exists to put
 * in it, the runtime generates its own key inside its own boundary, and the
 * database is the guest's own on the guest's own disk. That is what the
 * microVM lab does, and the host-sealed list is a different arrangement: a
 * database on a Postgres server the host operates, which `tenantDatabase.ts`
 * implements and `hosted-provision-lab.mts` proves separately.
 *
 * **And it stops.** `ATTEST_RUNTIME` is the fifth step and this machine has no
 * confidential hardware, so there is no report, nothing to verify a
 * measurement against, and no key release to gate. The default run performs
 * the four steps before it, refuses that one, and rolls back, which is the
 * behaviour the whole design asks for: a provision that cannot prove what it
 * booted must not proceed. That refusal is the thing worth demonstrating,
 * because a gate nobody has seen refuse is a gate nobody has seen.
 *
 * `--lab` records the refusal and carries on anyway, which produces a running
 * tenant and **is not the confidential tier**. Every line it prints says so.
 * Nothing it produces may hold a paying customer, the key it ends up with is
 * on a disk a host operator can read, and the guest's memory is readable by
 * the host's root.
 *
 * ## Why a tool rather than the worker
 *
 * The worker is the process that owns machines and will eventually do this.
 * But `hostAgent.ts` deliberately spawns nothing, and the test next to it says
 * why: nothing in this repository had booted a guest, and a spawn there would
 * have been the first thing to make that claim false. Putting a process
 * spawner into the worker is a decision about the product; proving the step
 * machine drives a real provision is a decision about this lab. They are
 * different sizes and this is the smaller one.
 *
 * It needs Linux, root, and the lab from `packaging/hosted-lab/bin`. On
 * Windows it reaches the Linux side exactly as the egress proof does.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MEASURED_TENANT_FOOTPRINT,
  type IsolationEvidence,
  type ProvisioningProgress,
  custodyProblems,
  judgeFootprint,
  mayMarkReady,
  nextAction,
  rollbackOrder,
  stepsFor,
} from '@xbam/runtime';
import { PROVIDER_TIERS_ENABLED } from '@xbam/shared/contracts';

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? argv[at + 1] : undefined;
};
const tenant = flag('tenant') ?? 'lab-one';
const dryRun = argv.includes('--dry-run');
const rollingBack = argv.includes('--rollback');
/** Carry on past the step no hardware here can satisfy. Never the confidential tier. */
const labMode = argv.includes('--lab');
const LAB = flag('lab-dir') ?? '/opt/ai17z-lab';
/*
  The tools run through tsx rather than through npm. Node refuses to spawn a
  .cmd without a shell on Windows, which arrives as `spawnSync npm.cmd EINVAL`
  from inside whichever step called it and reads exactly like that step's tool
  refusing the work. Through tsx there is no shell in the way and one command
  works on both platforms.
*/
const TSX = join('node_modules', 'tsx', 'dist', 'cli.mjs');

/** Runs a command on the Linux side, as the egress proof does. */
function onLinux(script: string): string {
  if (process.platform === 'linux') {
    return execFileSync('bash', ['-c', script], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  }
  return execFileSync('wsl.exe', ['-u', 'root', '-e', 'bash', '-c', script], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * Writes a file out, under both the names it can be read by.
 *
 * `local` is for the tools that run here; `linux` is for the lab, which runs
 * on the other side of a mount point. One name for both was how the plan tool
 * came to be handed a path beginning /opt on Windows, where it resolved to
 * C:\opt and was not there.
 */
function stage(contents: string, name: string): { local: string; linux: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ai17z-provision-'));
  const local = join(dir, name);
  writeFileSync(local, contents.replace(/\r\n/g, '\n'), 'utf8');
  if (process.platform === 'linux') return { local, linux: local };
  // Converted here rather than by asking wslpath, which converts an already
  // converted path twice and reports a file that is not there.
  const linux = local.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_m, drive: string) => `/mnt/${drive.toLowerCase()}`);
  return { local, linux };
}

const say = (line = ''): void => void process.stdout.write(`${line}\n`);
const step = (name: string, detail: string): void => void process.stdout.write(`  ${name.padEnd(19)} ${detail}\n`);
/**
 * Why a tool refused, from its stderr rather than from the command line.
 *
 * execFileSync's message is the command it ran, which says nothing about what
 * was wrong with it. The tools here print their reasons on stderr, which is
 * the whole point of them having reasons.
 */
function reasonFrom(error: unknown): string {
  const stderr = (error as { stderr?: Buffer | string }).stderr;
  const text = typeof stderr === 'string' ? stderr : stderr?.toString('utf8') ?? '';
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('at ') && !/^\w+Error:/.test(line));
  return lines.length > 0 ? lines.slice(0, 3).join(' ') : (error as Error).message.split('\n')[0]!;
}

const runTool = (tool: string, args: readonly string[]): string =>
  execFileSync(process.execPath, [TSX, join('tools', tool), ...args], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });

// ---------------------------------------------------------------------------
// What this is, said before it does anything
// ---------------------------------------------------------------------------

const custody = 'ATTESTED_RELEASE' as const;
const steps = stepsFor(custody);

say(`Provisioning ${tenant} from ATTESTED_PROVISIONING_STEPS, on a lab host.`);
say();

// The list is right and the hardware is not, and those are different
// sentences. This is the first of them.
const listProblems = custodyProblems(custody, steps);
say(
  listProblems.length === 0
    ? '  The step list keeps every promise its custody makes.'
    : `  The step list does not keep its own promises: ${listProblems.join('; ')}`,
);
if (listProblems.length > 0) process.exit(1);

// And this is the second.
say('  This machine has no confidential hardware, so ATTEST_RUNTIME cannot be performed.');
if (labMode) {
  say('  --lab: that refusal is recorded and the run continues anyway.');
  say('  THIS IS NOT THE CONFIDENTIAL TIER. The host can read this tenant\'s memory and its key.');
} else {
  say('  So this run will stop there and roll back, which is what the design asks for.');
}
say(`  Enabled provider tiers: ${PROVIDER_TIERS_ENABLED.join(', ') || 'none'}. No paying customer may be placed here.`);
say();

const sized = judgeFootprint(MEASURED_TENANT_FOOTPRINT, new Date());
if (!sized.usable) {
  say(`Refusing: ${sized.why}`);
  process.exit(1);
}
/*
  Taken out of the verdict here rather than read from it inside each step. A
  narrowing at the top of a module does not reach into a function declared
  below it, because a function can be called from anywhere, and the compiler is
  right about that.
*/
const SIZED_MEMORY_MB = sized.memoryMb;
say(`Sizing from the measurement: ${sized.why}`);
say();

if (!dryRun) {
  try {
    onLinux(`test -x /usr/local/bin/jailer && test -f ${LAB}/dl/image.json`);
  } catch {
    say('Refusing: the lab is not present on the Linux side. Build it with build-ai17z-guest.sh first.');
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// Each step, performed, with what it actually did
// ---------------------------------------------------------------------------

const progress: ProvisioningProgress = { runtimeId: tenant, completed: [] };
const completed: string[] = [];
const evidence: IsolationEvidence = {
  egressEnforced: false,
  guestMatchesPlan: false,
  databaseIsolated: false,
  keyIsItsOwn: false,
};

/** What each step produced, for the steps after it and for the rollback. */
const made: { planPath?: string; tap?: string; netns?: string; dataDisk?: string } = {};

type StepResult = { ok: true; detail: string } | { ok: false; why: string };

function guestLog(): string {
  return onLinux(`cat ${LAB}/${tenant}.console.log 2>/dev/null || true`);
}

function perform(name: string): StepResult {
  switch (name) {
    case 'RESERVE_PLACEMENT': {
      /*
        The lab host is this machine and the reservation is arithmetic against
        the measurement rather than a row. The control-plane repository is
        proved against a real Postgres by hosted-provision-lab.mts, and
        reserving a row here would be provisioning into the developer's own
        database, which the integration suite is told never to touch.
      */
      const free = Number(onLinux("awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo").trim());
      if (free < SIZED_MEMORY_MB) return { ok: false, why: `${free} MB available against ${SIZED_MEMORY_MB} MB needed.` };
      return { ok: true, detail: `${free} MB available on the lab host, ${SIZED_MEMORY_MB} MB set aside.` };
    }

    case 'CREATE_DATA_DISK': {
      const plan = renderPlan();
      if (!plan.ok) return plan;
      // Made by the boot, from the plan, because the plan is what says how
      // large it is and where it goes.
      return { ok: true, detail: `${made.dataDisk}, sized from the measurement at ${SIZED_MEMORY_MB} MB of memory.` };
    }

    case 'ATTACH_NETWORK':
      return renderRuleset();

    case 'BOOT_GUEST':
      return boot();

    case 'ATTEST_RUNTIME': {
      /*
        The one step no amount of work here can perform. There is no SEV-SNP
        or TDX report to fetch, nothing to check a measurement against, and no
        key-release service to satisfy. judgeConfidentialEvidence would refuse
        anything this machine could produce, and it would be right to.

        Refused rather than simulated. A simulated attestation is the exact
        thing the design is arranged to make impossible, and a tool that
        produced one would be teaching somebody that this works.
      */
      return {
        ok: false,
        why: 'no confidential hardware here: no attestation report exists, so nothing can prove which runtime booted.',
      };
    }

    case 'RELEASE_MASTER_KEY': {
      // Reached only under --lab. The guest generated its own key and kept it
      // on its own disk, which is HOST_SEALED behaviour, not release.
      const digest = /AI17Z-GUEST key digest ([0-9a-f]+)/.exec(guestLog());
      if (!digest) return { ok: false, why: 'the guest reported no key.' };
      return {
        ok: true,
        detail: `NOT RELEASED: the guest generated its own and kept it on its own disk (digest ${digest[1]}). A host operator can read it.`,
      };
    }

    case 'CREATE_DATABASE': {
      const log = guestLog();
      if (/AI17Z-GUEST ok tenant database created|AI17Z-GUEST ok the tenant database is already there/.test(log)) {
        return { ok: true, detail: "the guest's own Postgres, inside the boundary, on its own disk." };
      }
      return { ok: false, why: 'the guest did not report a database of its own.' };
    }

    case 'MIGRATE_SCHEMA': {
      const log = guestLog();
      const applied = /applied \((\d+) of them\)/.exec(log);
      if (applied) return { ok: true, detail: `${applied[1]} migrations, inside the guest.` };
      if (/ok the schema was already current/.test(log)) return { ok: true, detail: 'the schema was already current.' };
      return { ok: false, why: 'the guest did not report its schema being applied.' };
    }

    case 'VERIFY_ISOLATION':
      return verify();

    case 'ISSUE_GRANT': {
      /*
        Not issued, and settled as a refusal rather than skipped. A grant is
        what makes a runtime reachable from outside, and this is a lab tenant
        on a tier no customer may be placed on, so issuing one would create
        the one thing that is not supposed to exist here. A skipped step is
        indistinguishable from a step that failed quietly.
      */
      return { ok: true, detail: 'refused by design: no grant for a lab tenant on a tier no customer may use.' };
    }

    case 'MARK_READY': {
      const verdict = mayMarkReady(evidence);
      if (!verdict.ready) return { ok: false, why: verdict.missing.join(' ') };
      return { ok: true, detail: 'every piece of evidence is in, from the host and from the guest.' };
    }

    default:
      return { ok: false, why: `nothing here performs ${name}.` };
  }
}

function renderPlan(): StepResult {
  try {
    /*
      The measurement is read from the file the image build wrote, which lives
      on the lab's side, so it is copied here for the plan tool to read. The
      paths the plan then names are the lab's, because --lab is what derives
      them and the host that boots the guest is over there.
    */
    const measurement = stage(onLinux(`cat ${LAB}/dl/image.json`), 'image.json');
    const out = runTool('tenant-vm-plan.mts', [
      '--id',
      tenant,
      '--image',
      measurement.local,
      '--lab',
      LAB,
      '--memory-mb',
      String(SIZED_MEMORY_MB),
    ]);
    const plan = JSON.parse(out) as { tap: string; netnsName: string; dataDiskPath: string };
    made.tap = plan.tap;
    made.netns = plan.netnsName;
    made.dataDisk = plan.dataDiskPath;
    made.planPath = `${LAB}/${tenant}.plan.json`;
    onLinux(`cp ${stage(out, `${tenant}.plan.json`).linux} ${made.planPath}`);
    return { ok: true, detail: `plan rendered for ${plan.tap}` };
  } catch (error) {
    // The usual failure here is a plan microVmPlanProblems refused, whose
    // reasons go to stderr rather than into the message.
    return { ok: false, why: `the plan was refused: ${reasonFrom(error)}` };
  }
}

function renderRuleset(): StepResult {
  if (!made.tap) return { ok: false, why: 'there is no plan, so no interface to write rules for.' };
  try {
    const out = runTool('tenant-ruleset.mts', ['--tap', made.tap]);
    onLinux(`cp ${stage(out, `${tenant}.nft`).linux} ${LAB}/${tenant}.nft`);
    const rules = (out.match(/iifname/g) ?? []).length;
    return { ok: true, detail: `${rules} rules staged for ${made.tap}, loaded into its namespace before the guest can send a packet.` };
  } catch (error) {
    return { ok: false, why: `the ruleset could not be rendered: ${(error as Error).message.split('\n')[0]}` };
  }
}

function boot(): StepResult {
  try {
    const out = onLinux(`AI17Z_HOLD=1 ${LAB}/bin/boot-ai17z-guest.sh ${tenant} ${made.planPath} 2>&1`);
    if (!/The canonical AI17Z ran inside the guest/.test(out)) {
      const failed = out.split('\n').filter((line) => /AI17Z-GUEST FAIL/.test(line));
      return { ok: false, why: failed.length > 0 ? failed.join(' ') : 'the guest did not report finishing.' };
    }
    const memory = /memory total=\d+MB available=\d+MB used=(\d+)MB/.exec(out);
    return { ok: true, detail: `booted, AI17Z running, ${memory ? `${memory[1]} MB used inside the guest` : 'memory unreported'}.` };
  } catch (error) {
    return { ok: false, why: `the boot failed: ${(error as Error).message.split('\n')[0]}` };
  }
}

function verify(): StepResult {
  const problems: string[] = [];

  // The egress rules, read back out of the kernel rather than assumed from
  // having loaded them.
  try {
    const loaded = onLinux(`ip netns exec ${made.netns} nft list ruleset`);
    const denials = (loaded.match(/drop/g) ?? []).length;
    evidence.egressEnforced = denials >= 10 && /policy drop/.test(loaded);
    if (!evidence.egressEnforced) problems.push(`the namespace carries ${denials} denials and no drop policy`);
  } catch (error) {
    problems.push(`the ruleset could not be read back: ${(error as Error).message.split('\n')[0]}`);
  }

  // What the host says it ran, against what the plan asked for. AI17Z's own
  // comparison through guestMatchesPlan, not this tool's.
  try {
    const out = runTool('guest-report-check.mts', [
      '--plan',
      stage(onLinux(`cat ${made.planPath}`), 'plan.json').local,
      '--report',
      stage(onLinux(`cat ${LAB}/${tenant}.report.json`), 'report.json').local,
    ]);
    evidence.guestMatchesPlan = /The host ran what/.test(out);
    if (!evidence.guestMatchesPlan) problems.push(out.trim());
  } catch (error) {
    problems.push(`the host report disagreed with the plan: ${(error as Error).message.split('\n')[0]}`);
  }

  // The database, from the guest's own report. A database inside the boundary
  // cannot be asked from out here, which is the point of it being in there.
  const log = guestLog();
  evidence.databaseIsolated = /AI17Z-GUEST ok this database holds one tenant/.test(log);
  if (!evidence.databaseIsolated) problems.push('the guest did not report its database holding one tenant');

  // And the key. Its digest is printed; the key is not.
  const digest = /AI17Z-GUEST key digest ([0-9a-f]+)/.exec(log);
  evidence.keyIsItsOwn = Boolean(digest);
  if (!digest) problems.push('the guest did not report a key digest');

  if (problems.length > 0) return { ok: false, why: problems.join('; ') };
  return { ok: true, detail: `egress enforced, guest matches its plan, one tenant in the database, key digest ${digest?.[1]}.` };
}

// ---------------------------------------------------------------------------
// Rolling back, newest first
// ---------------------------------------------------------------------------

function undo(name: string): string {
  switch (name) {
    case 'STOP_GUEST':
      /*
        Matched on `^/firecracker`, which is how the process's own command
        line begins. `pgrep -f "firecracker --id lab-one"` also matches the
        shell running that very command, because the pattern is in its command
        line too, so the step killed itself and returned 15.
      */
      onLinux(`for p in $(pgrep -f "^/firecracker --id ${tenant}" || true); do kill -TERM "$p" 2>/dev/null || true; done; sleep 1; true`);
      return 'the guest was stopped';
    case 'DETACH_NETWORK':
      onLinux(`ip netns del ${made.netns ?? `ai17z-${tenant}`} 2>/dev/null || true`);
      return 'the namespace and its rules were removed';
    case 'DESTROY_DATA_DISK':
      /*
        Deliberately not deleted, and named rather than silently skipped. A
        rollback that destroys a tenant's only writable disk destroys the
        tenant, and in a lab the disk is the evidence. A real rollback of a
        failed first provision may delete it; one of a provision that got as
        far as a running tenant must not.
      */
      return `left in place at ${made.dataDisk ?? 'its path'}: a rollback that deletes the tenant's disk deletes the tenant`;
    case 'RELEASE_PLACEMENT':
      return 'the reservation was arithmetic, so there is nothing to release';
    case 'DESTROY_MASTER_KEY':
      return "the key is on the tenant's own disk and goes with it";
    case 'REVOKE_GRANT':
      return 'no grant was issued';
    case 'MARK_NOT_READY':
      return 'nothing outside was told this runtime existed';
    default:
      return 'nothing to do';
  }
}

if (rollingBack) {
  say('Rolling back, newest first:');
  for (const name of rollbackOrder(steps.map((s) => s.name), steps)) step(name, undo(name));
  say();
  say('Rolled back.');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

say('Steps, with nextAction deciding each one from what was recorded:');

let guard = 0;
let stopped: { step: string; why: string } | null = null;
for (;;) {
  if (++guard > steps.length + 2) {
    say();
    say('Refusing: the step machine did not finish, which is a fault in this tool rather than in the tenant.');
    process.exit(1);
  }
  const action = nextAction({ ...progress, completed: [...completed] }, steps);
  if (action.action === 'ROLLBACK') {
    say();
    say(`Stopped at ${progress.failed?.step}: ${progress.failed?.why ?? 'no reason recorded'}`);
    say();
    say('Rolling back, newest first:');
    for (const name of rollbackOrder(completed, steps)) step(name, undo(name));
    say();
    say(
      stopped?.step === 'ATTEST_RUNTIME'
        ? 'This is the gate working. A provision that cannot prove what it booted must not proceed.\nTo perform every step attestation does not gate, which is NOT the confidential tier:\n  npm run hosted:provision -- --tenant ' +
            tenant +
            ' --lab'
        : 'The provision was undone.',
    );
    process.exit(stopped?.step === 'ATTEST_RUNTIME' ? 0 : 1);
  }
  if (action.action !== 'RUN') break;

  const current = action.step;
  if (dryRun) {
    step(current.name, `${current.performedBy === 'GUEST' ? 'the guest' : 'the control plane'}: ${current.what}`);
    completed.push(current.name);
    continue;
  }

  const result = perform(current.name);
  if (result.ok) {
    step(current.name, result.detail);
    completed.push(current.name);
    continue;
  }

  stopped = { step: current.name, why: result.why };
  if (current.name === 'ATTEST_RUNTIME' && labMode) {
    step(current.name, `REFUSED, carrying on because --lab: ${result.why}`);
    completed.push(current.name);
    continue;
  }
  step(current.name, `FAILED: ${result.why}`);
  progress.failed = stopped;
}

say();
if (dryRun) {
  say(`Dry run: ${completed.length} steps, nothing performed.`);
  process.exit(0);
}

const ready = mayMarkReady(evidence);
if (!ready.ready) {
  say(`The runtime is not ready: ${ready.missing.join(' ')}`);
  process.exit(1);
}
say(`${tenant} is provisioned and running, end to end, driven by AI17Z's own step machine.`);
say('It is not a confidential runtime: ATTEST_RUNTIME was refused and recorded as refused.');
say('Its guest is still up. To take it down and roll back:');
say(`  npm run hosted:provision -- --tenant ${tenant} --rollback`);
