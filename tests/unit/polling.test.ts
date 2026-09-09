import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

const hooks = read('apps/web/src/lib/hooks.ts');

/**
 * A tab nobody is looking at should not be asking questions.
 *
 * Thirteen pollers run across the interface and six of them never stop --
 * agent status every five seconds, notifications, the pause switch, browser
 * tabs, health, the inbox. AI17Z is left open, so a window sitting behind an
 * editor all afternoon was asking a local API a few thousand times to render
 * pixels nobody could see, on the machine the agent is driving Chrome on.
 */
describe('polling while nobody is looking', () => {
  it('stops when the document is hidden', () => {
    expect(hooks).toContain("document.addEventListener('visibilitychange'");
    expect(hooks).toMatch(/visibilityState === 'hidden'/);
  });

  it('asks once on the way back rather than waiting out the interval', () => {
    /*
      The half that makes stopping safe. Without it this trades wasted requests
      for a screen that is stale for up to one interval after somebody returns
      -- twenty seconds on health, thirty on notifications -- which is the
      worse of the two.
    */
    const effect = hooks.slice(hooks.indexOf('export function usePolling'));
    const onVisible = effect.slice(effect.indexOf('const onVisibility'));
    expect(onVisible.indexOf('saved.current()')).toBeGreaterThan(-1);
    // And before restarting the interval, not after one more period of it.
    expect(onVisible.indexOf('saved.current()')).toBeLessThan(onVisible.indexOf('start();'));
  });

  it('removes its listener and its interval together', () => {
    // A poller that survives its component keeps a stale closure asking for an
    // agent nobody is looking at any more.
    const effect = hooks.slice(hooks.indexOf('export function usePolling'));
    expect(effect).toContain("document.removeEventListener('visibilitychange'");
    expect(effect).toMatch(/return \(\) => \{\s*stop\(\);/);
  });

  it('still does nothing at all when it is not active', () => {
    // The conditional pollers -- a job in flight, a character being built --
    // depend on this: they poll every two seconds and must stop dead when the
    // thing they are watching settles.
    const effect = hooks.slice(hooks.indexOf('export function usePolling'));
    expect(effect).toMatch(/if \(!active\) return;/);
  });
});
