import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const packager = readFileSync(resolve(root, 'tools/package-windows.mts'), 'utf8');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

/**
 * The same bug, three releases running.
 *
 * `.env.example` was missing from one build and `scripts/ensure-env.mjs` from
 * the next. Both failed identically: the installer succeeded, the containers
 * came up, and the first `npm run migrate` died on a path that exists only on
 * the machine that built it. Neither was caught by a test, because the packager
 * only ever proved that *dependencies* were installed.
 *
 * The guard now walks the npm scripts an installed copy can actually run --
 * including the `pre` hooks npm runs on their behalf, which is where
 * `ensure-env.mjs` hid -- and refuses to finish if any file they name is
 * absent from the stage.
 *
 * These tests are about the guard, not the packaging: they check it still looks
 * where it needs to, and that the entry-point list has not drifted from what
 * the scripts actually are.
 */
describe('the packager proves its own entry points will run', () => {
  it('names the scripts an installed copy runs', () => {
    expect(packager).toContain('SHIPPED_SCRIPTS');
    for (const name of ['migrate', 'start:api', 'start:worker', 'worker:supervised']) {
      expect(packager, `${name} is not covered`).toContain(`'${name}'`);
    }
  });

  it('looks at the pre hooks, which is where the last one hid', () => {
    // `npm run migrate` does not mention ensure-env.mjs. `premigrate` does, and
    // npm runs it whether anybody knows about it or not.
    expect(packager).toContain('`pre${name}`');
  });

  it('refuses rather than warning', () => {
    const at = packager.indexOf('missing files its own npm scripts run');
    expect(at, 'the guard message is gone').toBeGreaterThan(-1);
    // The throw sits above the message it carries.
    expect(packager.slice(Math.max(0, at - 300), at)).toContain('throw new Error');
  });

  it('has no stray control character in the pattern it matches with', () => {
    // A `\\b` written through a shell heredoc arrived as a literal backspace,
    // so the pattern required an unprintable character after the extension and
    // silently matched nothing. The guard passed every build while checking
    // precisely zero files.
    const match = packager.match(/script\.match\((\/[^\n]*?\/g)\)/);
    expect(match, 'the pattern moved or was renamed').not.toBeNull();
    // eslint-disable-next-line no-control-regex
    expect(match![1], 'control character in the pattern').not.toMatch(/[\x00-\x08\x0b\x0c\x0e-\x1f]/);
  });

  it('matches a real script line', () => {
    // Behaviour, not shape: build the same pattern and run it at the thing it
    // exists for.
    const source = packager.match(/script\.match\(\/(.+?)\/g\)/)![1]!;
    const pattern = new RegExp(source, 'g');
    expect(pkg.scripts.premigrate, 'premigrate no longer runs a file').toMatch(/\.mjs/);
    expect(pkg.scripts.premigrate!.match(pattern)).toContain('scripts/ensure-env.mjs');
    expect(pkg.scripts['worker:supervised']!.match(pattern)).toContain('scripts/supervise-worker.mts');
  });
});

/**
 * Which files from `scripts/` ship, and which must not.
 *
 * The directory holds maintainer tooling as well: one rewrites this
 * repository's commit history, another points the documentation at a different
 * remote. Shipping the folder wholesale would put both on somebody's machine.
 */
describe('only the scripts an installed copy needs are shipped', () => {
  it('ships the two the app runs', () => {
    expect(packager).toContain("'scripts/ensure-env.mjs'");
    expect(packager).toContain("'scripts/supervise-worker.mts'");
  });

  it('does not ship the directory wholesale', () => {
    expect(packager).not.toMatch(/^\s*'scripts',$/m);
  });

  it('ships no maintainer tooling', () => {
    for (const never of ['strip-tool-attribution', 'set-repo-url', 'agent-report']) {
      expect(packager, `${never} would be installed on somebody's machine`).not.toContain(never);
    }
  });
});

