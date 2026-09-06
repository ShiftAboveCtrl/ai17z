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
    // The last step of Resolve-Ai17zEnvFile. A clone has no launcher, no data
    // directory and no data-location.txt, and the .env beside the script is
    // what a developer expects.
    expect(start).toMatch(/return \(Join-Path \$Root '\.env'\)/);
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

/**
 * "Does the file exist" was the wrong question.
 *
 * The installer writes the ports somebody chose into the data directory's
 * `.env` before the launcher ever runs, so the file existed with three lines in
 * it. The launcher saw a file, decided there was nothing to do, and the
 * installation ran with no DATABASE_URL and no master key -- which surfaces
 * later and somewhere else, as a migration failing to connect to a database
 * nobody told it about.
 *
 * So the file is completed rather than created: every key the template defines
 * is filled in when missing, and anything already there is left exactly as it
 * was, because somebody who edited their .env did so on purpose.
 */
describe('the environment file is completed, not merely present', () => {
  it('reads the template whether or not the file already exists', () => {
    // The template load sits outside the `if (-not (Test-Path $EnvFile))`
    // block, which now does one thing only: move an older file into place.
    const legacy = start.indexOf('if (-not (Test-Path $EnvFile)) {');
    const template = start.indexOf("$template = Join-Path $PSScriptRoot '.env.example'");
    expect(template, 'the template is no longer loaded').toBeGreaterThan(-1);
    expect(start.slice(legacy, template)).toContain('Move-Item');
    expect(start.slice(legacy, template)).not.toContain('SaveStringToFile');
  });

  it('fills in each missing key rather than replacing the file', () => {
    expect(start).toContain('$added = @()');
    expect(start).toMatch(/if \(\$have\.ContainsKey\(\$key\)\) \{ continue \}/);
    // Appended to what is there. A rewrite would discard the ports.
    expect(start).toContain('$existing = $existing + $additions.ToString()');
  });

  it('decides the master key on the file contents, not the file existing', () => {
    expect(start).toMatch(/\$current -notmatch '\(\?m\)\^\[ \\t\]\*\(AI17Z\|XBAM\)_MASTER_KEY/);
  });

  it('does not let a key with no value read as a key', () => {
    // .NET's \s matches a newline, so `^\s*KEY\s*=\s*\S` was satisfied by
    // "AI17Z_MASTER_KEY=" running on into the first character of the next
    // line. The template ships that key empty, so this was every fresh
    // installation: no key generated, and the first provider credential
    // somebody stored failing much later with "AI17Z_MASTER_KEY is not set".
    for (const pattern of start.match(/'\(\?m\)[^']+'/g) ?? []) {
      expect(pattern, 'a multiline pattern that can cross lines').not.toMatch(/\\s\*/);
    }
  });

  it('completes the configuration before checking it', () => {
    // The port check reads the file. Running it first meant reading defaults
    // for everything the installer had not written, and -- worse -- asking
    // Docker about a project name that was not yet decided.
    expect(start.indexOf('$template = Join-Path')).toBeLessThan(start.indexOf('# -- Ports'));
  });
});

/**
 * One installation, one Docker project.
 *
 * `docker-compose.yml` reads `name: ${AI17Z_INSTANCE:-xbam}`, and every copy
 * left that unset. An installed AI17Z and a developer's checkout on one machine
 * were therefore the same project: `docker compose up` from the installed copy
 * adopted the checkout's containers, republished them on the installer's ports,
 * and pointed both at a single database volume. Docker had no reason to object;
 * from its side that is an ordinary recreate.
 *
 * Two guards, because they catch it at different moments: a copy that has never
 * had a database takes a name of its own, and any copy that finds containers
 * another directory started stops instead of taking them over.
 */
describe('one installation cannot adopt another one', () => {
  it('names the project after the data directory', () => {
    expect(start).toContain('AI17Z_INSTANCE=$instance');
    expect(start).toContain('Split-Path -Leaf $dataDir');
    // Docker will not take an uppercase project name.
    expect(start).toContain('.ToLowerInvariant()');
  });

  it('only does so where there is nothing to orphan', () => {
    // Renaming the project of a working installation points it at an empty
    // volume, which looks exactly like losing everything. A missing
    // DATABASE_URL is what says this copy has never had a database.
    expect(start).toContain('$hadDatabaseUrl = $have.ContainsKey(\'DATABASE_URL\')');
    expect(start).toContain('if ((-not $hadDatabaseUrl)');
  });

  it('leaves a clone alone', () => {
    // A developer's checkout keeps the default name, which is what its volumes
    // are already called.
    const block = start.slice(start.indexOf('# One installation, one Docker project.'));
    expect(block.slice(0, block.indexOf('Write-Warn'))).toContain('$PSScriptRoot.TrimEnd');
  });

  it('refuses containers a different directory started', () => {
    expect(start).toContain('com.docker.compose.project.working_dir');
    const guard = start.slice(start.indexOf('com.docker.compose.project.working_dir'));
    expect(guard.slice(0, 900)).toContain('Stop-WithReason');
    // And says what to do about it, in both directions.
    expect(guard.slice(0, 1400)).toContain('AI17Z_INSTANCE=');
  });

  it('asks docker for the label in a way Windows can carry', () => {
    // A double quote inside a native command's argument does not survive
    // Windows PowerShell's argument passing. `--format '{{index .Config.Labels
    // "..."}}'` reached docker broken, printed an empty line, and the guard
    // concluded the containers were this copy's own -- silently, which is the
    // worst thing a check like this can be.
    const format = start.match(/docker inspect \$ourContainers\[0\] --format '([^']*)'/);
    expect(format, 'the inspect call moved').not.toBeNull();
    expect(format![1], 'a quoted template does not survive the shell').not.toContain('"');
  });

  it('warns that a new name is a new database', () => {
    // The one thing somebody must know before taking that advice.
    expect(start).toMatch(/new name means a new, empty database/);
  });
});

