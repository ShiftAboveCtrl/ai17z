import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decideUpdate, UPDATER_GATE_SCHEMA, INSTALL_LAYOUT_SCHEMA } from '@xbam/shared';
import type { GateUnavailable } from '@xbam/shared';

/**
 * "The gate said nothing" means two completely different things.
 *
 * A release published before manifests existed, reaching an installation made
 * before the gate existed, has nothing to ask and nothing to ask it with.
 * Refusing there would strand exactly the installations an update exists to
 * move forward.
 *
 * A *current* installation whose gate did not answer is a different situation
 * entirely. Schema 3 ships the bridge, the runtime and the manifest; if one of
 * them is missing, corrupt, or crashed, something is wrong with this copy right
 * now -- and the next thing the updater does is stop a working installation and
 * replace it. Carrying on means finding out afterwards, which is the one
 * outcome the gate exists to prevent.
 *
 * This used to carry on in both cases. The two are now told apart by what the
 * installation records about itself, never by "the file is missing so it is
 * probably old" -- a missing file is the symptom they share.
 */

const root = resolve(__dirname, '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

const EVERY_WAY_IT_CAN_FAIL: GateUnavailable[] = [
  'no-manifest',
  'no-bridge',
  'no-runtime',
  'crashed',
  'unreadable',
];

describe('an update that could not be checked', () => {
  it('is part of the protocol from the schema that ships it', () => {
    // The gate needs three things, and schema 3 is the first layout that has
    // all of them. Tying the requirement to the schema rather than to a version
    // string is what lets an old installation be old rather than broken.
    expect(UPDATER_GATE_SCHEMA).toBe(3);
    expect(INSTALL_LAYOUT_SCHEMA).toBeGreaterThanOrEqual(UPDATER_GATE_SCHEMA);
  });

  describe('an installation from before the gate', () => {
    it.each([1, 2])('schema %i carries on, whatever went wrong', (schema) => {
      for (const why of EVERY_WAY_IT_CAN_FAIL) {
        const decision = decideUpdate({ installedSchema: schema, outcome: { kind: 'unavailable', why } });
        expect(decision.proceed, `${why} stopped a schema ${schema} installation`).toBe(true);
        expect(decision.gateRequired).toBe(false);
        // And says why, rather than saying nothing.
        expect(decision.reasons.join(' ')).toMatch(/predates/);
      }
    });

    it('no record at all is also from before the gate', () => {
      // An installation old enough to have no INSTALL_INFO.json is older than
      // every schema, which is the one thing that can be said about it.
      const decision = decideUpdate({ installedSchema: null, outcome: { kind: 'unavailable', why: 'no-bridge' } });
      expect(decision.proceed).toBe(true);
      expect(decision.gateRequired).toBe(false);
    });
  });

  describe('an installation the gate is part of', () => {
    it.each(EVERY_WAY_IT_CAN_FAIL)('refuses when the gate could not answer: %s', (why) => {
      const decision = decideUpdate({ installedSchema: UPDATER_GATE_SCHEMA, outcome: { kind: 'unavailable', why } });
      expect(decision.proceed).toBe(false);
      expect(decision.gateRequired).toBe(true);
      // The three things somebody needs: what happened, why it matters here,
      // and that nothing was taken away.
      const said = decision.reasons.join(' ');
      expect(said).toMatch(/could not check/i);
      expect(said).toMatch(/still installed and still running/i);
    });

    it('refuses on a future schema too', () => {
      // A schema newer than this code knows about is certainly not older than
      // the gate. Reading it as "not >= 3" would be the wrong way round.
      const decision = decideUpdate({ installedSchema: 99, outcome: { kind: 'unavailable', why: 'crashed' } });
      expect(decision.proceed).toBe(false);
    });

    it('allows an update the gate said yes to, notes and all', () => {
      const decision = decideUpdate({
        installedSchema: 3,
        outcome: { kind: 'allowed', notes: ['Google Chrome was not found.'] },
      });
      expect(decision.proceed).toBe(true);
      expect(decision.reasons).toEqual(['Google Chrome was not found.']);
    });

    it('refuses an update the gate said no to, and passes the reasons on', () => {
      const decision = decideUpdate({
        installedSchema: 3,
        outcome: { kind: 'refused', blockers: ['AI17Z 9.9.9 needs Docker 26.0.0 or newer. This is 25.0.0.'] },
      });
      expect(decision.proceed).toBe(false);
      expect(decision.reasons[0]).toContain('Docker');
    });
  });

  it('a verdict is never discarded because of the schema', () => {
    // The schema decides what silence means. It must not decide what a spoken
    // verdict means -- an old installation told NO is still told NO.
    for (const schema of [null, 1, 2, 3, 99]) {
      const refused = decideUpdate({ installedSchema: schema, outcome: { kind: 'refused', blockers: ['no'] } });
      expect(refused.proceed, `schema ${schema} ignored a refusal`).toBe(false);
      const allowed = decideUpdate({ installedSchema: schema, outcome: { kind: 'allowed', notes: [] } });
      expect(allowed.proceed, `schema ${schema} ignored an approval`).toBe(true);
    }
  });
});

describe('the updaters ask for that decision rather than making it', () => {
  const bridge = read('packaging/preflight.mts');
  const updaters = {
    ubuntu: read('packaging/ubuntu/ai17z-update.sh'),
    macos: read('packaging/macos/ai17z-update.sh'),
    windows: read('packaging/windows/Setup-AI17Z.ps1'),
  };

  it('the bridge can be asked what an unanswerable check means', () => {
    expect(bridge).toContain('--decide');
    expect(bridge).toContain('decideUpdate');
    // GO and NO, rather than reusing OK -- a caller must not be able to confuse
    // "the machine is compatible" with "carry on without knowing".
    expect(bridge).toMatch(/decision\.proceed \? 'GO' : 'NO'/);
  });

  it.each(Object.entries(updaters))('%s reads the schema it recorded about itself', (_name, script) => {
    // Not "the file is missing so it is probably old". The record is the fact
    // that separates an era from a fault.
    expect(script).toMatch(/INSTALL_INFO\.json/);
  });

  it.each(Object.entries(updaters))('%s asks the bridge what silence means', (_name, script) => {
    expect(script).toContain('--decide');
  });

  /**
   * The half of the protocol that could never run on two of the three platforms.
   *
   * The fail-open branch is Windows reasoning: there are Windows installations
   * made before the gate existed, and refusing those would strand exactly the
   * copies the gate exists to move forward. It was copied to macOS and Ubuntu,
   * where it means nothing -- the first release installable on either was Beta
   * 1.0.0 (17), and the gate shipped in it.
   *
   * And neither Unix installer writes `INSTALL_INFO.json`, so every installation
   * read as one that predates a check it actually carried. Proved against the
   * published package rather than reasoned about: installed the real `.deb` in a
   * container, and the file is not there. Handing the shared decision what that
   * installation would have said produced GO for every unavailable outcome;
   * handing it what this says produces NO:
   *
   *     --decide 3  crashed  -> NO      --decide 1  crashed  -> GO
   *     --decide 3  no-bridge-> NO      --decide 1  no-bridge-> GO
   */
  it('gives no Unix installation the benefit of a doubt it cannot have', () => {
    for (const platform of ['ubuntu', 'macos'] as const) {
      const updater = updaters[platform];
      // The branch that let it carry on is gone.
      expect(updater, `${platform} still excuses itself`).not.toContain(
        'This installation predates the compatibility check',
      );
      // And an absent record resolves to the schema the application carries,
      // read out of the shipped source rather than repeated in shell -- the
      // same way the Windows setup program reads the same constant.
      expect(updater).toContain('UPDATER_GATE_SCHEMA');
      expect(updater).toContain('packages/shared/src/releaseManifest.ts');
      // Neither a record nor the constant means the copy is not intact, and an
      // update is the wrong thing to attempt on one.
      expect(updater).toContain('could not tell which update protocol');
    }

    // Windows keeps it, and must: those installations really do exist.
    expect(updaters.windows).toContain('Get-Ai17zGateSchema');
  });

  it('no updater decides it for itself', () => {
    // Three copies of a rule is how one of them drifts, and the one that drifts
    // is the one nobody runs.
    for (const [name, script] of Object.entries(updaters)) {
      expect(script, `${name} has its own copy of the schema threshold`).not.toMatch(
        /UPDATER_GATE_SCHEMA\s*=|GATE_SCHEMA\s*=\s*3|-ge\s+3\b/,
      );
    }
  });
});
