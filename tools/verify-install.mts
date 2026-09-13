/**
 * Installs AI17Z from scratch and drives every entry point a person can touch.
 *
 * Six release candidates in a row installed and then failed, each on a
 * different thing, and every one of them was found by a person running the
 * published installer. That is the loop this exists to end: the faults are
 * findable in ninety seconds on the machine that builds, and were not being
 * found because "verified" meant one successful run of one script.
 *
 * What went wrong, and what this therefore does differently:
 *
 *   - **The clean room was not clean.** The stage reused npm's warm cache, so
 *     esbuild's binary was present locally and absent on a build runner. The
 *     Docker volumes already existed, so the two migrators never raced. Both
 *     faults were invisible by construction. This creates a new program
 *     directory, a new data directory, a new Docker project and new volumes on
 *     every run, and `--twice` runs the whole thing again from nothing --
 *     because a first-run bug is invisible on the second run.
 *   - **Only one entry point was tested.** `start-ai17z.ps1`, with
 *     AI17Z_ENV_FILE already set. The Start Menu has five, and two of them run
 *     with no environment at all -- which is where three faults lived. This
 *     drives all of them, with an environment scrubbed of every AI17Z variable.
 *   - **One success was called verification.** Nothing here is judged by an
 *     exit code alone: the database is asked how many migrations it has, the
 *     API and the web are fetched, and the diagnostics output is read.
 *   - **A page that answers is not a page that works.** `GET /` returning 200
 *     is nginx handing over an `index.html` with an empty div in it, which is
 *     just as true of an interface that crashes the instant React runs. Beta
 *     1.0.0 shipped exactly that -- a black screen on every installation --
 *     past a run of this that said "API and interface both answering". It now
 *     makes the owner account, signs in through a real headless browser, and
 *     waits for the agent list to draw.
 *
 * It never touches the desktop or any Docker project but its own, and it cannot
 * disturb an installation or a checkout.
 *
 * One exception, named because an exception nobody wrote down is a promise that
 * quietly stopped being true: `--bootstrap` runs the real setup script, and a
 * real install registers itself with Windows -- a Start Menu group, an
 * Add/Remove Programs entry, and `Software\AI17Z\DataDir`, which is what an
 * uninstaller reads to decide whose data to offer to delete. That phase takes
 * the value before it starts, removes everything it created by name, and puts
 * the value back.
 *
 * Run: npm run verify:install [-- --twice] [--upgrade] [--bootstrap] [--instances] [--keep]
 */
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const twice = process.argv.includes('--twice');
const keep = process.argv.includes('--keep');
const alsoUpgrade = process.argv.includes('--upgrade');
/** Also install once through the real AI17Z Setup script, rather than only through the installer's steps. */
const alsoBootstrap = process.argv.includes('--bootstrap');
/** Also make three independent installations and prove that updating one leaves the others alone. */
const alsoInstances = process.argv.includes('--instances');

/** The version the second package calls itself, so an update is visible from the outside. */
const UPDATED_VERSION = '9.9.9-verify';

/** Somewhere no sync client and no existing installation can reach. */
const ROOM = resolve('C:/ai17z-verify-room');

interface Ports {
  web: number;
  api: number;
  db: number;
}

function say(message: string): void {
  process.stdout.write(`  ${message}\n`);
}

class Failed extends Error {}

function fail(what: string, detail: string): never {
  throw new Failed(`${what}\n      ${detail.replace(/\n/g, '\n      ')}`);
}

/**
 * Where the search for a free port starts.
 *
 * Not the 8000s. Those are where desktop software lives -- dev servers,
 * browsers, and whatever a browser starts on your behalf -- and this gate spent
 * two full runs failing in its last phase because Brave was holding 8600 on and
 * off. A bind to `[::]` without IPV6_V6ONLY is dual-stack on Windows, so it
 * took `0.0.0.0:8600` with it, and `docker compose up` said "ports are not
 * available" after the phase had already installed twice to get there.
 *
 * A quieter range does not make the race impossible. It makes it rare enough
 * that a red gate means something about AI17Z.
 */
const PORT_BASE = { web: 18300, api: 18400, db: 55600 } as const;

/**
 * A port nothing is listening on, taken by binding it rather than guessing.
 *
 * Both stacks, because Docker publishes on both -- `0.0.0.0:PORT` *and*
 * `[::]:PORT` -- and a port free on one is not free. Checking only IPv4 let a
 * browser holding `[::]:8600` pass this and fail four minutes later inside
 * `docker compose up`, as "ports are not available", in the one phase that had
 * already installed twice to get there. A gate that fails on somebody else's
 * socket is a gate nobody can read.
 *
 * It does not close the race, and cannot: the socket is released before Docker
 * takes it, so something can always arrive in between. It closes the half of it
 * that was invisible.
 */
async function freePort(from: number): Promise<number> {
  const bindable = (port: number, host: string) =>
    new Promise<boolean>((done) => {
      const server = createServer();
      server.once('error', () => done(false));
      // ipv6Only so the two attempts test the two stacks rather than one of
      // them testing both and colliding with itself.
      server.listen({ port, host, ipv6Only: host === '::' }, () => server.close(() => done(true)));
    });

  for (let port = from; port < from + 200; port += 1) {
    if ((await bindable(port, '0.0.0.0')) && (await bindable(port, '::'))) return port;
  }
  throw new Error(`no free port near ${from}`);
}

/**
 * The environment a Start Menu shortcut runs in.
 *
 * Every AI17Z and XBAM variable removed, because that is the whole point: the
 * shortcuts run powershell.exe directly and inherit nothing from AI17Z.cmd, and
 * three faults lived in scripts that only worked when a variable was already
 * set. Leaking one in here would hide exactly what this is looking for.
 */
function bareEnvironment(): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(AI17Z|XBAM|VITE_XBAM)_/i.test(key)) continue;
    clean[key] = value;
  }
  return clean;
}

/**
 * Exactly what the installer does, and nothing it does not.
 *
 * Taken from `packaging/windows/ai17z.iss`: the [Files] section, the four files
 * WriteSettings creates, and the three directories CurStepChanged creates. The
 * registry value and the shortcuts are deliberately not reproduced -- they are
 * per-machine state this must never touch, and nothing downstream reads the
 * registry: `data-location.txt` is what the scripts follow.
 */
