import { describe, expect, it } from 'vitest';
import { providers as providersRepo, query } from '@xbam/database';
import { redact } from '@xbam/shared';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';

installHarness();

/**
 * A provider key must not come back out, by any route.
 *
 * Tested with a sentinel rather than by reading the code: a string that appears
 * nowhere else, sealed through the real path, then looked for everywhere a
 * secret could plausibly surface. If the sentinel turns up in a row, a log line
 * or an API shape, the leak is real regardless of what the code looked like.
 */

const SENTINEL = 'sk-sentinel-3f9a2c7e-do-not-leak-4b81d05a';

async function seal(ownerId: string): Promise<string> {
  const provider = await providersRepo.createProvider({
    ownerId,
    provider: 'openai',
    label: `sentinel-${Date.now().toString(36)}`,
    apiKey: SENTINEL,
    availableModels: ['gpt-4o-mini'],
    defaultModel: 'gpt-4o-mini',
  });
  return provider.id;
}

describe('a sealed provider key', () => {
  it('is not stored anywhere in plain text', async () => {
    const fixture = await createFixture();
    await seal(fixture.ownerId);

    // Every text-ish column of every table, asked directly. Slower than
    // checking the one column it is supposed to be in, and that is the point:
    // the interesting leak is the copy somebody made somewhere else.
    const columns = await query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public'
          AND data_type IN ('text','character varying','jsonb','json')`,
    );

    const found: string[] = [];
    for (const column of columns) {
      const [hit] = await query<{ n: number }>(
        `SELECT count(*)::int AS n FROM "${column.table_name}"
          WHERE "${column.column_name}"::text LIKE $1`,
        [`%${SENTINEL}%`],
      ).catch(() => [{ n: 0 }]);
      if ((hit?.n ?? 0) > 0) found.push(`${column.table_name}.${column.column_name}`);
    }

    expect(found).toEqual([]);
  });

  it('is readable only through the one function meant to read it', async () => {
    const fixture = await createFixture();
    const id = await seal(fixture.ownerId);

    // The sealed value round-trips, so this is encryption and not deletion.
    expect(await providersRepo.getDecryptedApiKey(id)).toBe(SENTINEL);

    // And the ordinary read gives nothing usable.
    const listed = await providersRepo.listProviders(fixture.ownerId);
    expect(JSON.stringify(listed)).not.toContain(SENTINEL);
  });

  it('does not survive redaction into a log line', () => {
    // The shapes a key actually arrives in when somebody logs a config object.
    for (const shape of [
      { apiKey: SENTINEL },
      { api_key: SENTINEL },
      { provider: { apiKey: SENTINEL } },
      { credentials: [{ token: SENTINEL }] },
      { headers: { authorization: `Bearer ${SENTINEL}` } },
      { secret: SENTINEL },
      { password: SENTINEL },
    ]) {
      expect(JSON.stringify(redact(shape))).not.toContain(SENTINEL);
    }
  });

  it('is not written into a trace event', async () => {
    const fixture = await createFixture();
    await seal(fixture.ownerId);
    const [hit] = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM trace_events WHERE data::text LIKE $1 OR message LIKE $1`,
      [`%${SENTINEL}%`],
    );
    expect(hit!.n).toBe(0);
  });
});

describe('the master key', () => {
  // Resolved once and cached for the life of the process, so these run in a
  // fresh one. Changing the environment variable in this process proves
  // nothing: the key was already read.
  const runFresh = async (env: Record<string, string | undefined>, body: string) => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const script = `import { sealSecret, openSecret } from '@xbam/shared';
${body}`;
    const { writeFile, rm } = await import('node:fs/promises');
    const file = `tools/.master-key-probe-${Date.now().toString(36)}.mts`;
    await writeFile(file, script, 'utf8');
    try {
      const result = await run('npx', ['tsx', file], {
        env: { ...process.env, ...env } as NodeJS.ProcessEnv,
        timeout: 60_000,
        shell: true,
      });
      return { ok: true, out: `${result.stdout}${result.stderr}` };
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string };
      return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    } finally {
      await rm(file, { force: true });
    }
  };

  it('fails loudly when there is no key at all', async () => {
    // Silently generating one would strand every secret already sealed under
    // the old key, and nothing would say so until a provider call failed.
    const result = await runFresh(
      { AI17Z_MASTER_KEY: undefined, XBAM_MASTER_KEY: undefined },
      `try { sealSecret('anything'); console.log('SEALED_WITHOUT_A_KEY'); }
       catch (e) { console.log('REFUSED:' + (e as Error).message); }`,
    );
    expect(result.out).not.toContain('SEALED_WITHOUT_A_KEY');
    expect(result.out).toMatch(/REFUSED:.*MASTER_KEY/i);
  });

  it('refuses a key that is not thirty-two bytes', async () => {
    const result = await runFresh(
      { AI17Z_MASTER_KEY: Buffer.from('too short').toString('base64'), XBAM_MASTER_KEY: undefined },
      `try { sealSecret('anything'); console.log('ACCEPTED_A_SHORT_KEY'); }
       catch (e) { console.log('REFUSED:' + (e as Error).message); }`,
    );
    expect(result.out).not.toContain('ACCEPTED_A_SHORT_KEY');
    expect(result.out).toMatch(/REFUSED:.*32 bytes/i);
  });

  it('refuses to open a secret sealed under a different key', async () => {
    // Returning rubbish instead would mean an agent sending a mangled key to a
    // provider and getting a confusing 401 rather than a clear failure.
    const keyA = Buffer.from('A'.repeat(32)).toString('base64');
    const keyB = Buffer.from('B'.repeat(32)).toString('base64');

    const sealed = await runFresh(
      { AI17Z_MASTER_KEY: keyA, XBAM_MASTER_KEY: undefined },
      `console.log('SEALED=' + JSON.stringify(sealSecret('the-sentinel-value')));`,
    );
    const payload = sealed.out.match(/SEALED=(.+)/)?.[1]?.trim();
    expect(payload).toBeTruthy();

    const opened = await runFresh(
      { AI17Z_MASTER_KEY: keyB, XBAM_MASTER_KEY: undefined },
      `try { console.log('OPENED:' + openSecret(${JSON.stringify(payload)} as never)); }
       catch (e) { console.log('REFUSED:' + (e as Error).message); }`,
    );
    expect(opened.out).not.toContain('the-sentinel-value');
    expect(opened.out).toMatch(/REFUSED:/);
  });
});
