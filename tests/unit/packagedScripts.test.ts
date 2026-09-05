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
