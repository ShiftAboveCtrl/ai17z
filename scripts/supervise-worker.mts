#!/usr/bin/env node
/**
 * Keeps the native worker running.
 *
 * The native worker is the only process that can drive a real browser, and it
 * was started with nothing watching it: if it died, the agent stopped, and
 * until health learned about workers there was no sign of it either.
 *
 * All the judgement lives in `decideRestart` in @xbam/shared, which is pure and
 * tested. This file is the part that cannot be: spawning, waiting, and killing
 * a process tree.
 *
 * Two things it deliberately does not do. It does not restart a process that
 * exited cleanly or was killed, because that is somebody stopping it on
 * purpose. And it does not restart for ever: a worker that cannot start fails
 * in a second, and a thousand identical failures are no more informative than
 * the first.
 *
 * Usage: npm run worker:supervised
 */
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostname } from 'node:os';
import { decideRestart, heartbeatIsStale, loadEnv, type RunOutcome } from '@xbam/shared';
import { workers as workersRepo, WORKER_PRESENT_SECONDS } from '@xbam/database';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const logPath = join(root, 'storage', 'native-worker.log');
const pidPath = join(root, 'storage', 'supervisor.pid');

mkdirSync(join(root, 'storage'), { recursive: true });
writeFileSync(pidPath, String(process.pid), 'utf8');

/** One line, to the console and to the log the start script tells people about. */
function say(message: string): void {
  const line = `${new Date().toISOString()} supervisor ${message}\n`;
  process.stdout.write(line);
  try {
    appendFileSync(logPath, line, 'utf8');
  } catch {
    // A log that cannot be written is not a reason to stop supervising.
  }
}

let child: ReturnType<typeof spawn> | null = null;
let stopping = false;

/**
 * Ends the worker and everything it started.
 *
 * `npm run dev:worker` starts tsx which starts the worker, so killing only the
 * pid we hold leaves the one that matters running -- and a leaked worker keeps
 * polling and opening its own browsers. On Windows that means taskkill /T.
 */
function killTree(pid: number): void {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // Already gone, which is the outcome we wanted.
      }
    }
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true;
    say(`asked to stop (${signal}).`);
    if (child?.pid) killTree(child.pid);
    try {
      rmSync(pidPath, { force: true });
    } catch {
      // Nothing to clean up.
    }
    process.exit(0);
  });
}

const workerArgs = process.argv.slice(2);

loadEnv();

/**
 * The worker's identity, chosen here so the supervisor can ask after it.
 *
 * The worker would otherwise pick its own (hostname-pid), which changes on
 * every restart and which nothing out here could look up.
 */
const workerId = process.env.AI17Z_WORKER_ID || `supervised-${hostname()}-${process.pid}`;
process.env.AI17Z_WORKER_ID = workerId;

/** How long since this worker last said it was alive, or null if unknown. */
async function sinceLastHeartbeat(): Promise<number | null> {
  try {
    const seen = await workersRepo.lastSeen(workerId);
    return seen ? Date.now() - Date.parse(seen) : null;
  } catch {
    // A database that cannot be reached answers nothing, and killing a worker
    // over an unanswered question is how a blip becomes an outage.
    return null;
  }
}

/** Runs the worker once, resolving with how it ended. */
function runOnce(): Promise<RunOutcome> {
  return new Promise<RunOutcome>((resolve) => {
    const startedAt = Date.now();
    child = spawn(
      process.execPath,
      [join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(root, 'apps', 'worker', 'src', 'main.ts'), ...workerArgs],
      {
        cwd: root,
        stdio: ['ignore', 'inherit', 'inherit'],
        // Its own group on POSIX, so the whole tree can be signalled at once.
        detached: process.platform !== 'win32',
        env: process.env,
      },
    );

    // A process being alive is not the same as a worker running. The failure
    // that actually happened was an unhandled rejection under `tsx watch`: the
    // worker stopped doing anything and the process stayed up, so nothing
    // exited and nothing restarted. The heartbeat is the only thing that can
    // tell the two apart.
    const pulse = setInterval(() => {
      void (async () => {
        if (!child?.pid) return;
        const lastSeenMs = await sinceLastHeartbeat();
        if (
          heartbeatIsStale({
            ranForMs: Date.now() - startedAt,
            lastSeenMs,
            presentWithinMs: WORKER_PRESENT_SECONDS * 1000,
          })
        ) {
          say(
            `the worker process is alive but has not checked in for ${Math.round((lastSeenMs ?? 0) / 1000)}s. Restarting it.`,
          );
          killTree(child.pid);
        }
      })();
    }, 30_000);

    child.on('exit', (code) => {
      clearInterval(pulse);
      child = null;
      resolve({ ranForMs: Date.now() - startedAt, code });
    });

    child.on('error', (error) => {
      clearInterval(pulse);
      child = null;
      say(`could not start the worker: ${error.message}`);
      // Treated as an immediate failure, which is what it is, so the same
      // give-up budget applies rather than a separate path nobody tests.
      resolve({ ranForMs: 0, code: 1 });
    });
  });
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

say('starting the worker.');
let quickFailures = 0;
while (!stopping) {
  const outcome = await runOnce();
  if (stopping) break;

  const decision = decideRestart(outcome, quickFailures);
  quickFailures = decision.quickFailures;
  say(decision.reason);

  if (!decision.restart) {
    try {
      rmSync(pidPath, { force: true });
    } catch {
      // Nothing to clean up.
    }
    // Non-zero, so whatever started this knows the worker is not running.
    process.exit(outcome.code === 0 || outcome.code === null ? 0 : 1);
  }

  if (decision.delayMs > 0) await wait(decision.delayMs);
}
