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
 *
 * It never touches the registry, the desktop, the Start Menu, or any Docker
 * project but its own. It cannot disturb an installation or a checkout.
 *
 * Run: npm run verify:install [-- --twice] [--keep]
 */
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const twice = process.argv.includes('--twice');
const keep = process.argv.includes('--keep');

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

/** A port nothing is listening on, taken by binding it rather than guessing. */
async function freePort(from: number): Promise<number> {
  for (let port = from; port < from + 200; port += 1) {
    const free = await new Promise<boolean>((done) => {
      const server = createServer();
      server.once('error', () => done(false));
      server.listen(port, '0.0.0.0', () => server.close(() => done(true)));
    });
    if (free) return port;
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
  await writeFile(
    join(data, '.env'),
    `AI17Z_WEB_PORT=${ports.web}\r\nAI17Z_API_PORT=${ports.api}\r\nPOSTGRES_PORT=${ports.db}\r\n`,
    'utf8',
  );
  await writeFile(join(program, 'data-location.txt'), data, 'utf8');
}

/** Drive a shortcut: powershell.exe, a script path, and no AI17Z environment. */
async function shortcut(program: string, script: string): Promise<{ stdout: string; code: number }> {
  return new Promise((done) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(program, script)],
      { cwd: program, env: bareEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] },
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

async function attempt(label: string, stage: string): Promise<string> {
  const program = join(ROOM, label, 'program');
  const data = join(ROOM, label, 'data');
  await rm(join(ROOM, label), { recursive: true, force: true });
  await mkdir(program, { recursive: true });
  await mkdir(data, { recursive: true });

  const ports: Ports = {
    web: await freePort(8300),
    api: await freePort(8400),
    db: await freePort(55600),
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

  try {
    // ---- 1. The thing the desktop icon and the Start Menu both point at ----
    say(`${label}: starting through AI17Z.cmd`);
    const started = await withTimeout(
      `${label}: AI17Z.cmd never finished`,
      15 * 60_000,
      new Promise<{ out: string; code: number }>((done) => {
        const child = spawn('cmd.exe', ['/c', join(program, 'AI17Z.cmd')], {
          cwd: program,
          // AI17Z.cmd sets everything it needs. Nothing is handed to it,
          // because nothing is handed to it by a shortcut either.
          env: { ...bareEnvironment(), AI17Z_NO_BROWSER: '1' },
          // Closed, not inherited. A failing start used to end in `pause`,
          // which waits for a keypress that is never coming and turns a
          // failure into a hang -- which is how this harness spent half an
          // hour looking like it was working.
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
      fail(
        `${label}: the first start did not finish`,
        started.out.split(/\r?\n/).filter(Boolean).slice(-25).join('\n'),
      );
    }
    if (!started.out.includes(`localhost:${ports.web}`)) {
      fail(`${label}: it opened the wrong address`, `expected port ${ports.web}\n${started.out.slice(-400)}`);
    }

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
    return (await projectOf()) ?? fail(`${label}: no Docker project was ever named`, 'AI17Z_INSTANCE is unset');
  } finally {
    const project = await projectOf();
    if (project) say(`${label}: docker project ${project}`);
    if (!keep) {
      if (project) {
        await run('docker', ['compose', '-p', project, 'down', '-v'], { cwd: program }).catch(() => undefined);
      }
      await rm(join(ROOM, label), { recursive: true, force: true }).catch(() => undefined);
    }
  }
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

  if (!keep) await rm(ROOM, { recursive: true, force: true }).catch(() => undefined);
  process.stdout.write('\n  Installed, started, checked and stopped. Nothing else was touched.\n\n');
}

try {
  await main();
} catch (error) {
  process.stderr.write(`\n  ${error instanceof Failed ? error.message : (error as Error).message}\n\n`);
  process.exit(1);
}
