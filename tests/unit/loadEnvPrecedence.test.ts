import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `loadEnv`'s order of precedence, exercised rather than described.
 *
 * The observed failure: an installed worker launched from a shell whose current
 * directory was a development checkout loaded the *checkout's* `.env`. It then
 * connected to the development database and opened Chrome on a profile under
 * the checkout's `storage`, while writing its log into the installation's own
 * folder -- so every symptom pointed at the installation and every cause was
 * somewhere else.
 *
 * This test reproduces exactly that arrangement: a real installation on disk, a
 * real checkout with its own `.env`, cwd set to the checkout, and the entry
 * script inside the installation. Before the fix it loaded the checkout's file.
 */
function makeMachine() {
  const root = mkdtempSync(join(tmpdir(), 'ai17z-env-'));
  const program = join(root, 'Programs', 'AI17Z-test');
  const data = join(root, 'Data', 'AI17Z-test');
  const checkout = join(root, 'XBAM');
  const entry = join(program, 'apps', 'worker', 'src');
  for (const dir of [program, data, checkout, entry]) mkdirSync(dir, { recursive: true });

  writeFileSync(join(program, 'data-location.txt'), data, 'utf8');
  writeFileSync(join(data, '.env'), 'AI17Z_ENV_PROBE=installation\n', 'utf8');
  writeFileSync(join(checkout, '.env'), 'AI17Z_ENV_PROBE=checkout\n', 'utf8');
  return { root, program, data, checkout, entry };
}

/** A fresh module registry each time, because loadEnv runs once per process. */
async function loadWith(cwd: string, entryScript: string): Promise<string | undefined> {
  vi.resetModules();
  const originalCwd = process.cwd;
  const originalArgv = process.argv[1];
  process.cwd = () => cwd;
  process.argv[1] = entryScript;
  try {
    const { loadEnv } = await import('@xbam/shared');
    loadEnv();
    return process.env.AI17Z_ENV_PROBE;
  } finally {
    process.cwd = originalCwd;
    if (originalArgv === undefined) delete process.argv[1];
    else process.argv[1] = originalArgv;
  }
}

let machine: ReturnType<typeof makeMachine>;

beforeEach(() => {
  machine = makeMachine();
  delete process.env.AI17Z_ENV_PROBE;
  delete process.env.AI17Z_ENV_FILE;
  delete process.env.XBAM_ENV_FILE;
});

afterEach(() => {
  delete process.env.AI17Z_ENV_PROBE;
  delete process.env.AI17Z_ENV_FILE;
  delete process.env.XBAM_ENV_FILE;
});

describe('which environment file an installed process loads', () => {
  it('loads its own even when started inside another AI17Z tree', async () => {
    // The exact arrangement that broke: cwd in the checkout, program elsewhere.
    const value = await loadWith(machine.checkout, join(machine.entry, 'main.ts'));
    expect(value).toBe('installation');
  });

  it('loads its own when started from its own directory', async () => {
    const value = await loadWith(machine.program, join(machine.entry, 'main.ts'));
    expect(value).toBe('installation');
  });

  it('loads its own when started from somewhere unrelated', async () => {
    const value = await loadWith(machine.root, join(machine.entry, 'main.ts'));
    expect(value).toBe('installation');
  });

  it('still lets an explicit environment file win', async () => {
    // The launcher sets this, and it stays the highest authority: an owner who
    // moved their data must be able to say so.
    process.env.AI17Z_ENV_FILE = join(machine.checkout, '.env');
    const value = await loadWith(machine.program, join(machine.entry, 'main.ts'));
    expect(value).toBe('checkout');
  });

  it('records where it loaded from, so a diagnostic can say', async () => {
    await loadWith(machine.checkout, join(machine.entry, 'main.ts'));
    expect(process.env.AI17Z_ENV_FILE).toBe(join(machine.data, '.env'));
  });

  it('keeps the development walk when there is no installation above it', async () => {
    // A developer running tsx from anywhere in the checkout must be unaffected.
    const value = await loadWith(machine.checkout, join(machine.checkout, 'apps', 'api', 'src', 'main.ts'));
    expect(value).toBe('checkout');
  });
});
