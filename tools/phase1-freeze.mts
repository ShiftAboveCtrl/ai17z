#!/usr/bin/env tsx
/**
 * Freezes the Phase 1 contracts, and checks they have not moved since.
 *
 *   npm run phase1:freeze -- --write     record the current shapes
 *   npm run phase1:freeze                check nothing has moved
 *
 * A freeze that is a sentence in a document is a freeze nobody can break and
 * nobody can keep. This hashes each frozen surface, so changing one is a
 * failing check rather than something somebody notices later.
 *
 * ## What is frozen is the surface, not the file
 *
 * Hashing a whole file would make a comment a contract change, which teaches
 * people to stop reading the check. So each entry extracts the thing that is
 * actually a contract: the exported names, the schema fields, the enum values,
 * the migration list. A rewritten comment passes; a renamed field does not.
 *
 * ## The status this freeze carries
 *
 * `CANDIDATE_WITH_HARDWARE_CANARY_PENDING`, and not anything stronger. No
 * confidential VM has been provisioned, so the attestation and key-release
 * contracts are frozen as a design that has never met the hardware it is
 * about. Calling that "production confidential proven" would be the exact
 * substitution the whole architecture is arranged to prevent.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = process.cwd();
const MANIFEST = join(ROOT, 'docs', 'architecture', 'PHASE1_FREEZE.json');
const writing = process.argv.includes('--write');

/** The one status this freeze may carry while no hardware has been met. */
export const FREEZE_STATUS = 'CANDIDATE_WITH_HARDWARE_CANARY_PENDING';

const read = (rel: string): string => (existsSync(join(ROOT, rel)) ? readFileSync(join(ROOT, rel), 'utf8') : '');
const digest = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 16);

/**
 * Every exported name in a module, sorted.
 *
 * The surface rather than the implementation: an export renamed or removed is
 * a contract change, and a function body rewritten is not.
 */
function exportsOf(rel: string): string {
  const source = read(rel);
  if (!source) return 'MISSING';
  const names = [...source.matchAll(/^export (?:const|function|interface|type|class|enum|async function) (\w+)/gm)].map((m) => m[1]!);
  return names.sort().join(',');
}

/**
 * The field names of a zod object, sorted.
 *
 * A schema is a wire contract, so its field names are the thing that cannot
 * move without something on the other side breaking.
 */
function schemaFieldsOf(rel: string, schemaName: string): string {
  const source = read(rel);
  if (!source) return 'MISSING';
  const at = source.indexOf(`export const ${schemaName}`);
  if (at < 0) return 'ABSENT';
  // To the closing `.strict()` or the end of the declaration, whichever comes
  // first. Field names only, so reordering them is not a change and renaming
  // one is.
  const tail = source.slice(at, at + 4000);
  const fields = [...tail.matchAll(/^\s{4}(\w+):/gm)].map((m) => m[1]!);
  return fields.sort().join(',');
}

