#!/usr/bin/env tsx
/**
 * Asks whether the suite would notice a fix being removed.
 *
 * A passing suite says nothing about that. Every entry below is the inverse of
 * a defect this project actually shipped and then found by reading the code
 * afterwards, and the question each one answers is the only one that matters
 * about a regression test: if somebody refactors the fix away, does anything go
 * red? A mutation that survives is a fix with no cover, which is the same as no
 * fix a release or two later.
 *
 *   npx tsx tools/mutation-check.mts              every mutation
 *   npx tsx tools/mutation-check.mts egress       only ids containing "egress"
 *   npx tsx tools/mutation-check.mts --list       what it would do, and nothing else
 *
 * It refuses to start against a dirty tree, restores every file from git on the
 * way out including after a crash, and checks the tree is clean before it
 * reports. Exit 1 means at least one fix has no regression cover.
 *
 * Add an entry whenever a behavioural defect is fixed. The anchor has to appear
 * exactly once, which is itself a check: an anchor that drifted reports
 * ANCHOR rather than quietly mutating the wrong line.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface Mutation {
  id: string;
  /** What the code would be doing again, in the words of the original defect. */
  what: string;
  file: string;
  /** Must appear exactly once. */
  find: string;
  into: string;
  tests: string[];
}

const ROOT = process.cwd();
const git = (...args: string[]): string => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });

const MUTATIONS: Mutation[] = [
  {
    id: 'secret-uuid',
    what: 'carriesSecret refuses every uuid, so a host assignment is refused by the guard meant to let it through',
    file: 'packages/runtime/src/hostedSecrets.ts',
    find: '  if (UUID.test(value)) return false;\n',
    into: '',
    tests: ['tests/unit/hostedSecrets.test.ts'],
  },
  {
    id: 'secret-thumbprint',
    what: 'carriesSecret refuses a key thumbprint, which is the field that exists to be printed instead of a key',
    file: 'packages/runtime/src/hostedSecrets.ts',
    find: "      if (nameIsKeyAdjacent(key) && typeof value === 'string') continue;\n",
    into: '',
    tests: ['tests/unit/hostedSecrets.test.ts'],
  },
  {
    id: 'secret-wallet-word',
    what: 'the secret vocabulary loses the word wallet while the assignment builder still forbids it',
    file: 'packages/runtime/src/hostedSecrets.ts',
    find: "'mnemonic', 'privatekey', 'wallet', 'credential', 'credentials', 'jwk', 'signature',",
    into: "'mnemonic', 'privatekey', 'credential', 'credentials', 'jwk', 'signature',",
    tests: ['tests/unit/hostedSecrets.test.ts'],
  },
  {
    id: 'health-value-shape',
    what: 'isCleanHealth checks field names and not values, so prose passes under an allowed name',
    file: 'packages/runtime/src/hostObservability.ts',
    find:
      "    if (value !== null && value !== undefined && !textual && typeof value !== 'number' && typeof value !== 'boolean') {",
    into: '    if (false) {',
    tests: ['tests/unit/hostObservability.test.ts'],
  },
  {
    id: 'assignment-depth',
    what: "assignmentIsAcceptable reads the top level only, so an owner's email one key down is invisible",
    file: 'packages/runtime/src/hostDaemon.ts',
    find: '        const out = walk(inner, here);\n        if (!out.ok) return out;\n',
    into: '',
    tests: ['tests/unit/hostDaemon.test.ts'],
  },
  {
    id: 'egress-substring',
    what: 'verifyLoadedRuleset matches a CIDR as characters, so 10.0.0.0/8 covers for a missing 0.0.0.0/8',
    file: 'packages/runtime/src/hostEgress.ts',
    find: '!mentions(text, r.target)',
    into: '!text.includes(r.target)',
    tests: ['tests/unit/hostEgress.test.ts'],
  },
  {
    id: 'egress-kernel-spelling',
    what: 'the guard stops accepting the kernel spelling of a single-host denial, so a filtered host reports unfiltered',
    file: 'packages/runtime/src/hostEgress.ts',
    find: '  const forms = [cidr, ...bareFormOf(cidr)];',
    into: '  const forms = [cidr];',
    tests: ['tests/unit/hostEgress.test.ts'],
  },
  {
    id: 'recovery-fence',
    what: 'a restore from HOST_UNREACHABLE needs no fence, so a partitioned host becomes a second copy',
    file: 'packages/runtime/src/runtimeBackup.ts',
    find: "  if (input.oldRuntimeState === 'HOST_UNREACHABLE' && !input.oldHostFenced) {",
    into: '  if (false) {',
    tests: ['tests/unit/runtimeBackup.test.ts'],
  },
  {
    id: 'absent-entitlement',
    what: 'an absent entitlement reads as a lapsed one, marching a runtime nobody priced to a scheduled deletion',
    file: 'packages/runtime/src/hostedLifecycle.ts',
    find: '  if (unrecorded) {',
    into: '  if (false) {',
    tests: ['tests/unit/hostedLifecycle.test.ts'],
  },
  {
    id: 'export-claim',
    what: 'the export list claims relationships and stances travel, which the exporter does not do',
    file: 'packages/runtime/src/hostedExport.ts',
    find: "  'Memories, in a MOVE',",
    into: "  'Memories, in a MOVE',\n  'Relationships',\n  'Beliefs and stances',",
    tests: ['tests/unit/hostedExport.test.ts'],
  },
  {
    id: 'screencast-idle',
    what: 'the screencast idle stop stops working while the setInterval call stays, so a cast with nobody watching never ends',
    file: 'packages/browser/src/screencast.ts',
    find:
      '  const idleTimer = setInterval(() => {\n    if (Date.now() - lastWanted > bounds.idleStopAfterMs) void stop();\n  }, idleCheckMs);',
    into: '  const idleTimer = setInterval(() => {\n    /* mutated */\n  }, idleCheckMs);',
    tests: ['tests/unit/screencast.test.ts'],
  },
  {
    id: 'screencast-counter',
    what: 'a declined frame is counted for ever, so one stutter past the bound is permanent',
    file: 'packages/browser/src/screencast.ts',
    find: '    } else {\n      /*\n        Declined rather than queued.',
    into: '    } else if (false) {\n      /*\n        Declined rather than queued.',
    tests: ['tests/unit/screencast.test.ts'],
  },
  {
    id: 'spend-window',
    what: "a trade created yesterday is subtracted from today's spend, understating the day and passing the limit",
    file: 'packages/runtime/src/tradingGate.ts',
    find:
      '        spentTodayBase: countedToday\n          ? (BigInt(exposure.spentTodayBase) - mine).toString()\n          : exposure.spentTodayBase,',
    into: '        spentTodayBase: (BigInt(exposure.spentTodayBase) - mine).toString(),',
    tests: ['tests/integration/tradingPersistence.test.ts'],
  },
  {
    id: 'phantom-move',
    what: 'moveRuntimeTo stops being conditional on the host it is leaving, so two callers both think they moved it',
    file: 'packages/database/src/repositories/hosting.ts',
    find: 'WHERE id = $1 AND host_id IS NOT NULL AND host_id <> $2 RETURNING *',
    into: 'WHERE id = $1 RETURNING *',
    tests: ['tests/integration/tenantIsolation.test.ts'],
  },
  {
    id: 'preflight-key',
    what: 'the tenant preflight claims to have checked a key it cannot see from inside a tenant',
    file: 'tools/tenant-preflight.mts',
    find: 'cannot be checked from inside a tenant',
    into: 'is checked by asking for runtime.key.fingerprint',
    tests: ['tests/unit/tenantPreflight.test.ts'],
  },
];

