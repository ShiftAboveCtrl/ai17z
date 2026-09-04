import { describe, expect, it } from 'vitest';

/**
 * "Signed in" is not enough to act on. Signed in *as whom* is.
 *
 * A health check that only proves a browser is open will happily report healthy
 * for an account whose stored handle is not the one the session belongs to --
 * and that account then searches for somebody else's mentions, never recognises
 * being addressed, and follows the wrong threads. Every poll succeeds. Every
 * poll finds nothing. Nothing anywhere says why.
 *
 * The comparison is pure, so it is tested here rather than behind a browser.
 */
function compare(live: string | null, stored: string | null) {
  const l = live?.replace(/^@+/, '').toLowerCase() ?? null;
  const s = stored?.replace(/^@+/, '').toLowerCase() ?? null;
  return { mismatched: Boolean(l && s && l !== s), adopt: Boolean(l && !s) };
}

describe('checking who a session is signed in as', () => {
  it('is content when the live handle matches the stored one', () => {
    expect(compare('someone', 'someone').mismatched).toBe(false);
  });

  it('ignores case and a leading at-sign, which are not differences', () => {
    expect(compare('@SomeOne', 'someone').mismatched).toBe(false);
  });

  it('catches a session belonging to a different account', () => {
    expect(compare('other_person', 'someone').mismatched).toBe(true);
  });

  it('adopts the live handle when the account never had one', () => {
    // A row created before anybody signed in. Adopting is right; refusing would
    // leave it permanently unusable for no reason.
    expect(compare('someone', null)).toEqual({ mismatched: false, adopt: true });
  });

  it('claims nothing when the handle could not be read', () => {
    // A page that did not render the account menu is not evidence of a
    // mismatch, and treating it as one would break a working account.
    expect(compare(null, 'someone')).toEqual({ mismatched: false, adopt: false });
  });
});
