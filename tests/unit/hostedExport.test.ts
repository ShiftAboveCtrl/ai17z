import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENT_PACKAGE_EXTENSION, RUNTIME_STATES, type RuntimeState } from '@xbam/shared/contracts';
import {
  HOSTED_EXPORT_CARRIES,
  HOSTED_EXPORT_OMITS,
  exportFilename,
  mayExport,
  moveWarnings,
} from '@xbam/runtime';

/**
 * Taking a hosted agent out.
 *
 * AI17Z is local-first, so hosting owes an owner a way out, and the test that
 * matters is that export survives everything short of deletion: a lapsed
 * subscription, a suspension, being parked. Being able to leave is the reason
 * state was kept when somebody stopped paying.
 */

const ask = (state: RuntimeState, over: { mode?: 'SHARE' | 'MOVE'; hasVerifiedBackup?: boolean } = {}) =>
  mayExport({ state, mode: over.mode ?? 'MOVE', hasVerifiedBackup: over.hasVerifiedBackup ?? true });

describe('export outlives the right to act', () => {
  it('allows it from every state where anything is left', () => {
    for (const state of RUNTIME_STATES.filter(
      (s) => !['DELETED', 'PROVISIONING', 'MIGRATING'].includes(s),
    )) {
      expect(ask(state as RuntimeState).ok, state).toBe(true);
    }
  });

  it('allows it from a suspended or parked agent in particular', () => {
    for (const state of ['SUSPENDED', 'RETAINED', 'DELETION_SCHEDULED'] as const) {
      const out = ask(state);
      expect(out.ok, state).toBe(true);
      if (!out.ok) continue;
      // And says plainly that nothing was lost.
      expect(out.detail).toContain('nothing was lost');
    }
  });

  it('refuses only what genuinely cannot be exported', () => {
    expect(ask('DELETED').ok).toBe(false);
    expect(ask('PROVISIONING').ok).toBe(false);
    expect(ask('MIGRATING').ok).toBe(false);
  });

  it('explains a half-built agent rather than producing one', () => {
    const out = ask('PROVISIONING');
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusal).toBe('RUNTIME_PROVISIONING');
    expect(out.detail).toContain('half-built');
  });

  it('needs a verified backup when the host has stopped answering', () => {
    // A host that cannot be asked for live state leaves a backup as the only
    // honest source, and an unverified one would invent a partial agent.
    for (const state of ['HOST_UNREACHABLE', 'FAILED'] as const) {
      const without = ask(state, { hasVerifiedBackup: false });
      expect(without.ok, state).toBe(false);
      if (without.ok) continue;
      expect(without.refusal).toBe('NO_VERIFIED_BACKUP');
      expect(ask(state, { hasVerifiedBackup: true }).ok, state).toBe(true);
    }
  });
});

describe('what honestly travels', () => {
  it('carries the durable agent', () => {
    // `relationships` and `beliefs` were in this list and should never have
    // been: the exporter reads memories and nothing else, so asserting they
    // travelled pinned a false claim in place.
    const all = HOSTED_EXPORT_CARRIES.join(' ').toLowerCase();
    for (const thing of ['identity', 'memories', 'knowledge', 'goals', 'learning']) {
      expect(all, thing).toContain(thing);
    }
  });

  it('says what does not travel, and why, rather than omitting it silently', () => {
    // The absences are the interesting half: an owner deciding whether to
    // move needs to know beforehand, not afterwards.
    expect(HOSTED_EXPORT_OMITS.length).toBeGreaterThanOrEqual(4);
    for (const omission of HOSTED_EXPORT_OMITS) {
      expect(omission.why.length, omission.what).toBeGreaterThan(40);
    }
  });

  it('is honest that a browser session does not move', () => {
    // AI17Z already measured that profile seeding does not carry a login on
    // Windows. Pretending otherwise hands somebody a package that looks
    // complete and signs them out the first time they use it.
    const browser = HOSTED_EXPORT_OMITS.find((o) => /browser|chrome/i.test(o.what));
    expect(browser).toBeTruthy();
    expect(browser!.why.toLowerCase()).toContain('sign in again');
  });

  it('does not carry wallet keys or the runtime key', () => {
    const omitted = HOSTED_EXPORT_OMITS.map((o) => o.what.toLowerCase()).join(' ');
    expect(omitted).toContain('wallet');
    expect(omitted).toContain('runtime master key');
    // And the carried list must not contradict that.
    const carried = HOSTED_EXPORT_CARRIES.join(' ').toLowerCase();
    expect(carried).not.toContain('wallet');
    expect(carried).not.toContain('master key');
    expect(carried).not.toContain('api key');
  });
});