/**
 * Nothing an installation needs to keep is written beside the program.
 *
 * The program directory is replaced on every upgrade and emptied by the
 * uninstaller. Two things were being written there anyway, and both turned up
 * in an uninstalled program folder:
 *
 *   - `storage/native-worker.log` and `.pid`, so the log somebody was reading
 *     to find out why their worker died went with the upgrade -- and an open
 *     handle there was what stopped the directory being removed at all.
 *   - `accounts.db`, which is twscrape's own account database. It writes it
 *     into whatever directory it was run from, and it was run from wherever
 *     the worker happened to start. Those are X credentials somebody added by
 *     hand.
 *
 * Worse than either: `Stop-ForUninstall.ps1` has always looked for the pid
 * under the *data* directory while the scripts wrote it under the program
 * directory, so the uninstaller never once found the worker it exists to stop.
 */
describe('the program directory holds nothing worth keeping', () => {
  const read = (name: string) => readFileSync(resolve(root, name), 'utf8');

  it.each(['start-ai17z.ps1', 'stop-ai17z.ps1', 'doctor-ai17z.ps1'])(
    '%s puts the worker pid beside the data',
    (name) => {
      const text = read(name);
      expect(text, 'still writing under the program directory').not.toMatch(
        /Join-Path \$PSScriptRoot 'storage\\native-worker/,
      );
      // Derived from the environment file, which is the one thing that already
      // knows which directory this installation keeps its data in.
      expect(text).toMatch(/Split-Path -Parent \$EnvFile/);
    },
  );

  it('all three agree on where it is', () => {
    // They disagreed for as long as the file existed, which is why nothing
    // ever found it.
    const paths = ['start-ai17z.ps1', 'stop-ai17z.ps1', 'doctor-ai17z.ps1'].map((name) =>
      read(name).includes("Join-Path (Split-Path -Parent $EnvFile) 'storage'"),
    );
    expect(paths.every(Boolean), 'one of them derives it differently').toBe(true);
  });

  it('the uninstaller looks where the data actually is', () => {
    const stop = read('packaging/windows/Stop-ForUninstall.ps1');
    // Not %LOCALAPPDATA%\AI17Z, which is only right for somebody who took the
    // default folder.
    expect(stop).toContain("'data-location.txt'");
    expect(stop).not.toMatch(/Join-Path \$env:LOCALAPPDATA 'AI17Z\\storage/);
  });

  it('twscrape writes its account database under the owner storage', () => {
    const source = readFileSync(resolve(root, 'packages/persona/src/sources/xPublic.ts'), 'utf8');
    expect(source).toContain('function twscrapeHome');
    expect(source).toContain('cwd: twscrapeHome()');
    expect(source).toContain("envString('AI17Z_STORAGE_DIR'");
  });

  it('moves an existing account database rather than abandoning it', () => {
    // Those credentials were added by hand. Silently starting again with an
    // empty pool looks exactly like twscrape having broken.
    const source = readFileSync(resolve(root, 'packages/persona/src/sources/xPublic.ts'), 'utf8');
    expect(source).toContain('renameSync');
    expect(source).toContain('moved the twscrape account database');
  });
});

/**
 * A relative path in an installed copy resolves against the program directory.
 *
 * Which is the one place nothing may be written: it is replaced on every
 * upgrade and emptied by the uninstaller. The clean-room check now asserts that
 * running AI17Z adds nothing there, and that one assertion found three separate
 * bugs, each hidden behind the last:
 *
 *   - `supervise-worker.mts` wrote the worker log and its pid under its own
 *     directory, so the log somebody was told to read to find out why their
 *     worker died was the first thing an upgrade threw away.
 *   - The shipped scripts did not export the storage paths, so anything a Start
 *     Menu shortcut called fell back to a relative default.
 *   - `doctor-ai17z.ps1` asked the environment file for `XBAM_BROWSER_PROFILE_DIR`
 *     while the installer writes the `AI17Z_` spelling, fell through to a
 *     program-directory default, and then created it. `browser-profiles` is
 *     where a signed-in Chrome session lives.
 */
describe('nothing relative resolves against the program directory', () => {
  const read = (name: string) => readFileSync(resolve(root, name), 'utf8');
  const shipped = ['start-ai17z.ps1', 'stop-ai17z.ps1', 'update-ai17z.ps1', 'launch-ai17z.ps1', 'doctor-ai17z.ps1'];

  it.each(shipped)('%s exports the data paths a shortcut does not inherit', (name) => {
    const text = read(name);
    expect(text, 'no data-path export').toContain('function Set-Ai17zDataPaths');
    expect(text).toContain('Set-Ai17zDataPaths $');
    for (const key of ['AI17Z_STORAGE_DIR', 'AI17Z_BROWSER_PROFILE_DIR']) {
      expect(text, `${key} is not exported`).toContain(`$env:${key}`);
    }
  });

  it.each(shipped)('%s leaves a clone alone', (name) => {
    // In a checkout the data directory *is* the script directory, and the
    // conventional ./storage layout is what a developer already has.
    const text = read(name);
    const block = text.slice(text.indexOf('function Set-Ai17zDataPaths'));
    expect(block.slice(0, 600)).toContain('-ieq $Root.TrimEnd');
  });

  it('the supervisor writes its log beside the data', () => {
    const supervisor = read('scripts/supervise-worker.mts');
    expect(supervisor).toContain('AI17Z_STORAGE_DIR');
    expect(supervisor, 'still writing under its own directory').not.toMatch(
      /join\(root, 'storage', 'native-worker\.log'\)/,
    );
  });

  it('the diagnostics ask for both spellings before giving up', () => {
    // The installer writes AI17Z_BROWSER_PROFILE_DIR; this asked only for the
    // XBAM_ one, so it always fell through to its fallback.
    const doctor = read('doctor-ai17z.ps1');
    expect(doctor).toContain("Get-EnvValue 'AI17Z_BROWSER_PROFILE_DIR'");
    expect(doctor).toContain("Get-EnvValue 'XBAM_BROWSER_PROFILE_DIR'");
  });

  it('the diagnostics resolve a relative profile path against the data', () => {
    const doctor = read('doctor-ai17z.ps1');
    expect(doctor).toContain('IsPathRooted');
    expect(doctor).toContain('$dataRoot');
    expect(doctor, 'still falls back to the program directory').not.toMatch(
      /\$profileRoot = Join-Path \$PSScriptRoot 'storage/,
    );
  });

  it('the clean room asserts the property, not the three instances', () => {
    // Named instances would have missed the next one. This compares against
    // what the installer put there.
    const verify = readFileSync(resolve(root, 'tools/verify-install.mts'), 'utf8');
    expect(verify).toContain('running it wrote into the program directory');
    expect(verify).toContain('const installed = new Set(await readdir(program))');
  });
});
