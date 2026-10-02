import { createLogger, PipelineError } from '@xbam/shared';
import type { ChannelContext } from '../contract';
import { observeAuthPage } from './auth';
import { readAllArticles, type Seen } from './monitors';
import { goto, readText, settle, withSession, type Page } from './page';
import { SEL } from './selectors';

const log = createLogger('x-persona-corpus');

/**
 * Reading an account's own writing, to learn a voice from it.
 *
 * This exists because the feature that was supposed to do it could not. "Learn
 * from this account" was wired to **twscrape** -- a Python library the owner has
 * to `pip install`, put on PATH inside the worker, and seed with X accounts of
 * their own. A packaged AI17Z has no Python and never will, so `availability()`
 * answered "not available" on every installation, the sync stored nothing, and
 * the button did nothing anybody could see.
 *
 * AI17Z already has a signed-in real Chrome reading X all day for the reply
 * pipeline. That is what this uses: the same browser, the same session, the
 * same RESEARCH tab, the same selectors. No second browser, no second
 * credential, nothing installed.
 *
 * What it is not: **it does not evade anything.** It scrolls a public profile
 * the way a person does, it stops when it has enough, it stops when the page
 * stops producing anything new, and it stops on a clock whatever happens. A
 * sign-in prompt or a security challenge ends it and is reported as itself --
 * AI17Z never answers one of those, and a corpus collector is not the place to
 * start.
 */

/**
 * How much authored writing is worth having, and how little is worth using.
 *
 * `TARGET` is where collection stops being worth the scrolling: past roughly
 * this many posts the derived traits stop moving, and every further pass is a
 * request against a session that has to stay usable for the agent's actual
 * work. `MINIMUM` is the floor for saying anything at all about a voice -- below
 * it the sample is small enough that the persona is a guess, and the honest
 * thing is to say how small rather than to dress it up.
 *
 * Both are named because they are product decisions, not constants of nature,
 * and because the persona builder should be able to disagree with them in one
 * place rather than in five.
 */
export const PERSONA_TARGET_POSTS = 160;
export const PERSONA_MINIMUM_POSTS = 40;

/** Bounds. A profile timeline has no end, so something else has to end it. */
const MAX_SCROLL_PASSES = 60;
const SCROLL_PIXELS = 2_400;
const SETTLE_MS = 800;
const MAX_DURATION_MS = 180_000;
/**
 * Consecutive passes that produced nothing new before this gives up.
 *
 * One empty pass is ordinary: a virtualised list re-renders, and a slow network
 * means the next screenful has not arrived yet. Three in a row is the end of the
 * timeline, or a page that has stopped loading more, and either way scrolling
 * again will not help.
 */
const NO_PROGRESS_LIMIT = 3;

export type CorpusOutcome =
  | 'OK'
  | 'NOT_FOUND'
  | 'PROTECTED'
  | 'EMPTY'
  | 'SIGNED_OUT'
  | 'CHALLENGE'
  /** X did not show the timeline: an error screen, a page that never drew, or a different profile. */
  | 'UNAVAILABLE'
  | 'RATE_LIMITED';

export interface AuthoredPost {
  statusId: string;
  url: string;
  text: string;
  createdAt: string | null;
  /** What the writing is: a post of their own, a reply, or a quote with comment. */
  kind: 'post' | 'reply' | 'quote';
}

export interface PersonaCorpus {
  handle: string;
  outcome: CorpusOutcome;
  /** Said in words, because every one of these needs a different thing from a person. */
  detail: string;
  posts: AuthoredPost[];
  /** The public profile description, when X showed one. */
  bio: string | null;
  displayName: string | null;
  /** How far it got, for a progress line that is not invented. */
  scrollPasses: number;
  /** True when it stopped on a bound rather than because the timeline ended. */
  stoppedEarly: boolean;
}

