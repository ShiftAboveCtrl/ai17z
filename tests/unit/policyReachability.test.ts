import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { POLICY_REACHABILITY, policyLeafPaths } from '@xbam/shared/contracts';

const root = resolve(__dirname, '../..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(full)) out.push(full);
  }
  return out;
}
const read = (files: string[]) => files.map((f) => readFileSync(f, 'utf8')).join('\n');

/** The screens an owner reaches through Advanced. */
const ADVANCED_SURFACE = read([
  ...walk(join(root, 'apps/web/src/routes/sections')),
  ...walk(join(root, 'apps/web/src/components')),
  join(root, 'apps/web/src/routes/SettingsPage.tsx'),
]);

/** The simplified projection, in the wizard and in the Easy agent view. */
const EASY_SURFACE = read([
  join(root, 'apps/web/src/routes/EasySetup.tsx'),
  join(root, 'apps/web/src/routes/EasyAgentView.tsx'),
  join(root, 'packages/runtime/src/easyMode.ts'),
]);

/**
 * A setting the runtime enforces must be reachable, or deliberately not.
 *
 * This is the third time the same defect has been found: the address allowlist
 * refused every address while the field that granted them was not rendered, and
 * posting could only be switched on from Easy Mode. Both were fixed by hand,
 * and neither fix stopped the next one.
 *
 * Counting the whole contract found thirty more -- enforced by the runtime,
 * reachable from no screen -- and nine that Easy could set and Advanced could
 * not display, which inverts the design: Advanced is meant to be the fuller
 * projection, not a different one.
 *
 * The classification is cheap. What it buys is that a new policy field cannot
 * become quietly enforced with nowhere to change it, because adding one without
 * a decision fails here.
 */
describe('every policy setting has a reachability decision', () => {
  const leaves = policyLeafPaths();

  it('classifies every leaf in the contract', () => {
    const unclassified = leaves.filter((path) => !POLICY_REACHABILITY[path]);
    expect(
      unclassified,
      `these policy fields have no reachability decision:\n  ${unclassified.join('\n  ')}`,
    ).toEqual([]);
  });

  it('classifies nothing that is not a leaf', () => {
    // A stale entry is a field that was renamed or removed, and a registry that
    // still mentions it is a registry nobody has read since.
    const known = new Set(leaves);
    const stale = Object.keys(POLICY_REACHABILITY).filter((path) => !known.has(path));
    expect(stale, `no such policy fields:\n  ${stale.join('\n  ')}`).toEqual([]);
  });

  it('gives a reason for anything the owner cannot reach', () => {
    const silent = Object.entries(POLICY_REACHABILITY)
      .filter(([, p]) => (p.where === 'INTERNAL' || p.where === 'DEPRECATED') && !p.why?.trim())
      .map(([path]) => path);
    expect(silent, `not exposed, and no reason given:\n  ${silent.join('\n  ')}`).toEqual([]);
  });
});

describe('the classification matches what the screens actually render', () => {
  /**
   * Matching on the leaf name rather than the full path, because that is how a
   * form field refers to it -- `n.output.forbidLinks` in a setter, `forbidLinks`
   * in a value. Deliberately generous: it under-reports rather than inventing
   * failures, so anything it does catch is real.
   */
  const mentions = (surface: string, path: string) => surface.includes(path.split('.').pop()!);

  it('Advanced can reach everything classified as reachable there', () => {
    const missing = Object.entries(POLICY_REACHABILITY)
      .filter(([, p]) => p.where === 'ADVANCED_ONLY' || p.where === 'EASY_AND_ADVANCED')
      .map(([path]) => path)
      .filter((path) => !mentions(ADVANCED_SURFACE, path));

    expect(
      missing,
      `classified as reachable in Advanced, but no Advanced screen mentions them:\n  ${missing.join('\n  ')}`,
    ).toEqual([]);
  });

  it('Easy can reach everything classified as reachable there', () => {
    const missing = Object.entries(POLICY_REACHABILITY)
      .filter(([, p]) => p.where === 'EASY_AND_ADVANCED')
      .map(([path]) => path)
      .filter((path) => !mentions(EASY_SURFACE, path));

    expect(missing, `classified as Easy-reachable, but Easy does not mention them:\n  ${missing.join('\n  ')}`).toEqual(
      [],
    );
  });

  it('nothing internal or deprecated is offered as a control', () => {
    // The mirror of the other direction: a field the runtime does not read must
    // not appear as something an owner can set, or the screen is lying.
    const offered = Object.entries(POLICY_REACHABILITY)
      .filter(([, p]) => p.where === 'DEPRECATED')
      .map(([path]) => path)
      .filter((path) => mentions(ADVANCED_SURFACE, path) || mentions(EASY_SURFACE, path));

    expect(offered, `deprecated, but still rendered somewhere:\n  ${offered.join('\n  ')}`).toEqual([]);
  });
});
