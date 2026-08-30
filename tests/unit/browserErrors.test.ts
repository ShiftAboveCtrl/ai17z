import { describe, expect, it } from 'vitest';
import { describeBrowserError, explainBrowserError, tidyBrowserError } from '@xbam/browser';

/**
 * What a person sees when the browser fails.
 *
 * The account page was showing this, four times over, naming a port that had
 * not existed for hours:
 *
 *   Could not attach to the browser at http://127.0.0.1:10482:
 *   browserType.connectOverCDP: Timeout 20000ms exceeded. Call log:
 *   [2m - <ws preparing> retrieving websocket url from ...
 *
 * Errors here carry a class and a human sentence. This is the test that keeps
 * the second half of that true.
 */

const REAL_FAILURE =
  'Could not attach to the browser at http://127.0.0.1:10482: browserType.connectOverCDP: Timeout 20000ms exceeded.\n' +
  'Call log:\n\u001B[2m  - <ws preparing> retrieving websocket url from http://127.0.0.1:10482\u001B[22m\n' +
  '\u001B[2m  - <ws connecting> ws://127.0.0.1:10482/devtools/browser/5c47ee11\u001B[22m\n';

describe('the message that reached the account page', () => {
  it('says what happened and what to do, in sentences', () => {
    const { what, fix } = explainBrowserError(REAL_FAILURE);
    expect(what).toBe('The browser answered but would not accept a connection in time.');
    expect(fix).toContain('Stop the agent and start it again');
  });

  it('keeps no call log, no websocket URL, and no colour codes', () => {
    const shown = describeBrowserError(REAL_FAILURE);
    expect(shown).not.toContain('ws://');
    expect(shown).not.toContain('Call log');
    expect(shown).not.toContain('connectOverCDP');
    expect(shown).not.toContain('\u001B');
    expect(shown).not.toContain('[2m');
  });

  it('is short enough to read', () => {
    expect(describeBrowserError(REAL_FAILURE).length).toBeLessThan(220);
  });
});

describe('the failures that actually happen', () => {
  const cases: [string, string][] = [
    ['connect ECONNREFUSED 127.0.0.1:9222', 'Nothing was listening'],
    ['The browser did not open its debugging port within 30s (http://127.0.0.1:1234).', 'never opened its debugging port'],
    ['Browser automation is disabled (XBAM_BROWSER_ENABLED=0).', 'Nothing is running that can open a browser'],
    ['The X session is signed out. Reconnect the account.', 'signed out'],
    ['Could not open https://x.com/home: net::ERR_NAME_NOT_RESOLVED', 'would not load'],
    ['Another browser is already using the profile. ProcessSingleton failed.', 'already using this account profile'],
  ];

  for (const [raw, expected] of cases) {
    it(`explains "${raw.slice(0, 40)}…"`, () => {
      expect(describeBrowserError(raw)).toContain(expected);
    });
  }

  it('keeps an unfamiliar error rather than swallowing it', () => {
    const odd = 'Something nobody has a rule for yet.';
    expect(describeBrowserError(odd)).toContain('nobody has a rule for');
  });

  it('truncates a very long unfamiliar error instead of pasting it whole', () => {
    const shown = describeBrowserError('x'.repeat(600));
    expect(shown.length).toBeLessThan(220);
    expect(shown.endsWith('…')).toBe(true);
  });
});

describe('tidying', () => {
  it('drops everything from the call log onwards', () => {
    expect(tidyBrowserError(REAL_FAILURE)).toBe(
      'Could not attach to the browser at http://127.0.0.1:10482: browserType.connectOverCDP: Timeout 20000ms exceeded.',
    );
  });
});