/** X handles: letters, digits and underscore, at most fifteen. */
export function normaliseHandle(raw: string): string | null {
  const handle = raw.trim().replace(/^@+/, '').replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, '').split(/[/?#]/)[0] ?? '';
  return /^[A-Za-z0-9_]{1,15}$/.test(handle) ? handle : null;
}

/**
 * Which of these articles this account actually wrote.
 *
 * Split out and pure so fixtures can pin it, because it is where the judgement
 * is. Three things are being separated:
 *
 *   - **Other people's posts.** `/with_replies` renders the post being replied
 *     to as well as the reply, so roughly half of what is on the page belongs
 *     to somebody else. Their writing is not this account's voice.
 *   - **Reposts.** A repost carries the original author's handle, so the author
 *     filter removes it -- which is the correct answer: pressing repost is not
 *     writing. A quote *with* commentary is the account's own words and is
 *     kept, marked as a quote so the persona builder knows the text is a remark
 *     about something rather than a standalone thought.
 *   - **Empty text.** An image-only post says nothing about how somebody writes.
 *
 * Replies are kept deliberately and are the most valuable part: conversational
 * voice is what an agent spends most of its time producing, and a timeline of
 * announcements teaches none of it.
 */
export function authoredBy(handle: string, seen: Seen[]): AuthoredPost[] {
  const wanted = handle.toLowerCase();
  const byId = new Map<string, AuthoredPost>();

  for (const item of seen) {
    if (!item.statusId || !item.text?.trim()) continue;
    const author = (item.authorHandle ?? '').replace(/^@+/, '').toLowerCase();
    if (author !== wanted) continue;
    // Deduped on the status id rather than on the text: a person quoting
    // themselves twice wrote it twice, and X re-renders the same article on
    // every scroll pass.
    if (byId.has(item.statusId)) continue;

    byId.set(item.statusId, {
      statusId: item.statusId,
      url: item.url ?? `https://x.com/i/web/status/${item.statusId}`,
      text: item.text.trim(),
      createdAt: item.createdAt ?? null,
      kind: item.isReply ? 'reply' : item.isQuote ? 'quote' : 'post',
    });
  }

  return [...byId.values()];
}

/**
 * Which profile a page is, from its address.
 *
 * Read before anything is harvested, because a redirect to another account
 * draws a perfectly good timeline that belongs to somebody else. The author
 * filter would then quietly reduce it to nothing and the read would look like
 * an empty account. Reserved first segments are never a profile.
 */
export function profileOfUrl(url: string): string | null {
  try {
    const first = new URL(url).pathname.split('/').filter(Boolean)[0] ?? '';
    if (/^(i|home|explore|search|notifications|messages|settings|login|logout|account)$/i.test(first)) return null;
    return /^[A-Za-z0-9_]{1,15}$/.test(first) ? first : null;
  } catch {
    return null;
  }
}

/**
 * What a timeline area says when it has nothing in it, in X's own words.
 *
 * Three different things look identical as "zero articles": an account that
 * has genuinely never posted, which X says in so many words; X's error screen,
 * which says to try reloading; and a page that simply never drew. Only the
 * first is an empty account. The others are a read that failed, and a persona
 * built from one is a persona built from nothing.
 */
export function readTimelineState(text: string): 'ERROR' | 'RATE_LIMITED' | 'EMPTY_STATE' | null {
  if (/rate limit exceeded|you are being rate limited|too many requests/i.test(text)) return 'RATE_LIMITED';
  if (/something went wrong\.?\s*try reloading|something went wrong, but don.t fret/i.test(text)) return 'ERROR';
  if (/hasn.t posted|hasn.t replied|when they (?:do|post)[^.]{0,40}will show up here/i.test(text)) return 'EMPTY_STATE';
  return null;
}

/** What X put on the page instead of a timeline, in the words it used. */
function readProfileState(text: string): { outcome: CorpusOutcome; detail: string } | null {
  if (/This account doesn.t exist|user has been suspended|Account suspended/i.test(text)) {
    return { outcome: 'NOT_FOUND', detail: 'X says that account does not exist or has been suspended.' };
  }
  if (/These posts are protected|This account.s posts are protected|protected their posts/i.test(text)) {
    return {
      outcome: 'PROTECTED',
      detail: 'That account is protected, so its posts are not public and AI17Z cannot read them.',
    };
  }
  return null;
}

/**
 * Collect what an account has written, bounded every way that matters.
 *
 * Stops at the first of: enough posts, the timeline running out, three passes
 * with nothing new, the scroll limit, or the clock. It never decides it is done
 * because a single read came back empty -- that is what a slow screenful looks
 * like.
 */
export async function collectPersonaCorpus(
  ctx: ChannelContext,
  request: { handle: string; target?: number; onProgress?: (collected: number, passes: number) => void },
): Promise<PersonaCorpus> {
  const handle = normaliseHandle(request.handle);
  if (!handle) {
    throw PipelineError.permanent('bad_handle', `"${request.handle}" is not an X handle.`);
  }
  const target = Math.min(Math.max(request.target ?? PERSONA_TARGET_POSTS, 1), 1_000);
  const startedAt = Date.now();

  return withSession(ctx, 'RESEARCH', async (session) => {
    const page = session.page;
    // `with_replies` rather than the bare profile: replies are the richest part
    // of a voice and the bare profile hides them entirely.
    await goto(page, `https://x.com/${handle}/with_replies`);
    await settle();

    // Signed out or challenged is not an empty account, and answering either is
    // something only a person does.
    const auth = await observeAuthPage(page).catch(() => null);
    if (auth?.state === 'CHALLENGE') {
      return empty(handle, 'CHALLENGE', `X is asking for something only you can answer: ${auth.detail}`);
    }
    if (auth?.state === 'AWAITING_LOGIN') {
      return empty(
        handle,
        'SIGNED_OUT',
        'X wants you to sign in to the AI17Z browser profile before it will show this timeline.',
      );
    }

    // The page has to be the profile that was asked for, before anything on it
    // is read. A rename or a redirect lands somewhere else without an error.
    const landed = profileOfUrl(page.url());
    if (!landed || landed.toLowerCase() !== handle.toLowerCase()) {
      return empty(handle, 'UNAVAILABLE', `X showed ${landed ? `@${landed}` : 'a different page'} instead of @${handle}'s timeline, so nothing was read from it.`);
    }

    let pageText = await readText(page).catch(() => '');
    const refused = readProfileState(pageText);
    if (refused) return empty(handle, refused.outcome, refused.detail);

    // X's error screen is usually momentary. One reload, and no more: a page
    // that shows it twice is not going to be talked out of it by a third.
    if (readTimelineState(pageText) === 'ERROR') {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => undefined);
      await settle(1_500, 2_500);
      pageText = await readText(page).catch(() => '');
    }
    const state = readTimelineState(pageText);
    if (state === 'RATE_LIMITED') return empty(handle, 'RATE_LIMITED', 'X asked for fewer requests, so the timeline was not read.');
    if (state === 'ERROR') return empty(handle, 'UNAVAILABLE', `X showed its error screen on @${handle}'s timeline twice, so it was not read.`);

    const profile = await readProfileCard(page, handle);

    let accumulated: Seen[] = [];
    let posts: AuthoredPost[] = [];
    let quiet = 0;
    let passes = 0;

    for (; passes < MAX_SCROLL_PASSES; passes += 1) {
      // Accumulated, never replaced. The timeline is virtualised: articles
      // scrolled past are removed from the DOM, so each read is a window rather
      // than the whole list. Reading only the current window is what caps a
      // collector at one screenful however far it scrolls -- `readTimeline`
      // does exactly that, which is fine for fifteen posts and useless here.
      accumulated = [...accumulated, ...(await readAllArticles(page, 120))];
      const before = posts.length;
      posts = authoredBy(handle, accumulated);
      request.onProgress?.(posts.length, passes + 1);

      if (posts.length >= target) break;
      quiet = posts.length > before ? 0 : quiet + 1;
      if (quiet >= NO_PROGRESS_LIMIT) break;
      if (Date.now() - startedAt > MAX_DURATION_MS) break;

      await page.mouse.wheel(0, SCROLL_PIXELS).catch(() => undefined);
      await page.waitForTimeout(SETTLE_MS);
    }

    const stoppedEarly = posts.length >= target || passes >= MAX_SCROLL_PASSES || Date.now() - startedAt > MAX_DURATION_MS;

    if (posts.length === 0) {
      // Nothing authored, on a page that was not obviously refused. An account
      // that has genuinely never posted and one whose timeline would not load
      // are different, and the article count is what tells them apart.
      const anyArticle = accumulated.length > 0;
      const finalState = anyArticle ? null : readTimelineState(await readText(page).catch(() => ''));
      // Only X saying the account has not posted is an empty account. Nothing
      // drawn at all is a timeline that did not load, and is reported as one.
      const [outcome, detail]: [CorpusOutcome, string] = anyArticle
        ? ['EMPTY', `X showed @${handle}'s timeline but none of it was written by them.`]
        : finalState === 'EMPTY_STATE'
          ? ['EMPTY', `@${handle} has not posted anything public.`]
          : finalState === 'RATE_LIMITED'
            ? ['RATE_LIMITED', 'X asked for fewer requests, so the timeline was not read.']
            : ['UNAVAILABLE', `X did not draw @${handle}'s timeline, so nothing could be read from it.`];
      return {
        ...empty(handle, outcome, detail),
        ...profile,
        scrollPasses: passes,
      };
    }

    log.info('collected a persona corpus', { handle, posts: posts.length, passes, stoppedEarly });
    return {
      handle,
      outcome: 'OK',
      detail:
        posts.length >= PERSONA_MINIMUM_POSTS
          ? `Read ${posts.length} posts by @${handle}.`
          : `Only ${posts.length} posts by @${handle} could be read, which is a small sample.`,
      posts: posts.slice(0, target),
      ...profile,
      scrollPasses: passes,
      stoppedEarly,
    };
  });
}

function empty(handle: string, outcome: CorpusOutcome, detail: string): PersonaCorpus {
  return { handle, outcome, detail, posts: [], bio: null, displayName: null, scrollPasses: 0, stoppedEarly: false };
}

/**
 * The name and description on the profile, which are part of a persona.
 *
 * Read from the header rather than guessed, and null when X did not show it --
 * an invented bio is exactly the kind of unsupported fact the persona rules
 * forbid.
 */
async function readProfileCard(page: Page, handle: string): Promise<{ bio: string | null; displayName: string | null }> {
  const bio = await page
    .locator(SEL.userDescription)
    .first()
    .innerText({ timeout: 2_000 })
    .catch(() => '');
  const name = await page
    .locator(SEL.userName)
    .first()
    .innerText({ timeout: 2_000 })
    .catch(() => '');
  const displayName = name.split('\n')[0]?.trim() ?? '';
  return {
    bio: bio.trim() ? bio.trim().replace(/\s+/g, ' ') : null,
    displayName: displayName && displayName !== `@${handle}` ? displayName : null,
  };
}
