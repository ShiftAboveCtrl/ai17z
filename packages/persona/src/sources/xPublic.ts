import { envBool } from '@xbam/shared';
import type { CorpusFetchOptions, PersonaSourceAdapter, RawCorpusItem, SourceAvailability } from './contract';

/**
 * Public X posts, read through the browser AI17Z already has.
 *
 * ## What this replaced, and why
 *
 * This adapter used to shell out to **twscrape**: a Python library the owner
 * had to `pip install`, put on PATH inside the worker, and seed with X accounts
 * of its own, held in its own credential database. Every one of those is a
 * thing a packaged installation does not have and cannot get -- there is no
 * Python in the worker image and never will be -- so `availability()` answered
 * "not installed" on every machine anybody actually ran, the sync stored
 * nothing, and the feature above it did nothing.
 *
 * The lesson was not that twscrape was the wrong library. It was that a brittle
 * scraper was wired directly into a product feature, so when it died the
 * feature died with it and there was nowhere else for it to go.
 *
 * Reading X now goes through the canonical X intelligence layer, which reads
 * inside the signed-in browser the owner already has -- no second login, no
 * cookie export, no account pool, no Python, and the same code on all five
 * packaged platforms.
 *
 * ## Why this file still exists at all
 *
 * The persona source registry answers two questions: what kinds of source are
 * there, and can this one be used right now. Those are still real questions and
 * the screens still ask them. What changed is the answer to the second: it is
 * no longer "is a Python package installed" but "is there a browser here" --
 * which is the honest requirement, and one the product can actually meet.
 *
 * Collection itself is not done here. An X source is read by the worker, which
 * is the process that owns browsers, and the corpus is handed to
 * `syncPersonaSource` already gathered -- the same route "Learn from this
 * account" takes, because they are the same operation and having two was the
 * bug.
 */

const KIND = 'x_public';

/**
 * Whether this worker can read X.
 *
 * Deliberately a browser question. `AI17Z_DISABLE_BROWSER` is the one switch
 * that turns browser work off -- a headless server sets it -- and an
 * installation with browsing off cannot read X, which is a true answer rather
 * than a missing-dependency one.
 */
export const xPublicSource: PersonaSourceAdapter = {
  kind: KIND,
  displayName: 'Public X posts',

  async availability(): Promise<SourceAvailability> {
    if (envBool('AI17Z_DISABLE_BROWSER', false)) {
      return {
        available: false,
        detail: 'Browser support is switched off on this machine, so X cannot be read.',
        requirement:
          'Reading X needs the AI17Z browser. On a desktop, start AI17Z normally; over ssh there is no graphical session and there never will be.',
      };
    }
    return {
      available: true,
      detail: "Read through AI17Z's own signed-in browser.",
      requirement: null,
    };
  },

  /**
   * Never called for this kind, and refusing loudly is the point.
   *
   * An X corpus is collected by the worker through the intelligence layer and
   * passed to the sync already gathered. If something ever calls this, the
   * routing has gone wrong somewhere upstream, and a clear error naming the
   * right path is worth far more than an empty array that looks like an account
   * with nothing to say.
   */
  async fetch(_options: CorpusFetchOptions): Promise<RawCorpusItem[]> {
    throw new Error(
      'An X persona corpus is collected by the worker through the browser, not fetched here. ' +
        'Request a sync on the source and the worker will read it.',
    );
  },
};
