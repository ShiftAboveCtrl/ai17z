import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyBrandCompatibility } from '@xbam/shared';

const root = resolve(__dirname, '../..');

/**
 * Which name wins when a setting has both.
 *
 * Every installation made before the rename has XBAM_* in its .env, and the
 * documentation tells people to set AI17Z_*. Reading the legacy name directly
 * meant the branded one was accepted, mirrored nowhere, and silently ignored:
 * a scratch API told to listen on 8799 bound 8787 instead, which is the port an
 * entirely different installation was serving its interface from.
 *
 * The mirror was never wrong. The call sites were reading the wrong side of it.
 */
describe('settings are read under the branded name', () => {
  it('no runtime code reads a legacy variable directly', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = resolve(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
          walk(full);
        } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
          const text = readFileSync(full, 'utf8');
          if (/env(?:Int|String|Bool)\('XBAM_/.test(text)) offenders.push(full.replace(root, ''));
        }
      }
    };
    walk(resolve(root, 'apps'));
    walk(resolve(root, 'packages'));
    expect(offenders, 'these read the legacy name first, so the branded one is ignored').toEqual([]);
  });

  it('a legacy-only environment still works, which is the point of the mirror', () => {
    const env: NodeJS.ProcessEnv = { XBAM_API_PORT: '8787' };
    applyBrandCompatibility(env);
    expect(env.AI17Z_API_PORT).toBe('8787');
  });

  it('the branded name is left alone when both are set', () => {
    // Reading AI17Z_ first is what makes this the winning value; the mirror
    // must not overwrite it with the legacy one.
    const env: NodeJS.ProcessEnv = { XBAM_API_PORT: '8787', AI17Z_API_PORT: '8799' };
    applyBrandCompatibility(env);
    expect(env.AI17Z_API_PORT).toBe('8799');
  });

  it('an empty legacy value does not block the branded one', () => {
    const env: NodeJS.ProcessEnv = { XBAM_MASTER_KEY: '', AI17Z_MASTER_KEY: 'real' };
    applyBrandCompatibility(env);
    expect(env.AI17Z_MASTER_KEY).toBe('real');
    expect(env.XBAM_MASTER_KEY).toBe('real');
  });
});
