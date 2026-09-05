import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const packager = readFileSync(resolve(root, 'tools/package-windows.mts'), 'utf8');
const start = readFileSync(resolve(root, 'start-ai17z.ps1'), 'utf8');
const template = readFileSync(resolve(root, '.env.example'), 'utf8');

/**
 * The first thing a new installation did was crash.
 *
 * `start-ai17z.ps1` builds its `.env` from `.env.example`, and the packager's
 * filter refused every path matching `^\.env` -- which is right for a real
 * environment file and wrong for the template. So the installer shipped without
 * it, and a fresh install failed on `Copy-Item '.env.example'` naming a path
 * nobody could be expected to find.
 *
 * Two properties, and they pull in opposite directions, which is why both are
 * here: the template must ship, and nothing else beginning with `.env` ever may.
 */
describe('the installer ships the environment template', () => {
  it('lists it as an input', () => {
    expect(packager).toMatch(/'\.env\.example',/);
  });

  it('lets it through the filter that refuses environment files', () => {
    expect(packager).toContain("name.toLowerCase() === '.env.example'");
    // And the refusal it is an exception to is still there.
    expect(packager).toMatch(/\/\^\\\.env\(\\\..\*\)\?\$\/i\.test\(name\)/);
  });

  it('still refuses a real one', () => {
    // The allow is for one exact filename, not a prefix. `.env.local` and
    // `.env.production` carry real values and must stay out.
    const allow = packager.slice(packager.indexOf("name.toLowerCase() ==="), packager.indexOf('.tsbuildinfo'));
    expect(allow).not.toMatch(/startsWith\('\.env'\)/);
    expect(allow).not.toMatch(/includes\('\.env'\)/);
  });
});

/**
 * The template is the one environment file with no secret in it. That has to
 * stay true, because it is now shipped to every installation.
 */
describe('the template carries no secret', () => {
  it('leaves the master key empty', () => {
    expect(template).toMatch(/^AI17Z_MASTER_KEY=\s*$/m);
  });

  it('has no value that looks like a credential', () => {
    for (const line of template.split(/\r?\n/)) {
      if (!line.includes('=') || line.trim().startsWith('#')) continue;
      const value = line.slice(line.indexOf('=') + 1).trim();
      expect(value, line).not.toMatch(/^sk-[A-Za-z0-9]{16,}/);
      expect(value, line).not.toMatch(/^[A-Za-z0-9+/]{40,}={0,2}$/);
    }
  });
});

/**
 * Where the environment file lives, which decides whether an upgrade can lose
 * somebody's provider credentials.
 *
 * It holds the master key every credential is sealed with. The launcher has
 * always set AI17Z_ENV_FILE to a path inside the owner's data directory --
 * and nothing read it, so the file was quietly created beside the program
 * instead, in the directory an upgrade replaces and the uninstaller removes.
 * The uninstall prompt meanwhile tells people their data folder holds "the key
 * your provider credentials are encrypted with", which was not true.
 */
describe('the environment file follows the data, not the program', () => {
  it('is resolved from the launcher variable before anything else', () => {
    expect(start).toContain('$env:AI17Z_ENV_FILE');
    expect(start).toContain('$env:XBAM_ENV_FILE');
  });

  it('falls back to the script directory, so a clone still works', () => {
    expect(start).toMatch(/\$EnvFile = Join-Path \$PSScriptRoot '\.env'/);
  });

  it('never reads a bare .env by relative path any more', () => {
    // `Set-Location $PSScriptRoot` runs at the top, so every relative '.env'
    // in this script meant the program directory.
    expect(start).not.toMatch(/Test-Path '\.env'/);
    expect(start).not.toMatch(/Get-Content '\.env'/);
    expect(start).not.toMatch(/Copy-Item '\.env\.example' '\.env'/);
  });

  it('moves an older installation file rather than starting a second one', () => {
    // Two environment files means two master keys, and the second cannot read
    // what the first sealed.
    expect(start).toContain('Move-Item');
    expect(start).toMatch(/Moving your existing \.env/);
  });

  it('generates the master key from the cryptographic RNG', () => {
    // Get-Random is seeded and is not for anything that has to be unguessable.
    expect(start).toContain('System.Security.Cryptography.RandomNumberGenerator');
    expect(start).not.toMatch(/Get-Random -Maximum 256/);
  });
});

/**
 * docker-compose.yml takes the project name from the environment file:
 * `name: ${AI17Z_INSTANCE:-xbam}`. A compose command that does not carry the
 * file resolves that to the default and acts on a different project than the
 * one that was started -- so a stop reports success and leaves the containers
 * running.
 */
describe('every compose command carries the environment file', () => {
  const scripts = ['start-ai17z.ps1', 'stop-ai17z.ps1', 'update-ai17z.ps1'];

  it.each(scripts)('%s passes --env-file', (name) => {
    const text = readFileSync(resolve(root, name), 'utf8');
    expect(text).toContain("'--env-file'");
  });

  it.each(scripts)('%s has no bare compose invocation left', (name) => {
    const text = readFileSync(resolve(root, name), 'utf8');
    expect(text).not.toMatch(/@\('compose',\s*'(up|down|build|ps)'/);
  });

  it('the uninstaller stop does too, or it stops the wrong project', () => {
    const text = readFileSync(resolve(root, 'packaging/windows/Stop-ForUninstall.ps1'), 'utf8');
    expect(text).toContain('--env-file');
  });
});