/**
 * The images are built on the machine that installed AI17Z.
 *
 * There is no registry and no prebuilt image: the installed copy runs
 * `docker compose build` from its own directory on first launch, exactly as a
 * clone does. So every path a Dockerfile `COPY`s has to be in the package, and
 * four were not -- `docs`, `tools`, `CONTRIBUTING.md`, `SECURITY.md`.
 *
 * It went unnoticed through three releases for a reason worth keeping: the
 * installed copy shared a Docker project name with a developer checkout, so
 * compose found images that checkout had already built and skipped the build
 * entirely. Giving each installation its own project name is what surfaced it,
 * as "/docs: not found" and no stack at all.
 *
 * This reads the Dockerfiles rather than listing anything, so a new `COPY`
 * fails here the moment it is written.
 */
describe('everything the images are built from is in the package', () => {
  const included = [...packager.matchAll(/^\s*'([^']+)',$/gm)]
    .map((m) => m[1]!)
    .filter((entry) => !entry.startsWith('node_modules/'));

  const copies = readdirSync(resolve(root, 'docker'))
    .filter((name) => name.endsWith('.Dockerfile'))
    .flatMap((name) => {
      const text = readFileSync(resolve(root, 'docker', name), 'utf8');
      return text
        .split(/\r?\n/)
        .map((line) => line.match(/^\s*COPY\s+(.*)$/))
        .filter((match): match is RegExpMatchArray => Boolean(match))
        // `--from=` copies out of an earlier build stage, not out of the
        // package, so there is nothing here for it to be missing.
        .filter((match) => !match[1]!.includes('--from='))
        .flatMap((match) => match[1]!.trim().split(/\s+/).slice(0, -1))
        .map((source) => ({ source, dockerfile: name }));
    });

  it('finds the copies to check, so this test cannot pass by finding none', () => {
    expect(copies.length).toBeGreaterThan(20);
    expect(included).toContain('packages');
  });

  it.each([...new Set(copies.map((c) => `${c.source} (${c.dockerfile})`))])('%s is staged', (label) => {
    const source = label.slice(0, label.indexOf(' ('));
    const covered = included.some((entry) => source === entry || source.startsWith(`${entry}/`));
    expect(covered, `${source} is copied into an image and never packaged`).toBe(true);
  });

  it('checks this at build time too, not only here', () => {
    // A test proves the list is right today. The packager proves the staged
    // directory is right, which is the thing that actually ships.
    expect(packager).toContain('missing paths its own Dockerfiles copy');
    expect(packager).toContain("dockerfile.endsWith('.Dockerfile')");
  });
});

/**
 * The package that installs must be the package that was tested.
 *
 * `npm ci --omit=optional` was added to drop a 37MB canvas binary pdfjs never
 * calls. npm installs exactly one platform package out of an optional set, and
 * that is how esbuild ships its binary -- so the flag also removed
 * `@esbuild/win32-x64`, and with it every `tsx` process an installed copy runs:
 * the migration on every start, and the native worker that is the only thing
 * able to drive real Chrome.
 *
 * It shipped four times because the failure cannot be reproduced on a machine
 * that has ever installed esbuild: the postinstall fetches the binary over the
 * network and leaves a `downloaded-` copy of it inside esbuild's own lib
 * directory, so a developer's stage works and a clean build runner's does not.
 */