/** The members of a `const X = [...] as const` list, in order, because order can matter. */
function listOf(rel: string, name: string): string {
  const source = read(rel);
  if (!source) return 'MISSING';
  const match = new RegExp(`export const ${name}\\s*=\\s*\\[([^\\]]*)\\]`, 's').exec(source);
  if (!match) return 'ABSENT';
  return [...match[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!).join(',');
}

interface FrozenEntry {
  what: string;
  /** Why this is a contract rather than an implementation detail. */
  why: string;
  value: string;
  /**
   * The surface itself, as the comma-separated names it is made of.
   *
   * Stored rather than only hashed, for two reasons. A mismatch can then say
   * which name moved instead of only that something did, and the manifest
   * becomes a readable record of what was frozen rather than a list of
   * digests nobody can check anything against.
   */
  surface: string;
}

/** One entry, with its surface kept beside its digest. */
function entry(what: string, why: string, surface: string): FrozenEntry {
  return { what, why, value: digest(surface), surface };
}

function frozen(): Record<string, FrozenEntry> {
  const migrations = existsSync(join(ROOT, 'migrations'))
    ? readdirSync(join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql')).sort()
    : [];

  return {
    migrations: entry(
      `${migrations.length} migrations, ${migrations[migrations.length - 1] ?? 'none'} last`,
      'An applied migration is never edited, so the list is append-only and a change to it is a change to every installed database.',
      migrations.join(','),
    ),
    hostProtocol: entry(
      'hostDaemon.ts exports',
      'What a host says about itself and what the control plane may ask it. A host running an older build speaks this.',
      exportsOf('packages/runtime/src/hostDaemon.ts'),
    ),
    runtimeProtocol: entry(
      'microVm.ts exports',
      'How a guest is described and launched. A plan rendered by one version and booted by another has to agree.',
      exportsOf('packages/runtime/src/microVm.ts'),
    ),
    gatewayAuth: entry(
      'tenantGateway.ts exports',
      'How a browser is mapped to an entitled runtime. Changing it changes who can reach whom.',
      exportsOf('packages/runtime/src/tenantGateway.ts'),
    ),
    browserStream: entry(
      'screencast exports',
      'The frames an owner watches and the bounds on them.',
      exportsOf('packages/browser/src/screencast.ts'),
    ),
    backupFormat: entry(
      'backupStoreFs.ts and backupStoreObject.ts exports',
      'A backup written by one version is restored by another, possibly years later.',
      `${exportsOf('packages/runtime/src/backupStoreFs.ts')}|${exportsOf('packages/runtime/src/backupStoreObject.ts')}`,
    ),
    attestationPolicy: entry(
      'AzureAttestationClaims and ConfidentialSpaceClaims fields',
      'The claims a release policy asserts. A field renamed here is a policy that stops matching real tokens.',
      `${schemaFieldsOf('packages/shared/src/contracts/confidential.ts', 'AzureAttestationClaims')}|` +
        `${schemaFieldsOf('packages/shared/src/contracts/confidential.ts', 'ConfidentialSpaceClaims')}`,
    ),
    keyRelease: entry(
      'confidentialProvider.ts and hostedSecrets.ts exports',
      'How a key reaches an attested runtime and what custody it is under.',
      `${exportsOf('packages/runtime/src/confidentialProvider.ts')}|${exportsOf('packages/runtime/src/hostedSecrets.ts')}`,
    ),
    tradeIntent: entry(
      'TradeIntent fields and the venue list',
      'A durable row that exists before any signing boundary. A field renamed orphans every intent already written down.',
      `${schemaFieldsOf('packages/shared/src/contracts/trading.ts', 'TradeIntent')}|${listOf('packages/shared/src/contracts/trading.ts', 'TRADE_VENUE_IDS')}`,
    ),
    mandate: entry(
      'TradeMandate fields',
      "The owner's own limits. A model may never widen them and a version change must not either.",
      schemaFieldsOf('packages/shared/src/contracts/trading.ts', 'TradeMandate'),
    ),
    marketSnapshot: entry(
      'MarketSnapshot fields',
      'What a venue reported, stored on the intent it priced. A private adapter on the other side of this returns exactly these.',
      schemaFieldsOf('packages/shared/src/contracts/trading.ts', 'MarketSnapshot'),
    ),
    financialJournal: entry(
      'tradeExecution.ts exports',
      'What is recorded before a submission and reconciled after one. This is the thing that stops a trade becoming two.',
      exportsOf('packages/runtime/src/tradeExecution.ts'),
    ),
    costModel: entry(
      'the cost lines and the confidential SKU list',
      'A closed list, so a new cost cannot be added without appearing in it, and prices that carry their own dates.',
      `${listOf('packages/runtime/src/hostedCost.ts', 'COST_LINES')}|${exportsOf('packages/runtime/src/confidentialSkus.ts')}`,
    ),
    resourceEnvelope: entry(
      'tenantFootprint.ts exports and the measured figure',
      "What a plan is sized from. Changing the measurement changes every host's capacity, so it is a contract rather than a note.",
      exportsOf('packages/runtime/src/tenantFootprint.ts'),
    ),
    provisioningSteps: entry(
      'the two provisioning step lists',
      'The order is the design, and a resumed provision reads it. Reordering one changes what a half-finished tenant does next.',
      `${listOf('packages/runtime/src/tenantProvisioning.ts', 'PROVISIONING_STEP_NAMES')}|${exportsOf('packages/runtime/src/tenantProvisioning.ts')}`,
    ),
  };
}

/**
 * What changed between two surfaces, as names rather than as hashes.
 *
 * "Something moved" sends somebody to a diff; "these two fields were renamed"
 * tells them what happened. Both halves are reported, because a rename shows
 * up as one of each and reading only the additions would miss it.
 */
function difference(before: string, after: string): string {
  const was = new Set(before.split(/[,|]/).filter(Boolean));
  const now = new Set(after.split(/[,|]/).filter(Boolean));
  const added = [...now].filter((n) => !was.has(n));
  const removed = [...was].filter((n) => !now.has(n));
  if (added.length === 0 && removed.length === 0) return 'the surface changed in a way this check cannot name.';
  const parts = [];
  if (removed.length > 0) parts.push(`gone: ${removed.slice(0, 8).join(', ')}${removed.length > 8 ? ` and ${removed.length - 8} more` : ''}`);
  if (added.length > 0) parts.push(`new: ${added.slice(0, 8).join(', ')}${added.length > 8 ? ` and ${added.length - 8} more` : ''}`);
  return `${parts.join('; ')}.`;
}

/** The public core's own commit, recorded rather than computed, so a freeze names what it froze. */
function head(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

const entries = frozen();
const missing = Object.entries(entries).filter(([, e]) => e.value === digest('MISSING') || e.what.includes('none'));

if (writing) {
  const manifest = {
    status: FREEZE_STATUS,
    why: [
      'No confidential VM has been provisioned, so the attestation and key-release contracts are frozen as a design that has never met the hardware it is about.',
      'The private venue adapters are frozen against their public contracts, and none has read a real venue.',
      'Calling this production confidential proven would be the substitution the architecture exists to prevent.',
    ],
    frozenAt: new Date().toISOString(),
    publicCoreHead: head(),
    privatePluginHeads: {
      note: 'Recorded by whoever froze, from the private workspace. Not read from here: this repository must not know the path.',
    },
    contracts: entries,
  };
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  process.stdout.write(`Frozen ${Object.keys(entries).length} contracts as ${FREEZE_STATUS}.\n`);
  process.stdout.write(`  public core HEAD ${manifest.publicCoreHead.slice(0, 12)}\n`);
  if (missing.length > 0) process.stdout.write(`  ${missing.length} entr(ies) point at something absent, which is itself worth seeing.\n`);
  process.exit(0);
}

if (!existsSync(MANIFEST)) {
  process.stdout.write('Nothing is frozen yet. Run with --write once Phase 1 is complete.\n');
  process.exit(1);
}

const recorded = JSON.parse(readFileSync(MANIFEST, 'utf8')) as {
  status: string;
  publicCoreHead: string;
  contracts: Record<string, FrozenEntry>;
};

const moved: string[] = [];
for (const [name, entry] of Object.entries(entries)) {
  const was = recorded.contracts[name];
  if (!was) {
    moved.push(`${name} is new since the freeze.`);
    continue;
  }
  if (was.value !== entry.value) moved.push(`${name}: ${difference(was.surface ?? '', entry.surface)} ${was.why}`);
}
for (const name of Object.keys(recorded.contracts)) {
  if (!entries[name]) moved.push(`${name} was frozen and is gone.`);
}

process.stdout.write(`Phase 1 freeze: ${recorded.status}\n`);
process.stdout.write(`  frozen at ${recorded.publicCoreHead.slice(0, 12)}\n`);
if (moved.length === 0) {
  process.stdout.write(`  ${Object.keys(entries).length} contracts, none moved.\n`);
  process.exit(0);
}
process.stdout.write(`\n${moved.length} frozen contract(s) have moved:\n`);
for (const line of moved) process.stdout.write(`  - ${line}\n`);
process.stdout.write('\nEither this was intended, in which case re-freeze deliberately, or it was not.\n');
process.exit(1);