async function install(stage: string, program: string, data: string, ports: Ports): Promise<void> {
  await cp(stage, program, { recursive: true });

  const packaging = join(program, 'packaging', 'windows');
  await mkdir(packaging, { recursive: true });
  for (const file of ['ai17z.ico', 'Uninstall-Data.ps1', 'Stop-ForUninstall.ps1', 'Install-Prerequisites.ps1']) {
    await cp(join(root, 'packaging', 'windows', file), join(packaging, file));
  }
  await cp(join(root, 'packaging', 'windows', 'AI17Z.cmd'), join(program, 'AI17Z.cmd'));

  await mkdir(join(data, 'storage'), { recursive: true });
  await mkdir(join(data, 'browser-profiles'), { recursive: true });

  // Three lines and nothing else, which is what WriteSettings writes and what
  // every launcher after it has to cope with.
  //
  // And only the keys that are not already there. WriteSettings checks each of
  // the three and appends the ones missing, so an upgrade leaves the ports,
  // the master key and the project name exactly as they were. Rewriting the
  // file here would have made every upgrade look like a fresh install, which
  // is the one thing an upgrade must never be.
  const envPath = join(data, '.env');
  let env = '';
  try {
    env = await readFile(envPath, 'utf8');
  } catch {
    // No file yet: a first installation.
  }
  const has = (key: string) => new RegExp(`^[ \\t]*${key}[ \\t]*=`, 'm').test(env);
  const additions = [
    has('AI17Z_WEB_PORT') ? '' : `AI17Z_WEB_PORT=${ports.web}\r\n`,
    has('AI17Z_API_PORT') ? '' : `AI17Z_API_PORT=${ports.api}\r\n`,
    has('POSTGRES_PORT') ? '' : `POSTGRES_PORT=${ports.db}\r\n`,
  ].join('');
  if (additions) await writeFile(envPath, env + additions, 'utf8');
  await writeFile(join(program, 'data-location.txt'), data, 'utf8');

  // What WriteInstallInfo writes, and the reason it exists: the application
  // reads this to say how it should be updated, and an installation with no
  // marker is one the update screen has to guess about.
  await writeFile(
    join(program, 'INSTALL_INFO.json'),
    `${JSON.stringify(
      { schema: 1, channel: 'INSTALLER', instance: basename(program), programDir: program, dataDir: data },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

/** One PowerShell command, for the small amount of Windows state this has to read and put back. */
async function powershell(command: string): Promise<string> {
  try {
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return '';
  }
}

/** Drive a shortcut: powershell.exe, a script path, and no AI17Z environment. */
async function shortcut(program: string, script: string): Promise<{ stdout: string; code: number }> {
  return shortcutWith(program, script, []);
}

/** The same, for the two entry points that take an argument. */
async function shortcutWith(
  program: string,
  script: string,
  args: string[],
): Promise<{ stdout: string; code: number }> {
  return new Promise((done) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(program, script), ...args],
      { cwd: program, env: { ...bareEnvironment(), AI17Z_NO_BROWSER: '1' }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stdout += String(d)));
    child.on('exit', (code) => setTimeout(() => done({ stdout, code: code ?? -1 }), 500));
  });
}

async function compose(program: string, data: string, args: string[]): Promise<string> {
  const { stdout, stderr } = await run('docker', ['compose', '--env-file', join(data, '.env'), ...args], {
    cwd: program,
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout + stderr;
}

async function get(url: string): Promise<{ status: number; body: string }> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    return { status: response.status, body: await response.text() };
  } catch (error) {
    return { status: 0, body: (error as Error).message };
  }
}

/**
 * Sign in and look at the agent list, in a real browser.
 *
 * `GET /` returning 200 is nginx handing over an `index.html` with an empty
 * `<div id="root">` in it. That is true of a working installation and equally
 * true of one whose interface crashes the moment React runs, which is exactly
 * what shipped as Beta 1.0.0: a hook below an early return threw during the
 * second render, React unmounted the whole tree, and every installation showed
 * a black screen. This gate said "API and interface both answering" while it
 * did.
 *
 * So the check is now the thing a person does on their first minute: make the
 * owner account, sign in, and see the agent list. It fails on an empty page and
 * on any uncaught error, because either one is a screen nobody can use.
 *
 * Headless Chromium, from the Playwright already pinned for the worker. It
 * needs no display and no Google Chrome -- unlike a browser session, nothing
 * here depends on which binary is running, only on whether the JavaScript
 * survives being executed.
 */
async function signInAndLook(label: string, ports: Ports): Promise<void> {
  const email = 'verify@ai17z.invalid';
  const password = 'verify-install-password';

  const created = await fetch(`http://localhost:${ports.api}/api/bootstrap/owner`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, displayName: 'Verify' }),
    signal: AbortSignal.timeout(15_000),
  });
  // 409 is "there is already an owner", which is the normal answer the second
  // time this runs against one database -- the upgrade case signs in after an
  // install that kept its volume, and a previous failed run can leave one too.
  // The account is the same either way, so signing in is the right next step.
  if (!created.ok && created.status !== 409) {
    fail(`${label}: the owner account could not be created`, `${created.status} ${await created.text()}`);
  }

  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  // Every uncaught error, and every console error, kept with the page rather
  // than printed -- a failure has to say what broke, and the stack is the only
  // part of this worth reading.
  const broke: string[] = [];
  try {
    const page = await browser.newPage();
    page.on('pageerror', (error) => broke.push(`uncaught: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') broke.push(`console: ${message.text().slice(0, 300)}`);
    });

    await page.goto(`http://localhost:${ports.web}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    // By shape, not by label. A form control's type cannot drift without the
    // form changing meaning, where an accessible name can be reworded in a
    // copy edit -- and this failing for a reason that is not a fault costs the
    // same hour as it not failing at all.
    await page.locator('input[type="email"]').fill(email);
    await page.locator('input[type="password"]').fill(password);
    await page.locator('button[type="submit"]').click();

    // The agent list, by its own words.
    //
    // Not `getByRole('heading', { name: 'Your agents' })`: that heading is
    // animated a word at a time and the words are joined with a non-breaking
    // space, so its accessible name is `Your\u00A0agents` and the obvious
    // selector never matches. Normalising the whole page and looking for the
    // phrase is both more robust and closer to the question being asked --
    // did the interface draw itself.
    await page.waitForFunction(
      () => /Your\s+agents/.test((document.getElementById('root')?.innerText ?? '').replace(/\u00A0/g, ' ')),
      undefined,
      { timeout: 30_000 },
    );

    const rendered = await page.evaluate(() => document.getElementById('root')?.innerText.trim().length ?? 0);
    if (rendered < 20) {
      fail(`${label}: the interface signed in and then rendered nothing`, broke.join('\n') || '(no error was logged)');
    }
    // React unmounts the tree on a render error, so an empty page and a thrown
    // error are the same fault seen from two sides. Both are checked, because
    // an error that leaves something on screen is still a bug that shipped.
    const uncaught = broke.filter((line) => line.startsWith('uncaught:'));
    if (uncaught.length > 0) {
      fail(`${label}: the interface threw while rendering`, uncaught.join('\n'));
    }
    say(`${label}: signed in, and the agent list drew itself`);
  } catch (error) {
    if (error instanceof Failed) throw error;
    fail(`${label}: the interface could not be used`, `${(error as Error).message}\n${broke.join('\n')}`);
  } finally {
    await browser.close().catch(() => undefined);
  }
}

async function migrationsOnDisk(): Promise<number> {
  return (await readdir(join(root, 'migrations'))).filter((f) => f.endsWith('.sql')).length;
}

/** Nothing in here may wait for ever; a hang is a failure that hides itself. */
async function withTimeout<T>(what: string, ms: number, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout;
  const bell = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Failed(`${what} (after ${Math.round(ms / 60_000)} minutes)`)), ms);
  });
  try {
    return await Promise.race([work, bell]);
  } finally {
    clearTimeout(timer!);
  }
}

