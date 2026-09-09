import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const hooks = readFileSync(resolve(root, 'apps/web/src/lib/hooks.ts'), 'utf8');
const useResource = hooks.slice(hooks.indexOf('export function useResource'));

/**
 * Flicking between two areas should not refetch the whole application.
 *
 * The agent page renders one area at a time, so moving between two of them
 * unmounts every section in the first and mounts every section in the second.
 * Clicking Reach, Memory, Reach, Memory, Reach asked for accounts, providers,
 * tools, memories, knowledge, relationships and learned items eighteen times
 * over, for data that had not changed in the four seconds it took.
 */
describe('reusing an answer that is seconds old', () => {
  it('keeps the window short enough to be a decision, not a cache', () => {
    // Long enough to cover clicking between areas; far too short to show
    // anybody a value that has since changed.
    const match = hooks.match(/const FRESH_MS = ([\d_]+);/);
    expect(match, 'FRESH_MS is gone').toBeTruthy();
    const ms = Number((match![1] ?? '').replace(/_/g, ''));
    expect(ms).toBeGreaterThan(500);
    expect(ms).toBeLessThanOrEqual(5_000);
  });

  it('never serves a reload from it', () => {
    /*
      A reload follows a write. Reading back what was there before the write
      would report the write as having done nothing -- which is worse than any
      number of extra requests, and is the failure this guard exists for.
    */
    expect(useResource).toMatch(/nonce === 0 && cached/);
    const reload = useResource.slice(useResource.indexOf('const reload'));
    expect(reload).toContain('recent.delete(path)');
  });

  it('forgets a failure rather than serving it again', () => {
    expect(useResource).toMatch(/catch[\s\S]{0,200}recent\.delete\(path\)/);
  });

  it('is emptied when somebody signs out', () => {
    // It holds whatever the last person was looking at for a couple of
    // seconds, and signing out is exactly when that must not be handed on.
    expect(hooks).toContain('export function forgetFetchedResources');
    const session = readFileSync(resolve(root, 'apps/web/src/lib/session.tsx'), 'utf8');
    const signOut = session.slice(session.indexOf('const signOut'));
    expect(signOut.slice(0, 400)).toContain('forgetFetchedResources()');
  });

  it('still aborts a request whose caller has gone', () => {
    // Sharing an answer must not cost the abort: navigating away mid-request
    // should not go on to write state for a page nobody is on.
    expect(useResource).toContain('controller.current?.abort()');
    expect(useResource).toContain('return () => ac.abort()');
    expect(useResource).toMatch(/if \(ac\.signal\.aborted\) return;/);
  });
});
