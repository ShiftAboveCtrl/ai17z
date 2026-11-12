import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The native worker never opens a console on Windows.
 *
 * An empty window is what the owner sees when a spawn forgets to hide itself.
 * The supervisor starts the worker and, when it has to stop it, taskkill.
 * Both of those are Node spawns, so each carries windowsHide. The launcher is
 * the other way the installed copy starts that supervisor, and it does it
 * through Start-Process, which hides with -WindowStyle Hidden.
 */

const root = resolve(import.meta.dirname, '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('the native worker stays out of sight', () => {
  it('hides both processes the supervisor starts', () => {
    const source = read('scripts/supervise-worker.mts');
    const spawns = [...source.matchAll(/spawn\(\s*(?:'[^']+'|process\.execPath)[\s\S]*?\}\s*,?\s*\)/g)].map((m) => m[0]);
    expect(spawns.length).toBeGreaterThanOrEqual(2);
    for (const spawn of spawns) expect(spawn, spawn.slice(0, 40)).toContain('windowsHide: true');
  });

  it('hides every shipped script that starts the supervised worker', () => {
    const shipped = [
      'start-ai17z.ps1',
      'update-ai17z.ps1',
      'stop-ai17z.ps1',
      'launch-ai17z.ps1',
      'packaging/windows/Setup-AI17Z.ps1',
      'packaging/windows/Uninstall-AI17Z.ps1',
      'packaging/windows/Stop-ForUninstall.ps1',
      'packaging/windows/Install-Prerequisites.ps1',
    ].map(read);
    const starters = shipped.filter((source) => /worker:supervised|supervise-worker\.mts/.test(source));
    expect(starters).toHaveLength(1);
    for (const source of starters) expect(source).toMatch(/-WindowStyle\s+Hidden/);
  });
});
