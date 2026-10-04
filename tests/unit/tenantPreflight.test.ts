import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { connectionIsIsolated, tenantDatabasePlan, tenantRoleName } from '@xbam/runtime';

/**
 * The check at the moment a tenant runtime starts.
 *
 * Read as source, because what matters about this tool is what it does not do:
 * it has no default runtime id, it prints no key, and it refuses rather than
 * warning. None of those can be proved by calling a process that exits.
 *
 * The logic it enforces is `tenantDatabase.ts` and is tested there. What is
 * pinned here is that the tool actually asks.
 */

const SOURCE = readFileSync(join(__dirname, '..', '..', 'tools', 'tenant-preflight.mts'), 'utf8');

describe('it does not guess which runtime it is checking', () => {
  it('has no default runtime id', () => {
    // A preflight that guessed would pass for the wrong runtime, which is
    // worse than not running.
    expect(SOURCE).toContain('AI17Z_RUNTIME_ID');
    expect(SOURCE).toContain('There is deliberately no default');
    expect(SOURCE).not.toMatch(/AI17Z_RUNTIME_ID[^;]*\?\?\s*['"][^'"]+['"]/);
  });

  it('exits with its own code rather than carrying on', () => {
    expect(SOURCE).toContain('process.exit(2)');
  });
});

describe('it never prints a key', () => {
  it('compares a fingerprint rather than a value', () => {
    expect(SOURCE).toContain('createHash');
    const fingerprint = SOURCE.slice(SOURCE.indexOf('function masterKeyFingerprint'));
    const body = fingerprint.slice(0, fingerprint.indexOf('\n}'));
    // The key is read, digested and dropped. Nothing returns or logs the raw
    // value, which is the only reason this function can exist at all.
    expect(body).toContain('digest(');
    expect(body).not.toMatch(/process\.stdout|log\.|console\./);
  });

  it('reads the pre-rename variable as well, so a sealed secret stays readable', () => {
    // The master key fallback is one of the rules the rename depends on.
    expect(SOURCE).toContain('XBAM_MASTER_KEY');
  });

  it('does not claim to have checked that the key is unique', () => {
    /*
      It did. It asked this database whether another runtime had recorded a
      different fingerprint, and passed either way: nothing writes that
      setting, and a tenant has its own database, so another tenant's key
      could not have been there regardless. A check that reads as
      verification and verifies nothing is the thing this file is for.
    */
    expect(SOURCE).toContain('cannot be checked from inside a tenant');
    expect(SOURCE).toContain("control plane's guarantee");
    expect(SOURCE).not.toContain('runtime.key.fingerprint');
  });

  it('catches the one mistake a tenant can see, and reports UNAVAILABLE without it', () => {
    expect(SOURCE).toContain('AI17Z_SHARED_KEY_FINGERPRINT');
    expect(SOURCE).toContain('one compromise is every compromise');
  });
});

describe('what it refuses', () => {
  it('asks the four questions', () => {
    for (const check of ['Its own database', 'Its own master key', 'The server agrees', 'Allowed to act']) {
      expect(SOURCE, check).toContain(check);
    }
  });

  it('says a check that could not run is not a check that passed', () => {
    expect(SOURCE).toContain('not the same as passing');
  });

  it('refuses a shared database by the rule rather than by a sentence of its own', () => {
    // The refusal comes from connectionIsIsolated, so there is one answer to
    // "is this database mine" rather than one here and one there.
    expect(SOURCE).toContain('connectionIsIsolated');
    const plan = tenantDatabasePlan('rt-alpha');
    const out = connectionIsIsolated(`postgres://${plan.role}:secret@h:5432/xbam`, plan);
    expect(out.ok).toBe(false);
  });

  it('reads the server rather than the intention', () => {
    expect(SOURCE).toContain('observedIsolationProblems');
    expect(SOURCE).toContain('pg_roles');
  });

  it('derives the role name rather than reading one from configuration', () => {
    expect(SOURCE).toContain('tenantDatabasePlan');
    // The name in a refusal is the derived one, so a misconfigured value
    // cannot make the message agree with itself.
    expect(tenantRoleName('rt-alpha')).toMatch(/^ai17z_r_/);
  });
});