type Outcome = 'CAUGHT' | 'SURVIVED' | 'ANCHOR' | 'BROKEN';

const argv = process.argv.slice(2);
const listOnly = argv.includes('--list');
const filter = argv.find((a) => !a.startsWith('-'));
const chosen = filter ? MUTATIONS.filter((m) => m.id.includes(filter)) : MUTATIONS;

if (listOnly) {
  for (const m of chosen) process.stdout.write(`  ${m.id.padEnd(22)} ${m.file}\n        ${m.what}\n`);
  process.exit(0);
}

if (chosen.length === 0) {
  process.stderr.write(`No mutation id contains ${filter}. Use --list.\n`);
  process.exit(2);
}

const dirty = git('status', '--porcelain').trim();
if (dirty) {
  // Restoring files is how this works, so it must never run where a restore
  // could eat somebody's uncommitted work.
  process.stderr.write(`Refusing to run against a dirty tree.\n${dirty}\n`);
  process.exit(2);
}

const results: { id: string; what: string; outcome: Outcome; detail: string }[] = [];

for (const m of chosen) {
  const abs = resolve(ROOT, m.file);
  const before = readFileSync(abs, 'utf8');
  const matches = before.split(m.find).length - 1;

  if (matches !== 1) {
    results.push({ id: m.id, what: m.what, outcome: 'ANCHOR', detail: `the anchor matched ${matches} times, not once` });
    process.stdout.write(`  ANCHOR    ${m.id}  (${matches} matches)\n`);
    continue;
  }

  writeFileSync(abs, before.replace(m.find, m.into), 'utf8');
  let outcome: Outcome = 'SURVIVED';
  let detail = '';
  try {
    const run = spawnSync('npx', ['vitest', 'run', ...m.tests], {
      cwd: ROOT,
      encoding: 'utf8',
      shell: true,
      timeout: 15 * 60 * 1000,
    });
    const out = `${run.stdout ?? ''}${run.stderr ?? ''}`;
    detail = (out.match(/Tests\s+[^\n]+/) ?? [''])[0]!.trim();
    if (/Tests\s+\d+ failed/.test(out) || /Test Files\s+\d+ failed/.test(out)) outcome = 'CAUGHT';
    // A mutation that will not build is not evidence about the suite either
    // way, so it is reported rather than counted as a catch.
    else if (/error TS|Cannot find|SyntaxError|Transform failed/.test(out)) {
      outcome = 'BROKEN';
      detail = 'the mutated file did not build';
    }
  } finally {
    git('checkout', '--', m.file);
  }
  results.push({ id: m.id, what: m.what, outcome, detail });
  process.stdout.write(`  ${outcome.padEnd(10)}${m.id}  ${detail}\n`);
}

const after = git('status', '--porcelain').trim();
if (after) {
  process.stderr.write(`\nThe tree is not clean after the run, which needs looking at:\n${after}\n`);
  process.exit(3);
}

const survived = results.filter((r) => r.outcome === 'SURVIVED');
const inconclusive = results.filter((r) => r.outcome === 'ANCHOR' || r.outcome === 'BROKEN');
process.stdout.write(`\n${results.filter((r) => r.outcome === 'CAUGHT').length} of ${results.length} caught\n`);
if (survived.length > 0) {
  process.stdout.write('\nSurvived, so these fixes have no regression cover:\n');
  for (const r of survived) process.stdout.write(`  ${r.id}: ${r.what}\n`);
}
if (inconclusive.length > 0) {
  process.stdout.write('\nInconclusive, so the mutation itself needs attention:\n');
  for (const r of inconclusive) process.stdout.write(`  ${r.id}: ${r.detail}\n`);
}
process.exit(survived.length > 0 ? 1 : 0);
