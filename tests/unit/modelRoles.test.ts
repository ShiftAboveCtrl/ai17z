import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ACTIVE_MODEL_ROLES, MODEL_ROLES, MODEL_ROLE_STATUS, RESERVED_MODEL_ROLES } from '@xbam/shared/contracts';
import type { ModelRole } from '@xbam/shared/contracts';

const root = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

const intelligence = read('apps/web/src/routes/sections/IntelligenceSection.tsx');

/** The roles the screen actually offers, read out of its own list. */
const offered = [...intelligence.matchAll(/role: '([a-z_0-9]+)'/g)].map((m) => m[1] as ModelRole);

/**
 * A role nothing can set is a capability the product does not have.
 *
 * This has gone wrong in both directions. `vision` was asked for on every image
 * and had no row on the Intelligence screen, so every agent read pictures with
 * nothing configured and honestly reported that it could not see them.
 * `transcription` and `critic` went the other way: in the enum since migration
 * 0026, wired to nothing, and noticed only by counting rows against enum
 * members.
 */
describe('model roles and what can set them', () => {
  it('says what every role is', () => {
    for (const role of MODEL_ROLES) {
      expect(MODEL_ROLE_STATUS[role], role).toBeDefined();
    }
    expect(Object.keys(MODEL_ROLE_STATUS).sort()).toEqual([...MODEL_ROLES].sort());
  });

  it('gives a reason for anything it does not offer', () => {
    // "Unused" is not a reason. The next person has to be able to tell a role
    // that is waiting for a feature from one that was forgotten.
    for (const role of MODEL_ROLES) {
      const facts = MODEL_ROLE_STATUS[role];
      if (facts.status === 'ACTIVE') continue;
      expect(facts.why, role).toBeTruthy();
      expect((facts.why ?? '').length, role).toBeGreaterThan(40);
    }
  });

  it('offers a row for every active role', () => {
    for (const role of ACTIVE_MODEL_ROLES) {
      expect(offered, role).toContain(role);
    }
  });

  it('offers no row for a role that is wired to nothing', () => {
    // The fix for a missing row is never to add rows until the counts match.
    expect(RESERVED_MODEL_ROLES.sort()).toEqual(['critic', 'transcription']);
    for (const role of RESERVED_MODEL_ROLES) {
      expect(offered, role).not.toContain(role);
    }
  });

  it('has a row for every role the runtime asks for', () => {
    /*
      The check that would have caught `vision`. Each of these is a role some
      step requests by name; a role the runtime asks for and nobody can set is
      a silent gap, not a missing feature.
    */
    const asked: { role: ModelRole; where: string }[] = [
      { role: 'vision', where: 'packages/runtime/src/steps/context.ts' },
      { role: 'classifier', where: 'packages/runtime/src/research.ts' },
      { role: 'voice_rewrite', where: 'packages/runtime/src/voice.ts' },
      { role: 'primary', where: 'packages/models/src/gateway.ts' },
      { role: 'fallback_1', where: 'packages/models/src/gateway.ts' },
      { role: 'fallback_2', where: 'packages/models/src/gateway.ts' },
    ];
    for (const { role, where } of asked) {
      expect(MODEL_ROLE_STATUS[role].status, `${role} is asked for in ${where}`).toBe('ACTIVE');
      expect(offered, role).toContain(role);
    }
  });

  it('finds no runtime consumer for the reserved roles', () => {
    // If one appears, the role has become real and its status is now a lie.
    for (const file of [
      'packages/runtime/src/steps/context.ts',
      'packages/runtime/src/steps/generate.ts',
      'packages/runtime/src/steps/execute.ts',
      'packages/runtime/src/steps/social.ts',
      'packages/runtime/src/steps/research.ts',
      'packages/runtime/src/voice.ts',
      'packages/models/src/gateway.ts',
    ]) {
      const source = read(file);
      for (const role of RESERVED_MODEL_ROLES) {
        expect(source, `${role} in ${file}`).not.toContain(`'${role}'`);
      }
    }
  });
});
