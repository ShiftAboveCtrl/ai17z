import { describe, expect, it } from 'vitest';
import { postedAtFromStatusId } from '@xbam/channels';

/**
 * A post's own id says when it was written, and that is not a guess.
 *
 * The monitors used to fall back from an unreadable timestamp straight to the
 * clock. `now` is not a way of saying "X did not tell us"; it is a specific
 * claim that the post was written at the moment AI17Z looked at it, and the
 * freshness gate is fed exactly this field.
 *
 * The three cases below with a known answer are real posts from a live
 * installation whose timestamps X *did* render, so the DOM value and the
 * arithmetic can be held against each other. They agree to the minute.
 */
describe('when a post was written, from its id', () => {
  it('agrees with what X rendered, on posts where X rendered it', () => {
    // id -> the `datetime` attribute X put on the same post.
    const known: [string, string][] = [
      ['2102232413539901802', '2026-09-22T03:03'],
      ['2102844317307973872', '2026-09-23T19:35'],
      ['2102775194255315129', '2026-09-23T15:00'],
    ];
    for (const [id, rendered] of known) {
      expect(postedAtFromStatusId(id)?.slice(0, 16), id).toBe(rendered);
    }
  });

  it('reads the six that were recorded as having arrived the moment they were seen', () => {
    /*
      Every one of these was stored with an occurred_at of 2026-09-23T22:33,
      the minute the installation came back from two days off, because the
      notifications surface rendered no `time` element for any of them.

      The true times are hours to days earlier, and the consequences ran both
      ways within that one minute: the 09-22T23:20 mention was answered in
      public as though it had just arrived.
    */
    const misdated: [string, string][] = [
      ['2102224072990138704', '2026-09-22T02:30'],
      ['2102225506376847614', '2026-09-22T02:36'],
      ['2102228845705527617', '2026-09-22T02:49'],
      ['2102538437152969003', '2026-09-22T23:20'],
      ['2102833882597117984', '2026-09-23T18:54'],
      ['2102838125735092243', '2026-09-23T19:10'],
    ];
    for (const [id, truth] of misdated) {
      expect(postedAtFromStatusId(id)?.slice(0, 16), id).toBe(truth);
    }
  });

  it('says nothing rather than something wrong', () => {
    // A wrong timestamp is the fault this exists to stop producing, so
    // anything that is not plainly a snowflake gets no answer at all.
    expect(postedAtFromStatusId(null)).toBeNull();
    expect(postedAtFromStatusId('')).toBeNull();
    expect(postedAtFromStatusId('not-a-number')).toBeNull();
    expect(postedAtFromStatusId('123')).toBeNull();
    // Below the first snowflake X ever issued: the arithmetic would produce a
    // date, and it would be meaningless.
    expect(postedAtFromStatusId('20000000000')).toBeNull();
    // An id far enough in the future to be an id from somewhere else.
    expect(postedAtFromStatusId('9999999999999999999')).toBeNull();
  });

  it('is what the freshness gate should have been reading', () => {
    /*
      The pair that proves the inversion. Both were seen in the same poll. One
      was answered and one was refused, and the wrong one was refused.
    */
    const answered = postedAtFromStatusId('2102538437152969003')!; // replied to
    const refused = postedAtFromStatusId('2102844317307973872')!; // dropped as stale
    expect(new Date(refused).getTime()).toBeGreaterThan(new Date(answered).getTime());
  });
});
