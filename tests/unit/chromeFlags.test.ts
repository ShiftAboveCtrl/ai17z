import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SHARED_CHROME_ARGS } from '@xbam/browser';

const root = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

/**
 * Chrome is started from four places, and each had grown its own flag list.
 * A flag that stops the browser becoming unusable is worth nothing if three
 * launch paths carry it and the fourth does not, so this asserts they agree.
 */
describe('every way of starting Chrome passes the same flags', () => {
  it('carries the flags that stop the restore bubble', () => {
    // Both spellings: the bubble was renamed between Chrome versions and
    // neither name is documented as stable.
    expect(SHARED_CHROME_ARGS).toContain('--hide-crash-restore-bubble');
    expect(SHARED_CHROME_ARGS).toContain('--disable-session-crashed-bubble');
  });

  it('carries the flags that hold memory down', () => {
    expect(SHARED_CHROME_ARGS).toContain('--disable-renderer-backgrounding');
    expect(SHARED_CHROME_ARGS).toContain('--disable-backgrounding-occluded-windows');
  });

  it('is used by the managed launch, the persistent context and the preflight', () => {
    for (const file of ['packages/browser/src/chrome.ts', 'packages/browser/src/session.ts', 'packages/browser/src/preflight.ts']) {
      expect(read(file)).toContain('SHARED_CHROME_ARGS');
    }
  });

  it('the PowerShell launcher lists every one of them', () => {
    // It cannot import the constant, so the test is the thing keeping them in
    // step. A flag added above and forgotten here fails right here.
    const script = read('scripts/launch-chrome-cdp.ps1');
    for (const flag of SHARED_CHROME_ARGS) {
      expect(script, `${flag} missing from launch-chrome-cdp.ps1`).toContain(flag);
    }
  });
});