describe('the file an owner gets', () => {
  it('uses the same extension as a local package, so any installation reads it', () => {
    // An export only another hosted runtime could open would be lock-in
    // dressed as a feature.
    const name = exportFilename({ agentName: 'Shift', mode: 'MOVE', at: new Date('2026-10-04T00:00:00Z') });
    expect(name.endsWith(AGENT_PACKAGE_EXTENSION)).toBe(true);
    expect(name).toBe(`Shift-move-2026-10-04${AGENT_PACKAGE_EXTENSION}`);
  });

  it('makes an awkward agent name into a safe filename', () => {
    const name = exportFilename({ agentName: 'Shift // Above  Ctrl!', mode: 'SHARE', at: new Date('2026-10-04T00:00:00Z') });
    expect(name).toBe(`Shift-Above-Ctrl-share-2026-10-04${AGENT_PACKAGE_EXTENSION}`);
    // No empty path segment, no doubled separator, nothing a shell would eat.
    expect(name).not.toContain('//');
    expect(name).not.toContain(' ');
  });

  it('still produces a filename for a name with nothing usable in it', () => {
    const name = exportFilename({ agentName: '///', mode: 'MOVE', at: new Date('2026-10-04T00:00:00Z') });
    expect(name).toBe(`agent-move-2026-10-04${AGENT_PACKAGE_EXTENSION}`);
  });

  it('bounds a very long name', () => {
    const name = exportFilename({ agentName: 'x'.repeat(500), mode: 'MOVE' });
    expect(name.length).toBeLessThan(120);
  });
});

describe('what an owner is told before moving', () => {
  it('leads with what they keep and then what they will have to redo', () => {
    const warnings = moveWarnings();
    expect(warnings[0]!.toLowerCase()).toContain('keeps');
    const all = warnings.join(' ').toLowerCase();
    expect(all).toContain('sign in to any connected account again');
    expect(all).toContain('provider api keys are not carried');
    expect(all).toContain('wallet keys are not carried');
  });

  it('tells them it is one portable document rather than a hosted artefact', () => {
    expect(moveWarnings().join(' ')).toContain(AGENT_PACKAGE_EXTENSION);
  });
});

describe('what it says travels is what travels', () => {
  const EXPORTER = readFileSync(
    join(__dirname, '..', '..', 'packages', 'runtime', 'src', 'agentPackage.ts'),
    'utf8',
  );

  it('does not claim to carry relationships or stances', () => {
    /*
      It did, and that was a false statement about where a list of everyone the
      agent has spoken to ends up. `readLearned` selects from `memories` and
      nothing else, on purpose.
    */
    const claims = HOSTED_EXPORT_CARRIES.join(' ').toLowerCase();
    expect(claims).not.toContain('relationship');
    expect(claims).not.toContain('stance');
  });

  it('names them among what is left behind, in every mode', () => {
    const omitted = HOSTED_EXPORT_OMITS.find((o) => /relationship/i.test(o.what));
    expect(omitted).toBeDefined();
    expect(omitted!.what.toLowerCase()).toContain('every mode');
  });

  it('agrees with the exporter, which reads memories and nothing else', () => {
    // The claim is about a file, so the file is what it is checked against. A
    // list that only agrees with somebody's memory of the exporter is the
    // thing that drifted in the first place.
    const learned = EXPORTER.slice(EXPORTER.indexOf('async function readLearned'));
    const body = learned.slice(0, learned.indexOf(NL + '}'));
    expect(body).toContain('FROM memories');
    for (const table of ['FROM relationships', 'FROM stances', 'FROM agent_stances']) {
      expect(body, table).not.toContain(table);
    }
  });

  it('still says memories travel, because they do', () => {
    expect(HOSTED_EXPORT_CARRIES.join(' ')).toContain('Memories');
  });
});

const NL = String.fromCharCode(10);