/**
 * Start the way a person does: the shim the desktop icon and the Start Menu
 * both point at, with nothing handed to it.
 */
async function start(label: string, program: string, ports: Ports): Promise<string> {
  say(`${label}: starting through AI17Z.cmd`);
  const started = await withTimeout(
    `${label}: AI17Z.cmd never finished`,
    15 * 60_000,
    new Promise<{ out: string; code: number }>((done) => {
      const child = spawn('cmd.exe', ['/c', join(program, 'AI17Z.cmd')], {
        cwd: program,
        // AI17Z.cmd sets everything it needs. Nothing is handed to it, because
        // nothing is handed to it by a shortcut either.
        env: { ...bareEnvironment(), AI17Z_NO_BROWSER: '1' },
        // Closed, not inherited. A failing start used to end in `pause`, which
        // waits for a keypress that is never coming and turns a failure into a
        // hang -- which is how this harness spent half an hour looking like it
        // was working.
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout.on('data', (d) => (out += String(d)));
      child.stderr.on('data', (d) => (out += String(d)));
      // `exit`, not `close`. A successful start leaves the native worker
      // running, and it outlives cmd.exe holding the same stdout handle -- so
      // `close`, which waits for every writer to let go, never fires and a
      // working installation looks like a hang.
      child.on('exit', (code) => setTimeout(() => done({ out, code: code ?? -1 }), 500));
    }),
  );

  if (!/Ready at http:\/\/localhost:/.test(started.out)) {
    fail(`${label}: the start did not finish`, started.out.split(/\r?\n/).filter(Boolean).slice(-25).join('\n'));
  }
  if (!started.out.includes(`localhost:${ports.web}`)) {
    fail(`${label}: it opened the wrong address`, `expected port ${ports.web}\n${started.out.slice(-400)}`);
  }
  return started.out;
}

async function attempt(label: string, stage: string): Promise<string> {
  const program = join(ROOM, label, 'program');
  const data = join(ROOM, label, 'data');
  await rm(join(ROOM, label), { recursive: true, force: true });
  await mkdir(program, { recursive: true });
  await mkdir(data, { recursive: true });

  const ports: Ports = {
    web: await freePort(PORT_BASE.web),
    api: await freePort(PORT_BASE.api),
    db: await freePort(PORT_BASE.db),
  };
  // The Docker project is whatever the launcher decides and writes into the
  // environment file, so it is read back afterwards rather than guessed at.
  // Guessing it meant the teardown named a project that did not exist, left
  // four containers running, and the next run then collided with them.
  const projectOf = async (): Promise<string | null> => {
    try {
      const text = await readFile(join(data, '.env'), 'utf8');
      return text.match(/^[ \t]*AI17Z_INSTANCE[ \t]*=[ \t]*(\S+)/m)?.[1] ?? null;
    } catch {
      return null;
    }
  };

  say(`${label}: installing to ${program}`);
  say(`${label}: web ${ports.web}, api ${ports.api}, database ${ports.db}`);
  await install(stage, program, data, ports);

  // What the installer put there, so anything that appears later is something
  // running the application wrote.
  const installed = new Set(await readdir(program));

  try {
    // ---- 1. The thing the desktop icon and the Start Menu both point at ----
    await start(label, program, ports);

    // ---- 2. The database, asked rather than assumed ----------------------
    const expected = await migrationsOnDisk();
    const counted = await compose(program, data, [
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'xbam',
      '-d',
      'xbam',
      '-tAc',
      'select count(*) from schema_migrations',
    ]);
    const applied = Number(counted.trim().split(/\r?\n/).pop());
    if (applied !== expected) {
      fail(`${label}: ${applied} migrations applied, ${expected} on disk`, counted.trim());
    }
    say(`${label}: ${applied} migrations applied`);

    // ---- 3. What a person would actually look at -------------------------
    const health = await get(`http://localhost:${ports.api}/api/health/live`);
    if (health.status !== 200) fail(`${label}: the API did not answer`, `${health.status} ${health.body}`);
    const web = await get(`http://localhost:${ports.web}/`);
    if (web.status !== 200) fail(`${label}: the interface did not answer`, `${web.status} ${web.body}`);
    say(`${label}: API and interface both answering`);

    // Answering is not the same as working. This is the part that would have
    // caught the black screen.
    await withTimeout(`${label}: signing in`, 3 * 60_000, signInAndLook(label, ports));

    // ---- 4. Start Menu: diagnostics, with no environment -----------------
    const doctor = await shortcut(program, 'doctor-ai17z.ps1');
    // Only these two rows. "AI providers NOT CONFIGURED" and "Accounts NOT
    // CONFIGURED" are true and correct on a fresh installation -- there are
    // none yet, and saying so is the diagnostics doing its job.
    for (const row of ['Configuration', 'Master key']) {
      const line = doctor.stdout.split(/\r?\n/).find((l) => l.trim().startsWith(row));
      if (!line) fail(`${label}: the diagnostics no longer report "${row}"`, doctor.stdout.slice(-600));
      if (/NOT CONFIGURED|FAIL/.test(line)) {
        fail(`${label}: the diagnostics call a working installation broken`, line.trim());
      }
    }
    if (!doctor.stdout.includes(String(ports.web)) && !doctor.stdout.includes(String(ports.db))) {
      fail(`${label}: the diagnostics report default ports, so they read the wrong file`, doctor.stdout.slice(-600));
    }
    say(`${label}: diagnostics agree with the installation`);

    // ---- 5. Start Menu: stop, with no environment ------------------------
    await shortcut(program, 'stop-ai17z.ps1');
    const after = await compose(program, data, ['ps', '--format', '{{.Name}} {{.State}}']);
    if (/running/.test(after)) {
      fail(`${label}: "Stop AI17Z" left containers running`, after.trim());
    }
    say(`${label}: stop stopped this installation`);

    // ---- 6. Nothing worth keeping was written beside the program ---------
    //
    // The program directory is replaced on every upgrade and emptied by the
    // uninstaller, so anything an installation needs to keep must not be here.
    // Two things were: the native worker's log and pid, and twscrape's
    // `accounts.db`, which holds X credentials somebody added by hand. Both
    // turned up in an uninstalled program folder.
    //
    // Compared against what was installed rather than against a list, so
    // anything new that starts writing here is caught without being named.
    const stray = (await readdir(program)).filter((name) => !installed.has(name));
    if (stray.length > 0) {
      fail(
        `${label}: running it wrote into the program directory`,
        `${stray.join(', ')}\nThese are replaced on upgrade and removed on uninstall. They belong under ${data}.`,
      );
    }
    say(`${label}: wrote nothing beside the program`);

    return (await projectOf()) ?? fail(`${label}: no Docker project was ever named`, 'AI17Z_INSTANCE is unset');
  } finally {
    const project = await projectOf();
    if (project) say(`${label}: docker project ${project}`);
    await teardown(label);
  }
}

/**
 * Installing over an installation that is already there.
 *
 * The path where a mistake is worst: the program directory is replaced and the
 * data directory is not, so an upgrade that renamed the Docker project, or
 * rewrote the environment file, would come up against an empty volume -- which
 * looks exactly like losing every agent, memory and credential.
 *
 * Proved with a row written before and read after, rather than by counting
 * tables. A schema can survive while the data behind it does not.
 */
async function upgrade(stage: string): Promise<void> {
  try {
    await upgradeBody(stage);
  } finally {
    // In a finally, because a failure here used to leave a running stack and a
    // native worker behind -- and since the room path is fixed, the next run
    // inherited both and failed on something else entirely.
    await teardown('upgrade');
  }
}

/**
 * Stop and remove whatever a case left, whether it passed or not.
 *
 * The project name is read back rather than derived, so this stays right if the
 * naming rule ever changes.
 *
 * **`--rmi local` matters as much as `-v`.** The clean room was program
 * directory, data directory, project and volumes -- and not images, which is
 * where the application code actually lives. The project name is derived from
 * the data path, and the room path is fixed, so every run produced the same
 * project name and `docker compose up -d`, which builds only when an image is
 * *missing*, quietly reused the images from the run before. A change to
 * anything under `apps/` or `packages/` could therefore be staged, installed,
 * started and declared good without ever being built.
 *
 * That is not hypothetical: it is how this gate passed while deliberately
 * running the black-screen bug, which is what proved it needed fixing.
 */
async function teardown(label: string): Promise<void> {
  if (keep) return;
  const program = join(ROOM, label, 'program');
  const data = join(ROOM, label, 'data');
  try {
    const text = await readFile(join(data, '.env'), 'utf8');
    const project = text.match(/^[ \t]*AI17Z_INSTANCE[ \t]*=[ \t]*(\S+)/m)?.[1];
    if (project) {
      await run('docker', ['compose', '-p', project, 'down', '-v', '--rmi', 'local'], { cwd: program }).catch(
        () => undefined,
      );
      // `--rmi local` only removes images compose knows it built for this
      // project, and it cannot when a container from a failed run still holds
      // one. Named explicitly as a second pass so a stale image can never
      // survive into the next run, which is the whole point.
      for (const service of ['api', 'web', 'worker']) {
        await run('docker', ['image', 'rm', '-f', `${project}-${service}`]).catch(() => undefined);
      }
    }
  } catch {
    // No environment file means nothing was ever started.
  }
  // The native worker holds its own log files open, so the directory cannot go
  // until it does.
  await run('powershell.exe', [
    '-NoProfile',
    '-Command',
    `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${label}\\program*' -and $_.Name -like 'node*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
  ]).catch(() => undefined);
  await rm(join(ROOM, label), { recursive: true, force: true }).catch(() => undefined);
}

/**
 * Every file under a directory and what it hashes to.
 *
 * The only way to answer "was this installation touched" without deciding in
 * advance which file to look at -- and the files that mattered were never the
 * ones anybody would have listed.
 */
async function hashTree(dir: string): Promise<Map<string, string>> {
  const { createHash } = await import('node:crypto');
  const out = new Map<string, string>();
  const walk = async (current: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        const hash = createHash('sha256');
        hash.update(await readFile(full));
        out.set(relative(dir, full), hash.digest('hex'));
      }
    }
  };
  await walk(dir);
  return out;
}

/**
 * The other way AI17Z gets installed, run for real.
 *
 * Every phase above reproduces what the Windows installer does to a disk. That
 * is deliberate -- it is fast and it cannot be defeated by an installer that
 * refuses to run unattended -- but it means the code being checked is this
 * file's, not the installer's.
 *
 * AI17Z Setup has no such problem: it is a script, it takes the program
 * directory, the data directory and the package as arguments, and it installs
 * without touching a wizard, the network, or anything outside the directories
 * it was given. So this runs **the shipped script**, against **the same staged
 * application**, zipped exactly as the release workflow zips it.
 *
 * Four properties, and each of them is something that has gone wrong somewhere
 * in this project's history:
 *
 *   - the name asked for is the name installed. A published installer once
 *     named an installation one thing and put its files inside another's
 *     directory, and its uninstaller was registered to delete that other
 *     directory
 *   - a second run over the top changes the program and nothing else. The
 *     master key, the ports and everything in the data directory survive, and
 *     losing the master key makes every stored credential unreadable
 *   - the package is refused when its hash does not match, with nothing
 *     installed
 *   - what it installed actually runs, and says so only after checking
 */
async function bootstrap(stage: string): Promise<void> {
  const label = 'bootstrap';
  const instance = 'ai17z-verify-boot';
  const program = join(ROOM, label, 'program');
  const data = join(ROOM, label, 'data');
  const setup = join(root, 'packaging', 'windows', 'Setup-AI17Z.ps1');

  // This phase runs the real setup script, and a real install registers itself
  // with Windows: a Start Menu group, an Add/Remove Programs entry, and the
  // list of installations the next installer reads. That is correct of the
  // script and unacceptable of this harness, which promises to touch nothing
  // outside its own room -- and one of those values, `Software\AI17Z\DataDir`,
  // is what an uninstaller reads to decide which data directory to offer to
  // delete. Left pointing at a directory in this room, it would name the wrong
  // folder to somebody uninstalling a real copy.
  //
  // So the value is taken before and put back after, and everything else this
  // creates is removed by name.
  const previousDataDir = (
    await powershell(
      `(Get-ItemProperty 'HKCU:\\Software\\AI17Z' -ErrorAction SilentlyContinue).DataDir`,
    )
  ).trim();
  const restoreMachineState = async () => {
    const group = `$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\${instance}`;
    const key = `HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{8F3B2A41-6C7E-4E51-9C2B-AI17Z0000001}_${instance}_setup`;
    const restore = previousDataDir
      ? `Set-ItemProperty -Path 'HKCU:\\Software\\AI17Z' -Name DataDir -Value '${previousDataDir}' -ErrorAction SilentlyContinue`
      : `Remove-ItemProperty -Path 'HKCU:\\Software\\AI17Z' -Name DataDir -ErrorAction SilentlyContinue`;
    await powershell(
      [
        `Remove-Item -LiteralPath "${group}" -Recurse -Force -ErrorAction SilentlyContinue`,
        `Remove-Item -Path '${key}' -Recurse -Force -ErrorAction SilentlyContinue`,
        `Remove-ItemProperty -Path 'HKCU:\\Software\\AI17Z\\Installs' -Name '${program}' -Force -ErrorAction SilentlyContinue`,
        restore,
      ].join('; '),
    );
  };

  await rm(join(ROOM, label), { recursive: true, force: true });
  await mkdir(data, { recursive: true });

  say(`${label}: zipping the staged application`);
  const { createZip, sha256 } = await import('./zip');
  const zip = join(ROOM, 'AI17Z-App-verify.zip');
  const files = await createZip(stage, zip);
  const digest = await sha256(zip);
  say(`${label}: ${files} files, sha256 ${digest.slice(0, 16)}...`);

  const ports: Ports = {
    web: await freePort(PORT_BASE.web + 40),
    api: await freePort(PORT_BASE.api + 40),
    db: await freePort(PORT_BASE.db + 40),
  };
  // The ports are written before setup runs, because an installation that
  // already has an environment file keeps the ports in it -- which is the rule
  // that stops an update moving somebody's database. Writing them here is how
  // this phase gets ports that cannot collide with the developer's own copy.
  await writeFile(
    join(data, '.env'),
    `AI17Z_WEB_PORT=${ports.web}\r\nAI17Z_API_PORT=${ports.api}\r\nPOSTGRES_PORT=${ports.db}\r\n` +
      `DATABASE_URL=postgres://xbam:xbam@localhost:${ports.db}/xbam\r\n` +
      `AI17Z_MASTER_KEY=dGVzdC1vbmx5LW1hc3Rlci1rZXktMzItYnl0ZXMhISE=\r\n` +
      `AI17Z_INSTANCE=${instance}\r\n`,
    'utf8',
  );
  // Something of the owner's, in the place an update must never touch.
  await mkdir(join(data, 'storage'), { recursive: true });
  await writeFile(join(data, 'storage', 'owner-file.txt'), 'this must survive an update', 'utf8');

  const runSetup = async (args: string[]): Promise<{ out: string; code: number }> =>
    new Promise((done) => {
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', setup, ...args],
        { cwd: ROOM, env: { ...bareEnvironment(), AI17Z_NO_BROWSER: '1' }, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let out = '';
      child.stdout.on('data', (d) => (out += String(d)));
      child.stderr.on('data', (d) => (out += String(d)));
      child.on('exit', (code) => done({ out, code: code ?? -1 }));
    });

  const base = [
    '-InstanceName', instance,
    '-ProgramDir', program,
    '-DataDir', data,
    // Docker, Node, WSL and Chrome are this machine's, not this test's. The
    // harness is not a place to install system software.
    '-SkipDependencies',
    '-NoBrowser',
  ];

  try {
    // ---- 1. A package whose hash is wrong is refused ---------------------
    //
    // Run first, and against a program directory that does not exist yet, so
    // "nothing was installed" is something this can check rather than assert.
    const wrong = await runSetup([...base, '-LocalPackage', zip, '-ExpectedSha256', 'f'.repeat(64), '-NoStart']);
    if (wrong.code === 0) {
      fail(`${label}: a package whose hash does not match was installed anyway`, wrong.out.slice(-1500));
    }
    if (existsSync(join(program, 'package.json'))) {
      fail(`${label}: it wrote a program directory before the hash was checked`, wrong.out.slice(-1500));
    }
    say(`${label}: a package with the wrong hash was refused, and nothing was written`);

    // ---- 2. Install, for real, from the package --------------------------
    //
    // Without -NoStart, so the script does what it does for a person: builds
    // the images, applies the migrations, waits, and then checks AI17Z works
    // before it says so. That last part is the reason the flag is not passed
    // here -- a setup program that reports success without looking is the thing
    // this whole gate exists to stop shipping.
    say(`${label}: installing ${instance} to ${program}, and letting it start`);
    const installed = await runSetup([...base, '-LocalPackage', zip]);
    if (installed.code !== 0) fail(`${label}: the setup script failed`, installed.out.slice(-2000));
    if (!installed.out.includes('is ready')) {
      fail(`${label}: it finished without saying it had checked anything`, installed.out.slice(-2000));
    }
    if (!installed.out.includes(`localhost:${ports.web}`)) {
      fail(`${label}: it pointed at the wrong address`, installed.out.slice(-800));
    }

    for (const proof of ['package.json', 'AI17Z.cmd', 'data-location.txt', 'INSTALL_INFO.json', 'node_modules']) {
      if (!existsSync(join(program, proof))) {
        fail(`${label}: ${proof} is not in the installed program`, installed.out.slice(-1500));
      }
    }

    const info = JSON.parse(await readFile(join(program, 'INSTALL_INFO.json'), 'utf8')) as {
      channel: string;
      instance: string;
      programDir: string;
      dataDir: string;
    };
    if (info.channel !== 'BOOTSTRAP') fail(`${label}: the marker says ${info.channel}`, JSON.stringify(info));
    // The regression that matters: what was asked for is what was installed.
    if (info.instance !== instance) fail(`${label}: asked for ${instance}, installed ${info.instance}`, '');
    if (resolve(info.programDir) !== resolve(program)) {
      fail(`${label}: the name and the directory disagree`, `${info.programDir}\n${program}`);
    }
    if (resolve(info.dataDir) !== resolve(data)) {
      fail(`${label}: it pointed at the wrong data directory`, `${info.dataDir}\n${data}`);
    }
    const pointer = (await readFile(join(program, 'data-location.txt'), 'utf8')).trim();
    if (resolve(pointer) !== resolve(data)) fail(`${label}: data-location.txt points elsewhere`, pointer);

    // ---- 3. Start it, and prove it works ---------------------------------
    await start(label, program, ports);

    const expected = await migrationsOnDisk();
    const counted = await compose(program, data, [
      'exec', '-T', 'postgres', 'psql', '-U', 'xbam', '-d', 'xbam', '-tAc',
      'select count(*) from schema_migrations',
    ]);
    const applied = Number(counted.trim().split(/\r?\n/).pop());
    if (applied !== expected) fail(`${label}: ${applied} migrations applied, ${expected} on disk`, counted.trim());

    const health = await get(`http://localhost:${ports.api}/api/health`);
    if (health.status !== 200 || !health.body.includes('"status":"healthy"')) {
      fail(`${label}: the API is not healthy`, health.body.slice(0, 600));
    }
    await signInAndLook(label, ports);

    // ---- 4. Update over the top, and lose nothing ------------------------
    //
    // Through the installed `update-ai17z.ps1` rather than by calling the setup
    // script directly, because that is the whole chain a person sets off from
    // the Start Menu: read the marker, find the channel, hand over to the setup
    // script that installed this copy, naming it rather than discovering it.
    //
    // It is also the only way to exercise the part that cannot be reasoned
    // about from the outside -- the script doing the updating lives inside the
    // directory being replaced, and replaces itself.
    const before = await readFile(join(data, '.env'), 'utf8');
    say(`${label}: updating through the installed updater`);
    const updated = await shortcutWith(program, 'update-ai17z.ps1', ['-Package', zip, '-SkipStart']);
    if (updated.code !== 0) fail(`${label}: the update failed`, updated.stdout.slice(-2000));
    if (!updated.stdout.includes('AI17Z Setup')) {
      fail(`${label}: the updater did not hand over to the setup script`, updated.stdout.slice(-1500));
    }
    for (const proof of ['package.json', 'INSTALL_INFO.json', 'packaging']) {
      if (!existsSync(join(program, proof))) {
        fail(`${label}: the update left no ${proof}`, updated.stdout.slice(-1500));
      }
    }

    const after = await readFile(join(data, '.env'), 'utf8');
    if (after !== before) fail(`${label}: the update rewrote .env`, `before:\n${before}\nafter:\n${after}`);
    if (!existsSync(join(data, 'storage', 'owner-file.txt'))) {
      fail(`${label}: the update removed something from the data directory`, '');
    }
    if (!existsSync(join(program, 'package.json'))) fail(`${label}: the update left no program`, '');
  } finally {
    await teardown(label);
    await restoreMachineState();
    await rm(zip, { force: true }).catch(() => undefined);
  }
  say(`${label}: installed, updated, and nothing of the owner's was touched`);
}

/**
 * Three AI17Z installations, and an update to exactly one of them.
 *
 * This is the phase the whole multi-instance design exists for, and it is here
 * rather than in a unit test because the property is about files on a disk: not
 * "does the path helper return the right string" but "after updating B, are A
 * and C the same bytes they were".
 *
 * What went wrong once, and must stay impossible: a published installer took an
 * instance name, built the uninstall entry, the Start Menu group and the
 * desktop icon from it, and wrote the *files* into a different installation's
 * directory. Everything downstream believed the name. The disk disagreed.
 *
 * So this asserts against the disk. Three installations are made, each with its
 * own version marker, its own environment file, its own data and a file of its
 * owner's. One is updated. The other two are hashed before and after, file by
 * file, and any difference at all fails.
 *
 * No containers: what is under test is which directory gets replaced, and
 * starting three Docker projects to find that out would treble the time for
 * nothing. The bootstrap phase already proves an installation that starts.
 */
async function instances(stage: string): Promise<void> {
  const label = 'instances';
  const room = join(ROOM, label);
  await rm(room, { recursive: true, force: true });
  await mkdir(room, { recursive: true });

  const setup = join(root, 'packaging', 'windows', 'Setup-AI17Z.ps1');
  const { createZip, sha256 } = await import('./zip');

  // Two packages from one stage: the same application, and the same
  // application calling itself a different version. The second is what an
  // update looks like from the outside, and the version marker is how each
  // installation says which of the two it is holding.
  say(`${label}: building two packages from the staged application`);
  const stamp = join(stage, 'BUILD_INFO.json');
  const original = await readFile(stamp, 'utf8');
  const before = join(room, 'AI17Z-App-before.zip');
  const after = join(room, 'AI17Z-App-after.zip');
  await createZip(stage, before);
  try {
    const patched = JSON.parse(original) as Record<string, unknown>;
    patched.version = UPDATED_VERSION;
    patched.name = `AI17Z ${UPDATED_VERSION}`;
    await writeFile(stamp, `${JSON.stringify(patched, null, 2)}\n`, 'utf8');
    await createZip(stage, after);
  } finally {
    await writeFile(stamp, original, 'utf8');
  }
  say(`${label}: before ${(await sha256(before)).slice(0, 12)}, after ${(await sha256(after)).slice(0, 12)}`);

  const names = ['AI17Z-alpha', 'AI17Z-beta', 'AI17Z-gamma'];
  const where = (name: string) => ({
    program: join(room, name, 'program'),
    data: join(room, name, 'data'),
  });

  const runSetup = async (args: string[]): Promise<{ out: string; code: number }> =>
    new Promise((done) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', setup, ...args], {
        cwd: room,
        env: { ...bareEnvironment(), AI17Z_NO_BROWSER: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout.on('data', (d) => (out += String(d)));
      child.stderr.on('data', (d) => (out += String(d)));
      child.on('exit', (code) => setTimeout(() => done({ out, code: code ?? -1 }), 300));
    });

  // ---- Three installations, each its own everything ----------------------
  for (const name of names) {
    const { program, data } = where(name);
    await mkdir(data, { recursive: true });
    // Its own environment file, with its own ports, its own Docker project and
    // its own master key. These are the bytes an update must not touch.
    await writeFile(
      join(data, '.env'),
      [
        `AI17Z_WEB_PORT=${18500 + names.indexOf(name)}`,
        `AI17Z_API_PORT=${18600 + names.indexOf(name)}`,
        `POSTGRES_PORT=${55700 + names.indexOf(name)}`,
        `DATABASE_URL=postgres://xbam:xbam@localhost:${55700 + names.indexOf(name)}/xbam`,
        `AI17Z_MASTER_KEY=key-for-${name}-which-must-survive-everything`,
        `AI17Z_INSTANCE=${name.toLowerCase()}`,
        '',
      ].join('\r\n'),
      'utf8',
    );
    await mkdir(join(data, 'storage'), { recursive: true });
    await writeFile(join(data, 'storage', 'owner.txt'), `this belongs to ${name}`, 'utf8');

    const installed = await runSetup([
      '-InstanceName', name,
      '-ProgramDir', program,
      '-DataDir', data,
      '-LocalPackage', before,
      '-SkipDependencies', '-NoStart', '-NoBrowser',
    ]);
    if (installed.code !== 0) fail(`${label}: installing ${name} failed`, installed.out.slice(-1500));

    const info = JSON.parse(await readFile(join(program, 'INSTALL_INFO.json'), 'utf8')) as {
      instance: string;
      programDir: string;
      version: string;
    };
    if (info.instance !== name) fail(`${label}: ${name} installed itself as ${info.instance}`, '');
    if (resolve(info.programDir) !== resolve(program)) {
      fail(`${label}: ${name} recorded ${info.programDir}`, program);
    }
  }
  say(`${label}: ${names.join(', ')} installed, each with its own program, data and .env`);

  // ---- What the two that are not being updated look like now -------------
  const [alpha, target, gamma] = names as [string, string, string];
  const untouched = [alpha, gamma];
  const fingerprints = new Map<string, Map<string, string>>();
  for (const name of untouched) {
    const { program, data } = where(name);
    fingerprints.set(name, new Map([...(await hashTree(program)), ...(await hashTree(data))]));
  }

  // ---- Update exactly one, through its own updater -----------------------
  //
  // Not by calling the setup script: `update-ai17z.ps1` in an installation's
  // own folder is what its Start Menu entry runs and what the update screen
  // tells somebody to use, and it is the thing that has to target itself.
  say(`${label}: updating ${target} through its own update-ai17z.ps1`);
  const updated = await shortcutWith(where(target).program, 'update-ai17z.ps1', [
    '-Package', after,
    '-SkipStart',
  ]);
  if (updated.code !== 0) fail(`${label}: updating ${target} failed`, updated.stdout.slice(-2000));
  if (!updated.stdout.includes(target)) {
    fail(`${label}: the updater never said which installation it was updating`, updated.stdout.slice(-1200));
  }

  // ---- The one that was updated --------------------------------------------
  {
    const { program, data } = where(target);
    const stampNow = JSON.parse(await readFile(join(program, 'BUILD_INFO.json'), 'utf8')) as { version: string };
    if (stampNow.version !== UPDATED_VERSION) {
      fail(`${label}: ${target} still holds ${stampNow.version}`, `expected ${UPDATED_VERSION}`);
    }
    const env = await readFile(join(data, '.env'), 'utf8');
    if (!env.includes(`key-for-${target}-which-must-survive-everything`)) {
      fail(`${label}: ${target} lost its master key`, env);
    }
    if (!env.includes(`AI17Z_INSTANCE=${target.toLowerCase()}`)) {
      fail(`${label}: ${target} lost its Docker project name`, env);
    }
    if (!existsSync(join(data, 'storage', 'owner.txt'))) fail(`${label}: ${target} lost the owner's file`, '');
    const info = JSON.parse(await readFile(join(program, 'INSTALL_INFO.json'), 'utf8')) as { instance: string };
    if (info.instance !== target) fail(`${label}: ${target} is now called ${info.instance}`, '');
  }

  // ---- The two that were not ----------------------------------------------
  for (const name of untouched) {
    const { program, data } = where(name);
    const now = new Map([...(await hashTree(program)), ...(await hashTree(data))]);
    const then = fingerprints.get(name)!;
    const differences: string[] = [];
    for (const [file, hash] of then) {
      const current = now.get(file);
      if (current === undefined) differences.push(`gone:    ${file}`);
      else if (current !== hash) differences.push(`changed: ${file}`);
    }
    for (const file of now.keys()) if (!then.has(file)) differences.push(`added:   ${file}`);
    if (differences.length > 0) {
      fail(
        `${label}: updating ${target} changed ${differences.length} file(s) in ${name}`,
        differences.slice(0, 20).join('\n'),
      );
    }
    say(`${label}: ${name} is byte for byte what it was (${then.size} files)`);
  }

  // ---- The guard itself ----------------------------------------------------
  //
  // The updater updates the installation it is in. Asked for another one by
  // name, it must refuse rather than redirect -- the whole defect being guarded
  // against is a request for one identity acting on another.
  const misdirected = await shortcutWith(where(target).program, 'update-ai17z.ps1', [
    '-Instance', alpha,
    '-Package', after,
    '-SkipStart',
  ]);
  if (misdirected.code === 0) {
    fail(`${label}: ${target}'s updater accepted an instruction meant for ${alpha}`, misdirected.stdout.slice(-1200));
  }
  const alphaNow = new Map([...(await hashTree(where(alpha).program)), ...(await hashTree(where(alpha).data))]);
  for (const [file, hash] of fingerprints.get(alpha)!) {
    if (alphaNow.get(file) !== hash) fail(`${label}: the refused update still touched ${alpha}`, file);
  }
  say(`${label}: asked to update ${alpha} from inside ${target}, it refused and touched neither`);

  if (!keep) await rm(room, { recursive: true, force: true }).catch(() => undefined);
  say(`${label}: one installation updated, two untouched, and the wrong-target request refused`);
}

/**
 * Two installations, up at the same time, each still pointing at its own data.
 *
 * The two attempts above prove an installation works. They cannot prove two of
 * them coexist, because each is torn down before the next begins -- and
 * coexisting is exactly the case that broke: a second installation reused the
 * first one's program directory, and a program directory holds one
 * `data-location.txt`, so both shortcuts resolved to the second copy's data.
 * The native worker then served one installation while the other reported that
 * nothing could open a browser.
 *
 * What this asserts is the property rather than the symptom: two installations
 * on one machine are two of everything a person can reach -- program directory,
 * data directory, Docker project, ports, and the pointer that ties the first to
 * the second.
 */
async function sideBySide(stage: string): Promise<void> {
  const labels = ['sbs-one', 'sbs-two'];
  const started: { label: string; program: string; data: string; ports: Ports }[] = [];

  try {
    for (const label of labels) {
      const program = join(ROOM, label, 'program');
      const data = join(ROOM, label, 'data');
      await rm(join(ROOM, label), { recursive: true, force: true });
      await mkdir(program, { recursive: true });
      await mkdir(data, { recursive: true });

      // Ports are asked for one installation at a time, exactly as the wizard
      // does, so the second genuinely has to step over the first.
      const ports: Ports = {
        web: await freePort(PORT_BASE.web + 20 + started.length * 10),
        api: await freePort(PORT_BASE.api + 20 + started.length * 10),
        db: await freePort(PORT_BASE.db + 20 + started.length * 10),
      };

      say(`${label}: installing to ${program}`);
      await install(stage, program, data, ports);
      await start(label, program, ports);
      started.push({ label, program, data, ports });
    }

    // Everything that identifies an installation has to differ.
    const seen = new Map<string, string[]>();
    const note = (what: string, value: string, label: string) => {
      const key = `${what}=${value}`;
      seen.set(key, [...(seen.get(key) ?? []), label]);
    };

    for (const one of started) {
      const env = await readFile(join(one.data, '.env'), 'utf8');
      const project = env.match(/^[ \t]*AI17Z_INSTANCE[ \t]*=[ \t]*(\S+)/m)?.[1] ?? '';
      note('docker project', project, one.label);
      note('web port', String(one.ports.web), one.label);
      note('data directory', one.data, one.label);
      note('program directory', one.program, one.label);

      // The pointer the shortcuts follow. This is the one that actually broke:
      // it lives in the program directory, and there is only ever one of it.
      const pointer = (await readFile(join(one.program, 'data-location.txt'), 'utf8').catch(() => '')).trim();
      if (pointer !== one.data) {
        fail(
          `${one.label}: its program directory points at another installation's data`,
          `data-location.txt says ${pointer || '(nothing)'}, and this installation's data is ${one.data}`,
        );
      }
    }

    for (const [key, owners] of seen) {
      if (owners.length > 1) {
        fail('two installations share something they must not', `${key} is used by ${owners.join(' and ')}`);
      }
    }

    // And both are actually usable at once, which is the point of having two.
    for (const one of started) {
      await withTimeout(`${one.label}: signing in`, 3 * 60_000, signInAndLook(one.label, one.ports));
    }

    say('two installations ran side by side, each with its own everything');
  } finally {
    for (const one of started) await teardown(one.label);
  }
}

async function upgradeBody(stage: string): Promise<void> {
  const label = 'upgrade';
  const program = join(ROOM, label, 'program');
  const data = join(ROOM, label, 'data');
  await rm(join(ROOM, label), { recursive: true, force: true });
  await mkdir(program, { recursive: true });
  await mkdir(data, { recursive: true });

  const ports: Ports = {
    web: await freePort(PORT_BASE.web + 200),
    api: await freePort(PORT_BASE.api + 200),
    db: await freePort(PORT_BASE.db + 100),
  };
  const marker = `written-before-the-upgrade-${Date.now()}`;

  const projectOf = async (): Promise<string | null> => {
    try {
      const text = await readFile(join(data, '.env'), 'utf8');
      return text.match(/^[ \t]*AI17Z_INSTANCE[ \t]*=[ \t]*(\S+)/m)?.[1] ?? null;
    } catch {
      return null;
    }
  };
  const psql = async (sql: string): Promise<string> =>
    (await compose(program, data, ['exec', '-T', 'postgres', 'psql', '-U', 'xbam', '-d', 'xbam', '-tAc', sql])).trim();

  say(`${label}: installing, starting, and writing something into the database`);
  await install(stage, program, data, ports);
  await start(label, program, ports);

  // Overwritten rather than inserted, because a previous *failed* run of this
  // case leaves its volume behind -- the room path is fixed, so the project
  // digest is too -- and a stale row would otherwise abort the next run with a
  // duplicate key. The value carries this run's timestamp, so reading it back
  // still proves that this run's write is what survived.
  await psql(
    `INSERT INTO app_settings (key, value) VALUES ('verify.marker', '"${marker}"') ` +
      `ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
  );
  const before = await projectOf();
  const migrationsBefore = await psql('select count(*) from schema_migrations');
  await shortcut(program, 'stop-ai17z.ps1');

  say(`${label}: installing again over the top`);
  // The program directory is replaced on an upgrade and the data directory is
  // not -- that is the whole property being tested, and it is what the
  // uninstaller's [UninstallDelete] and the docs both say happens.
  //
  // Cleared rather than merged into, for a reason of this harness's own: npm
  // links every workspace into node_modules, so `node_modules/@xbam/api` is a
  // symlink to `apps/api`, and copying a tree onto itself follows that link and
  // recurses into the source. Setup resolves those links when it packs; nothing
  // here needs to reproduce that to answer the question being asked.
  await rm(program, { recursive: true, force: true });
  await mkdir(program, { recursive: true });
  await install(stage, program, data, ports);

  // Make the second install a different *version*, which is what an upgrade
  // actually is.
  //
  // Without this the two installs are byte-identical and the interesting
  // question cannot be asked: `docker compose up -d` builds only when an image
  // is missing, so an upgrade used to go on serving the images built for the
  // version before it. Somebody downloaded a fix, ran the installer, launched
  // AI17Z and saw the identical fault. Changing the stamp here is exactly what
  // a real new release does, and the assertion after the start is that the
  // images moved with it.
  const upgradedVersion = `9.9.9-verify-${Date.now()}`;
  const stampPath = join(program, 'BUILD_INFO.json');
  const stampBefore = JSON.parse(await readFile(stampPath, 'utf8')) as Record<string, unknown>;
  await writeFile(
    stampPath,
    `${JSON.stringify({ ...stampBefore, version: upgradedVersion }, null, 2)}\n`,
    'utf8',
  );

  const imageStamp = async (service: string): Promise<string | null> => {
    // `{{json .Config.Labels}}`, never `{{index .Config.Labels "..."}}`: a
    // double quote does not survive Windows PowerShell's native argument
    // passing, and the broken template prints an empty line that reads exactly
    // like a missing label.
    const { stdout } = await run('docker', [
      'inspect',
      '--format',
      '{{json .Config.Labels}}',
      `${before}-${service}`,
    ]).catch(() => ({ stdout: '' }));
    try {
      return (JSON.parse(stdout.trim() || 'null') as Record<string, string> | null)?.['ai17z.built-from'] ?? null;
    } catch {
      return null;
    }
  };
  const webBefore = await imageStamp('web');

  const envAfter = await readFile(join(data, '.env'), 'utf8');
  if (!envAfter.includes(`AI17Z_INSTANCE=${before}`)) {
    fail(`${label}: the upgrade changed the Docker project`, `was ${before}\n${envAfter}`);
  }
  if (!/^[ \t]*AI17Z_MASTER_KEY[ \t]*=[ \t]*\S/m.test(envAfter)) {
    fail(`${label}: the upgrade lost the master key`, 'every stored provider credential would be unreadable');
  }

  await start(label, program, ports);

  const after = await projectOf();
  if (after !== before) fail(`${label}: the project name moved`, `${before} -> ${after}`);

  const survived = await psql(`select value->>0 from app_settings where key = 'verify.marker'`);
  if (!survived.includes(marker)) {
    fail(`${label}: the data did not survive the upgrade`, `expected ${marker}, database said "${survived}"`);
  }
  const migrationsAfter = await psql('select count(*) from schema_migrations');
  if (migrationsAfter !== migrationsBefore) {
    fail(`${label}: the migration count changed`, `${migrationsBefore} -> ${migrationsAfter}`);
  }

  // The upgrade has to actually run the code it installed.
  //
  // This is the assertion that was missing, and its absence is why a release
  // could have been published that nobody who already had AI17Z could receive:
  // the data survived, the project name held, every check here passed, and the
  // interface being served was the previous version's.
  const webAfter = await imageStamp('web');
  if (!webAfter) {
    fail(`${label}: the web image does not say what it was built from`, 'nothing can tell whether an upgrade rebuilt');
  }
  if (webAfter === webBefore) {
    fail(
      `${label}: the upgrade did not rebuild`,
      `the web image still holds ${webBefore}, so this installation is serving the version before the upgrade.\n` +
        `The installed stamp is ${upgradedVersion}.`,
    );
  }
  // And it is running what was just installed, not merely something newer.
  if (!webAfter.startsWith(upgradedVersion)) {
    fail(`${label}: the web image is not the installed version`, `image holds ${webAfter}, installed ${upgradedVersion}`);
  }

  // The interface, again, because an upgrade that rebuilds into a broken bundle
  // is the same outcome as one that does not rebuild at all.
  await withTimeout(`${label}: signing in`, 3 * 60_000, signInAndLook(label, ports));

  say(`${label}: same project, same database, master key intact, and it rebuilt`);
}

async function main(): Promise<void> {
  process.stdout.write('\nAI17Z: installing from scratch and driving every entry point\n\n');

  const stage = join(ROOM, 'stage');
  await rm(ROOM, { recursive: true, force: true });
  await mkdir(ROOM, { recursive: true });

  say('staging the application');
  await run('npm', ['run', 'package:windows'], {
    cwd: root,
    shell: true,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, AI17Z_STAGE_DIR: stage },
  });
  if (!existsSync(join(stage, 'package.json'))) throw new Error('the packager produced nothing');

  const projects: string[] = [];
  projects.push(await attempt('first', stage));
  // A first-run bug is invisible on the second run, and a second-run bug is
  // invisible on the first. Both have shipped.
  if (twice) projects.push(await attempt('second', stage));

  // Two installations, two projects. They shared one when the name came from
  // the data folder alone, and two directories both ending in \data is the
  // ordinary case rather than a contrived one.
  if (projects.length > 1 && new Set(projects).size !== projects.length) {
    fail('two installations share a Docker project', projects.join('\n'));
  }

  // Two at once, which the two attempts above cannot show: each tears down
  // before the next begins, and coexisting is the case that broke.
  if (twice) await sideBySide(stage);

  // The same application, installed by the script the install command fetches.
  if (alsoBootstrap) await bootstrap(stage);

  // Three of them, and an update to one.
  if (alsoInstances) await instances(stage);

  // The path where a mistake is worst, and the last one that was untested.
  if (alsoUpgrade) await upgrade(stage);

  if (!keep) await rm(ROOM, { recursive: true, force: true }).catch(() => undefined);
  process.stdout.write('\n  Installed, started, checked and stopped. Nothing else was touched.\n\n');
}

try {
  await main();
} catch (error) {
  process.stderr.write(`\n  ${error instanceof Failed ? error.message : (error as Error).message}\n\n`);
  process.exit(1);
}