describe('the package can run TypeScript at all', () => {
  it('does not omit optional dependencies', () => {
    expect(packager, 'the flag that removed esbuild is back').not.toContain("'--omit=optional'");
  });

  it('drops the unwanted native binary by name instead', () => {
    // By name, not by category: the category also holds the thing that makes
    // TypeScript run.
    expect(packager).toContain("'@napi-rs'");
    expect(packager).toMatch(/rm\(join\(stageDir, 'node_modules', '@napi-rs'\)/);
  });

  it('proves it by running a transform, not by looking for a file', () => {
    // `tsx` and `esbuild` were both present and correct in a package where
    // nothing could run, because the binary esbuild shells out to was missing.
    // Only executing something catches that.
    expect(packager).toContain("'tsx', 'dist', 'cli.mjs'");
    expect(packager).toContain('tsx ok');
    expect(packager).toContain('cannot run TypeScript');
  });

  it('every entry point it guards actually needs tsx', () => {
    // If the scripts stop using tsx this guard is measuring nothing.
    const usesTsx = ['migrate', 'start:api', 'start:worker', 'worker:supervised'].filter((name) =>
      pkg.scripts[name]?.includes('tsx'),
    );
    expect(usesTsx.length, 'no shipped entry point runs tsx any more').toBeGreaterThan(2);
  });
});

/**
 * The Start Menu runs these scripts directly.
 *
 * "Stop AI17Z" and "AI17Z diagnostics" are shortcuts to powershell.exe with a
 * script path -- not to AI17Z.cmd, which is the only thing that sets
 * AI17Z_ENV_FILE. So the variable is absent exactly when somebody is trying to
 * stop or fix something, and every one of these scripts fell back to a `.env`
 * beside the program, where an installed copy has none.
 *
 * What that cost: the diagnostics tool told a healthy installation it was "not
 * configured" and sent them to a script that is not shipped; the launcher
 * opened localhost:8080 for somebody who had chosen another port; and "Stop
 * AI17Z" resolved to compose project `xbam` -- which, now that each
 * installation names its own project, is somebody else's stack.
 */
describe('every shipped script finds the owner environment file', () => {
  const scripts = ['start-ai17z.ps1', 'stop-ai17z.ps1', 'update-ai17z.ps1', 'launch-ai17z.ps1', 'doctor-ai17z.ps1'];
  const read = (name: string) => readFileSync(resolve(root, name), 'utf8');

  it.each(scripts)('%s resolves it the same way', (name) => {
    const text = read(name);
    expect(text, 'no resolver').toContain('function Resolve-Ai17zEnvFile');
    expect(text).toContain('$env:AI17Z_ENV_FILE');
    expect(text).toContain('$env:XBAM_ENV_FILE');
    // The fallback that makes a Start Menu shortcut work.
    expect(text, 'does not fall back to data-location.txt').toContain("'data-location.txt'");
  });

  it.each(scripts)('%s reads no bare .env by relative path', (name) => {
    const text = read(name);
    expect(text).not.toMatch(/Test-Path '\.env'/);
    expect(text).not.toMatch(/Get-Content '\.env'/);
  });

  it('the diagnostics no longer point at a script that is not shipped', () => {
    // install-ai17z.ps1 is a developer script and is not in the package, so
    // "Run .\install-ai17z.ps1" was advice nobody could follow.
    const doctor = read('doctor-ai17z.ps1');
    expect(doctor).not.toContain('install-ai17z.ps1');
    expect(packager).not.toContain("'install-ai17z.ps1'");
  });

  it('names the file it could not find', () => {
    // "No .env file yet" is useless when the whole bug is that it looked in the
    // wrong place.
    expect(read('doctor-ai17z.ps1')).toContain('No environment file at $EnvFile');
  });
});

/**
 * The clean-room installation check, and the three faults it found before a
 * release could.
 *
 * Six candidates were published to find four faults, one at a time, each on
 * somebody else's machine. `tools/verify-install.mts` reproduces what the
 * installer does to a disk and drives all five entry points from a directory
 * that did not exist a minute earlier. On its first two runs it found: a
 * project name that still collided, an `AI17Z.cmd` that hangs for ever when
 * nobody is watching, and a harness of its own that mistook a working
 * installation for a hang.
 *
 * These pin the properties that made it able to find them.
 */
describe('installing from scratch is checked before anything is published', () => {
  const verify = readFileSync(resolve(root, 'tools/verify-install.mts'), 'utf8');

  it('is a script somebody can run', () => {
    expect(pkg.scripts['verify:install']).toBe('tsx tools/verify-install.mts');
  });

  it('drives every entry point a shortcut points at', () => {
    // The Start Menu has five. Testing one of them is what let three faults
    // through.
    for (const entry of ['AI17Z.cmd', 'doctor-ai17z.ps1', 'stop-ai17z.ps1']) {
      expect(verify, `${entry} is not driven`).toContain(entry);
    }
  });

  it('runs them with no AI17Z environment at all', () => {
    // The shortcuts run powershell.exe directly and inherit nothing. Leaking a
    // variable in would hide the exact class of fault this looks for.
    expect(verify).toContain('function bareEnvironment');
    expect(verify).toMatch(/\^\(AI17Z\|XBAM\|VITE_XBAM\)_/);
  });

  it('judges by asking, not by exit codes', () => {
    expect(verify).toContain('select count(*) from schema_migrations');
    expect(verify).toContain('/api/health/live');
  });

  it('can run the whole thing twice from nothing', () => {
    // A first-run bug is invisible on the second run and a second-run bug on
    // the first. Both have shipped.
    expect(verify).toContain("--twice");
    expect(verify).toContain("attempt('second'");
  });

  it('refuses two installations that land in one Docker project', () => {
    expect(verify).toContain('two installations share a Docker project');
  });

  it('cannot wait for ever', () => {
    // A failing AI17Z.cmd ended in `pause`, which with no console waits for a
    // keypress that never comes, so a failure looked like a slow success.
    expect(verify).toContain('function withTimeout');
    expect(verify).toMatch(/stdio: \['ignore', 'pipe', 'pipe'\]/);
  });

  it('waits for the process to exit, not for every pipe writer to let go', () => {
    // A successful start leaves the native worker running, holding the same
    // stdout handle, so `close` never fires on a working installation.
    expect(verify).not.toMatch(/child\.on\('close'/);
    expect(verify).toMatch(/child\.on\('exit'/);
  });
});

/**
 * One Docker project per installation, where "installation" means the data
 * directory and not the name of its last folder.
 *
 * The first version of this took the folder's name. Somebody who picks their
 * own data folder usually calls it "data", so two installations that both did
 * shared a project again -- which is the whole thing the rule exists to
 * prevent. The clean-room check hit it on its second run, having installed to
 * two directories that both ended in \data.
 */
describe('the Docker project is unique to the installation', () => {
  const start = readFileSync(resolve(root, 'start-ai17z.ps1'), 'utf8');

  it('carries a digest of the whole path, not just the last folder', () => {
    expect(start).toContain('System.Security.Cryptography.SHA256');
    expect(start).toContain('$digest');
    expect(start).toMatch(/ai17z-\$leaf-\$digest/);
  });

  it('takes the digest case-insensitively, because Windows paths are', () => {
    // The same directory spelled two ways is one installation.
    expect(start).toMatch(/\$dataDir\.TrimEnd\('\\'\)\.ToLowerInvariant\(\)/);
  });

  it('keeps the folder name in front of it, because docker ps is read by people', () => {
    expect(start).toContain('$leaf');
  });
});

/**
 * An unattended start that fails must fail, not hang.
 *
 * `pause` holds the window open so a double-clicked icon does not flash and
 * vanish with the reason in it. With no console attached it waits for a
 * keypress that is never coming, so a failed start became a process that sat
 * there looking like it was working.
 */
describe('nothing waits for a keypress that is not coming', () => {
  const cmd = readFileSync(resolve(root, 'packaging/windows/AI17Z.cmd'), 'utf8');
  const launch = readFileSync(resolve(root, 'launch-ai17z.ps1'), 'utf8');

  it('only pauses when somebody is there', () => {
    expect(cmd).toMatch(/if not defined AI17Z_NO_BROWSER if not defined CI pause/);
    expect(cmd).not.toMatch(/^\s*pause\s*$/m);
  });

  it('does not open a browser when nobody is watching', () => {
    expect(launch).toContain('if ($env:AI17Z_NO_BROWSER)');
    expect(launch).toContain('Ready at $url');
  });

  it('still opens one normally', () => {
    expect(launch).toContain('Start-Process $url');
  });
});
