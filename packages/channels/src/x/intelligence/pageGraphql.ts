import { createLogger } from '@xbam/shared';
import type { ChannelContext } from '../../contract';
import { goto, settle, withSession, type Page } from '../page';
import {
  DEFAULT_BUDGET,
  X_CAPABILITIES,
  emptyResult,
  provenanceFor,
  type XBackendReadiness,
  type XId,
  type XIntelligenceBackend,
  type XPostRecord,
  type XPostsRequest,
  type XReadContext,
  type XReadOutcome,
  type XReadResult,
  type XUser,
} from './contract';

const log = createLogger('x-graphql');

/**
 * Reading X's own JSON, from inside the browser that is already signed in.
 *
 * ## The idea, and why it is the right one here
 *
 * X's web app does not render posts from HTML the server sent; it fetches JSON
 * from its own GraphQL endpoints and draws the page from that. Scraping the
 * drawn page is therefore reading a rendering of an answer that was already
 * structured -- which is why DOM collection gives approximate counts, loses
 * ids, and breaks whenever a class name moves.
 *
 * This asks for the JSON instead. The fetch happens **inside the page**, in
 * `page.evaluate`, so it goes out as the signed-in session's own request with
 * the session's own credentials, exactly as scrolling the timeline does.
 *
 * ## What that buys, specifically
 *
 *   - **No second authentication.** Nobody exports an `auth_token`, pastes a
 *     `ct0`, keeps a second X login, or seeds an account database. The session
 *     is the one the owner signed in to themselves, once, in the window AI17Z
 *     opened.
 *   - **No credential ever reaches this process.** The cookies stay in the
 *     browser. Node never sees them, so they cannot reach a log, a trace, a
 *     model, or a crash report. The only thing that crosses back is the answer.
 *   - **No new dependency, on any platform.** It is the browser AI17Z already
 *     ships and already drives. Nothing to `pip install`, nothing to put on
 *     PATH, nothing that works in a checkout and not in a package -- which is
 *     the exact failure that killed the last one.
 *   - **Immutable ids, real counts, conversation ids.** All present in the
 *     JSON and none reliably recoverable from the DOM.
 *
 * ## Query ids move, so they are discovered
 *
 * Each GraphQL operation is addressed by an id that changes when X ships. A
 * hard-coded list dies silently: the endpoint 404s and the feature looks empty
 * rather than broken. So the ids are read out of X's own loaded bundles, which
 * is where the app itself gets them, cached for the session, and a miss falls
 * back to the DOM backend rather than to nothing.
 *
 * ## What this does not do
 *
 * It does not solve a CAPTCHA, answer a challenge, spoof a fingerprint, rotate
 * an account or a proxy, or retry past a rate limit. Those are the things that
 * turn reading into abuse, and every one of them is refused elsewhere in this
 * codebase for the same reason. A challenge here ends the read and says so.
 */

/** Operations this backend knows how to ask for, by X's own operation names. */
const OPERATIONS = {
  userByScreenName: 'UserByScreenName',
  userTweets: 'UserTweets',
  userTweetsAndReplies: 'UserTweetsAndReplies',
  searchTimeline: 'SearchTimeline',
  /**
   * One post and the conversation around it.
   *
   * The same query X's own status page makes, which is why the reply chain
   * comes back already resolved rather than needing to be walked.
   */
  tweetDetail: 'TweetDetail',
} as const;

/**
 * Where the ids are found, cached for as long as the page stays on this build.
 *
 * Per page rather than global: two tabs can be on different X builds for a few
 * minutes after a deploy, and an id from one is a 404 on the other.
 */
const idCache = new WeakMap<object, Map<string, string>>();

/** When a missing search operation was last reported, so the log is a signal and not a flood. */
let lastProbeLoggedAt = 0;

/** The public code around each matched id, per page, for the failure log below. */
const nearCache = new WeakMap<object, Map<string, string>>();

/**
 * Until when the structured search is not worth asking.
 *
 * X answers it with an empty 404 unless the request carries a signature only
 * its own app produces. Asking anyway spends a request on every search to be
 * told the same thing, so after that refusal the search is left to the
 * rendered page, which reads the app's own results, for half an hour.
 */
let searchRefusedUntil = 0;

/** When each operation's refusal was last reported. */
const refusalLoggedAt = new Map<string, number>();

/**
 * Says why a structured read was refused, at most every ten minutes per
 * operation.
 *
 * Every refusal used to become "schema changed" and a quiet fall back to the
 * rendered page, which carries no counts, so a live installation lost the
 * audience of every author it found and nothing said why. The status, the
 * operation, the id that was used and the public code it was found in are
 * enough to tell a moved id from a moved endpoint from a refused feature set.
 * Nothing here is a credential: the bearer and cookie never leave the page.
 */
function reportRefusal(page: Page, operation: string, queryId: string, status: number, error: string | null): void {
  const last = refusalLoggedAt.get(operation) ?? 0;
  if (Date.now() - last < 10 * 60_000) return;
  refusalLoggedAt.set(operation, Date.now());
  log.warn('X refused a structured read', {
    operation,
    status,
    queryId,
    error: error?.slice(0, 200) ?? null,
    matchedIn: nearCache.get(page as unknown as object)?.get(operation)?.slice(0, 320) ?? null,
  });
}

/**
 * Pull operation ids out of the scripts X has already loaded.
 *
 * The bundles carry `{queryId:"...",operationName:"UserTweets",...}` because
 * the app needs the same mapping this does. Read in one page evaluation, and
 * deliberately tolerant: an operation that cannot be found is reported missing
 * so the layer above can use a different backend, rather than guessed at.
 */
/**
 * The in-page half of discovery, as source rather than as a closure.
 *
 * **This must not be a TypeScript arrow function handed to `page.evaluate`, and
 * that is not a style choice.** The worker runs under `tsx`, whose esbuild
 * transform rewrites named inner functions to `__name(fn, "fn")` to preserve
 * `Function.prototype.name`. Playwright serialises the *compiled* function into
 * the page, where `__name` does not exist, and the evaluation dies with
 * `ReferenceError: __name is not defined` before it reads a single script.
 *
 * The failure was invisible for a reason worth recording: the call site caught
 * everything and returned an empty map, which reads exactly like "X did not
 * expose its operations". So the backend reported DEGRADED, every read in AI17Z
 * fell through to the rendered page, and the layer's own honesty machinery
 * dutifully wrote `x-graphql could not answer` on every answer it produced.
 * Nothing was broken except that the better half of the layer had never once
 * run outside a unit test.
 *
 * Found by asking a live signed-in browser what it could actually see. A string
 * is immune: it is sent verbatim, so what runs in the page is what is written
 * here.
 */
export const DISCOVERY_SOURCE = `(async () => {
  const wanted = ['UserByScreenName', 'UserTweets', 'UserTweetsAndReplies', 'SearchTimeline', 'TweetDetail'];
  const ids = {};

  // Every text worth looking at, cheapest first: what is already in the
  // document, then the bundles it loaded. Collected rather than scanned as we
  // go, so there is no inner function for a transform to rename.
  const texts = [];
  const inline = document.querySelectorAll('script');
  for (let i = 0; i < inline.length; i += 1) {
    const body = inline[i].textContent;
    if (body) texts.push(body);
  }

  // Every script the page has, however it arrived. X used to ship one main
  // bundle under responsive-web; it now ships hundreds of hashed modules under
  // x-web, most of them preloaded or fetched lazily, and a list built from
  // script tags alone sees three files and none of the ones that matter.
  const found = {};
  const urls = [];
  const consider = [];
  const tags = document.querySelectorAll('script[src]');
  for (let i = 0; i < tags.length; i += 1) consider.push(tags[i].src);
  const preloads = document.querySelectorAll('link[rel=modulepreload], link[rel=preload][as=script]');
  for (let i = 0; i < preloads.length; i += 1) consider.push(preloads[i].href);
  const loaded = (performance && performance.getEntriesByType) ? performance.getEntriesByType('resource') : [];
  for (let i = 0; i < loaded.length; i += 1) consider.push(loaded[i].name);
  for (let i = 0; i < consider.length; i += 1) {
    const src = consider[i];
    if (!src || found[src]) continue;
    if (src.indexOf('twimg.com') < 0) continue;
    if (src.slice(-3) !== '.js' && src.indexOf('.js?') < 0) continue;
    found[src] = true;
    const file = src.slice(src.lastIndexOf('/') + 1).toLowerCase();
    // Most likely first: the modules that talk to the API. A cap scans the
    // likeliest files rather than whichever happened to load first.
    const likely = ['api', 'graphql', 'gql', 'search', 'timeline', 'tweet', 'user', 'main', 'query'];
    let rank = 9;
    for (let r = 0; r < likely.length; r += 1) { if (file.indexOf(likely[r]) >= 0) { rank = r; break; } }
    urls.push({ src: src, rank: rank });
  }
  urls.sort((a, b) => a.rank - b.rank);

  let scanned = 0;
  // The first round reads only what is already on the page; each later round
  // fetches eight more modules. At least one round always runs.
  for (let start = 0; start === 0 || (start < urls.length + 8 && start < 168); start += 8) {
    let done = true;
    for (let w = 0; w < wanted.length; w += 1) { if (!ids[wanted[w]]) { done = false; break; } }
    if (done) break;
    const batch = start === 0 ? [] : urls.slice(start - 8, start);
    const bodies = await Promise.all(batch.map((entry) =>
      fetch(entry.src, { credentials: 'omit' }).then((r) => (r.ok ? r.text() : '')).catch(() => '')));
    for (let b = 0; b < bodies.length; b += 1) { if (bodies[b]) { texts.push(bodies[b]); scanned += 1; } }

    for (let t = 0; t < texts.length; t += 1) {
      for (let w = 0; w < wanted.length; w += 1) {
        const name = wanted[w];
        if (ids[name]) continue;
        const text = texts[t];
        if (text.indexOf(name) < 0) continue;
        // The id and the name appear in either order, with or without quoted
        // keys, and as queryId or as a plain id in newer builds. Each shape is
        // tried rather than assuming one. No backslash anywhere: this is a
        // string sent verbatim into the page, and an escape that is lost on
        // the way is a pattern that silently matches nothing.
        const idPart = '"?(?:queryId|id)"?:"([a-zA-Z0-9_-]{16,})"';
        const namePart = '"?(?:operationName|name)"?:"' + name + '"';
        // One object first. X declares each operation as its own object, one
        // after another, so a pattern allowed to cross a closing brace takes
        // the previous operation's id: measured, search was sent as
        // RemoveFollower's id and refused with a 404. Only when no single
        // object holds both is a nested shape tried, and even then the match
        // may not run into the next declaration.
        const strictForward = new RegExp(idPart + '[^}]{0,240}?' + namePart).exec(text);
        const strictBackward = new RegExp(namePart + '[^}]{0,240}?' + idPart).exec(text);
        let id = (strictForward && strictForward[1]) || (strictBackward && strictBackward[1]);
        if (!id) {
          const nested = new RegExp(idPart + '[^;]{0,240}?' + namePart).exec(text);
          if (nested && nested[0].indexOf('exports') < 0 && nested[0].slice(1).indexOf('queryId') < 0) id = nested[1];
        }
        if (!id) continue;
        // Each operation declares the feature switches X sends with it. Sending
        // a different set is refused, with an empty-bodied 404 rather than
        // anything that says so, which is why these are read rather than
        // guessed. Found by hand rather than by regular expression on purpose.
        const switches = [];
        const opAt = text.indexOf('"' + name + '"');
        if (opAt >= 0) {
          const listAt = text.indexOf('featureSwitches', opAt);
          if (listAt >= 0 && listAt - opAt < 400) {
            const from = text.indexOf('[', listAt) + 1;
            const to = text.indexOf(']', from);
            if (from > 0 && to > from) {
              const parts = text.slice(from, to).split(',');
              for (let p = 0; p < parts.length; p += 1) {
                const cleaned = parts[p].split('"').join('').trim();
                if (cleaned) switches.push(cleaned);
              }
            }
          }
        }
        ids[name] = id;
        ids['features:' + name] = switches.join(',');
        const idAt = text.indexOf(id);
        ids['__near:' + name] = text.slice(Math.max(0, idAt - 120), idAt + 200);
      }
    }
  }

  // What the code around a missing operation looks like, so the next change
  // to X's bundles is diagnosed from a log line rather than from a guess.
  // Public application code only, a couple of hundred characters of it.
  const probe = {};
  for (let w = 0; w < wanted.length; w += 1) {
    const name = wanted[w];
    if (ids[name]) continue;
    for (let t = 0; t < texts.length; t += 1) {
      const at = texts[t].indexOf('"' + name + '"');
      if (at >= 0) { probe[name] = texts[t].slice(Math.max(0, at - 160), at + 160); break; }
    }
  }
  ids['__scanned'] = String(scanned) + ' of ' + String(urls.length);
  ids['__probe'] = JSON.stringify(probe);
  return ids;
})()`;

/**
 * Pull operation ids out of the scripts X has already loaded.
 *
 * The bundles carry `{queryId:"...",operationName:"UserTweets",...}` because
 * the app needs the same mapping this does. Read in one page evaluation, and
 * deliberately tolerant: an operation that cannot be found is reported missing
 * so the layer above can use a different backend, rather than guessed at.
 */
async function discoverOperationIds(page: Page): Promise<Map<string, string>> {
  const cached = idCache.get(page as unknown as object);
  if (cached && cached.size > 0) return cached;

  let found: Record<string, string> = {};
  try {
    found = (await page.evaluate(DISCOVERY_SOURCE)) as Record<string, string>;
  } catch (error) {
    /*
      Said out loud, because the silent version of this cost the product its
      primary X reader for as long as it existed.

      A bare catch here turns "the evaluation crashed" into "X exposed
      nothing", and those want completely different things done about them.
      The layer still degrades to the rendered page either way -- that part was
      always right -- but somebody reading a log now finds out which happened.
    */
    log.warn('could not read X operation ids from the page', { message: (error as Error).message });
    found = {};
  }

  const probe = found.__probe;
  const scanned = found.__scanned;
  const near = new Map(
    Object.entries(found)
      .filter(([key]) => key.startsWith('__near:'))
      .map(([key, value]) => [key.slice('__near:'.length), value]),
  );
  nearCache.set(page as unknown as object, near);
  const map = new Map(Object.entries(found).filter(([key]) => !key.startsWith('__')));
  if (map.size > 0) idCache.set(page as unknown as object, map);
  log.debug('discovered X operation ids', { found: [...map.keys()], scanned });

  /*
    Said out loud when search cannot be found, at most every ten minutes.

    X moved its web app from one bundle to hundreds of hashed modules, and this
    reader went on finding nothing, reporting "schema changed" and falling back
    to the rendered page, which carries no counts. Every search on a live
    installation lost the author's audience that way, silently. The probe is a
    few hundred characters of X's public application code around the name, so
    the next change is read off a log line instead of guessed at.
  */
  if (!map.has('SearchTimeline') && Date.now() - lastProbeLoggedAt > 10 * 60_000) {
    lastProbeLoggedAt = Date.now();
    log.warn('X search operation not found in the page', { scanned, probe: probe?.slice(0, 1_500) ?? null });
  }
  return map;
}

interface GraphqlAnswer {
  ok: boolean;
  status: number;
  /** X's own error text, when it gave one. Never a credential. */
  error: string | null;
  json: unknown;
}

/**
 * Run one GraphQL read as the page.
 *
 * The bearer and the CSRF header are the page's own, read in the page and used
 * in the page. **Neither is returned**: this function hands back the answer and
 * nothing else, so there is no path by which a credential reaches this process.
 */
/**
 * The feature switches one operation actually asks for.
 *
 * X registers each operation with its own `featureSwitches` list and sends
 * exactly those. Sending a different set is refused -- and refused with an
 * empty-bodied 404 rather than with anything that says what was wrong, which is
 * how `SearchTimeline` and `UserTweetsAndReplies` looked like missing accounts
 * while `UserTweets` worked from the same code.
 *
 * So the declared list wins where discovery could read one. The hand-written
 * `FEATURES` map stays as the floor: it is what an operation gets when its
 * metadata could not be parsed, and it is what kept the working operations
 * working for as long as it did.
 */
function featuresFor(ids: Map<string, string>, operation: string): Record<string, boolean> {
  const declared = ids.get(`features:${operation}`);
  if (!declared) return FEATURES;
  const named = declared.split(',').filter(Boolean);
  if (named.length === 0) return FEATURES;
  const features: Record<string, boolean> = {};
  for (const name of named) features[name] = true;
  return features;
}

async function askGraphql(
  page: Page,
  queryId: string,
  operation: string,
  variables: Record<string, unknown>,
  features: Record<string, boolean>,
): Promise<GraphqlAnswer> {
  return page.evaluate(
    async ({ queryId, operation, variables, features }) => {
      const url =
        `https://x.com/i/api/graphql/${queryId}/${operation}` +
        `?variables=${encodeURIComponent(JSON.stringify(variables))}` +
        `&features=${encodeURIComponent(JSON.stringify(features))}`;

      // The app's own public bearer, as shipped in its bundle. Read here and
      // used here; it does not leave the page.
      const bearer =
        'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
      const csrf = (document.cookie.match(/(?:^|;\s*)ct0=([^;]+)/) ?? [])[1] ?? '';

      try {
        const response = await fetch(url, {
          method: 'GET',
          credentials: 'include',
          headers: {
            authorization: bearer,
            'x-csrf-token': csrf,
            'x-twitter-active-user': 'yes',
            'x-twitter-auth-type': 'OAuth2Session',
            'content-type': 'application/json',
          },
        });
        const text = await response.text();
        let json: unknown = null;
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
        const errors = (json as { errors?: { message?: string }[] } | null)?.errors;
        return {
          ok: response.ok && !errors?.length,
          status: response.status,
          error: errors?.[0]?.message ?? (response.ok ? null : text.slice(0, 200)),
          json,
        };
      } catch (error) {
        return { ok: false, status: 0, error: String((error as Error).message ?? error).slice(0, 200), json: null };
      }
    },
    { queryId, operation, variables, features },
  );
}

/** The feature flags X's own requests carry. Wrong ones are refused outright. */
const FEATURES: Record<string, boolean> = {
  creator_subscriptions_tweet_preview_api_enabled: true,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  articles_preview_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  creator_subscriptions_quote_tweet_preview_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  rweb_video_timestamps_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  responsive_web_enhance_cards_enabled: false,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled: true,
  hidden_profile_likes_enabled: true,
  hidden_profile_subscriptions_enabled: true,
  subscriptions_verification_info_is_identity_verified_enabled: true,
  subscriptions_verification_info_verified_since_enabled: true,
  highlights_tweets_tab_ui_enabled: true,
  responsive_web_twitter_article_notes_tab_enabled: true,
  subscriptions_feature_can_gift_premium: true,
  profile_label_improvements_pcf_label_in_post_enabled: true,
  rweb_tipjar_consumption_enabled: true,
};

/** What X's error text means for us, in the vocabulary the contract uses. */
function outcomeFromError(status: number, error: string | null) {
  return classifyDetailed(status, error);
}

export function classifyDetailed(status: number, error: string | null) {
  const text = (error ?? '').toLowerCase();
  if (status === 429 || text.includes('rate limit')) {
    return { outcome: 'RATE_LIMITED' as const, detail: 'X asked AI17Z to slow down. It stopped rather than pushing.' };
  }
  if (status === 401 || status === 403 || text.includes('not authorized') || text.includes('could not authenticate')) {
    return {
      outcome: 'NEEDS_SIGN_IN' as const,
      detail: 'X wants you to sign in again in the AI17Z browser window.',
    };
  }
  /*
    An empty-bodied 404 is not X saying the account is missing.

    When X means that it says so, in a JSON error somebody can read. A 404 with
    nothing in it means the operation is not addressable the way it was asked
    for -- a query id that has moved, an operation this build no longer serves,
    a shape that changed. Those are the same thing as a changed schema, and they
    want the same response: try the other reader.

    The distinction is load-bearing because `NOT_FOUND` is in `STOP_ASKING`.
    Reading an empty 404 as a missing account stops the fallback dead, so a
    single retired operation would take a working feature down with it rather
    than degrading to the rendered page. Live X returns exactly this for two
    operations today, which is how it was found.
  */
  if (status === 404 && text.trim() === '') {
    return {
      outcome: 'SCHEMA_CHANGED' as const,
      detail: 'X did not serve that read the way this build asks for it.',
    };
  }
  if (status === 404 || text.includes('user not found') || text.includes('does not exist')) {
    return { outcome: 'NOT_FOUND' as const, detail: 'X says there is no such account.' };
  }
  if (text.includes('protected') || text.includes('not authorized to view')) {
    return { outcome: 'PROTECTED' as const, detail: 'That account is protected, so its posts are not public.' };
  }
  return {
    outcome: 'SCHEMA_CHANGED' as const,
    detail: `X answered in a shape this reader did not understand${error ? `: ${error.slice(0, 120)}` : ''}.`,
  };
}

/** Walk a GraphQL answer for the entries a timeline is made of. */
const MAX_PAYLOAD_DEPTH = 24;

/**
 * Whether a post is by the account whose timeline was asked for.
 *
 * A replies timeline also carries the posts being replied to, and a quote
 * carries the post it quotes, each by somebody else. Those are context, never
 * this account's writing, and a persona learned from them would speak in
 * other people's words. The numeric id decides when both sides have one; the
 * handle only when one side does not.
 */
export function isByRequestedUser(post: { authorId: string | null; authorHandle: string | null }, request: { userId?: string | null; handle: string }): boolean {
  if (post.authorId && request.userId) return post.authorId === request.userId;
  return (post.authorHandle ?? '').replace(/^@+/, '').toLowerCase() === request.handle.replace(/^@+/, '').toLowerCase();
}

function timelineEntries(json: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const seen = new Set<unknown>();
  const walk = (node: unknown, depth: number) => {
    // Deep enough for a conversation module. A replies timeline puts a reply
    // and the post it answers in a module, where the tweet sits at depth 15 or
    // 16; a walk that stopped at 14 dropped every one of them without a word,
    // which reads as an account that replies less than it does.
    if (!node || typeof node !== 'object' || depth > MAX_PAYLOAD_DEPTH || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    const record = node as Record<string, unknown>;
    if (typeof record.entryId === 'string' || record.__typename === 'Tweet' || record.__typename === 'TweetWithVisibilityResults') {
      out.push(record);
    }
    for (const value of Object.values(record)) walk(value, depth + 1);
  };
  walk(json, 0);
  return out;
}

/** Find the tweet objects inside whatever wrappers X used this week. */
export function tweetsFrom(json: unknown): Record<string, unknown>[] {
  const tweets: Record<string, unknown>[] = [];
  const ids = new Set<string>();
  for (const entry of timelineEntries(json)) {
    const candidates = [entry, (entry as { tweet?: unknown }).tweet, (entry as { tweet_results?: { result?: unknown } }).tweet_results?.result];
    for (const candidate of candidates) {
      const tweet = unwrapTweet(candidate);
      const id = tweet?.rest_id;
      if (tweet && typeof id === 'string' && !ids.has(id)) {
        ids.add(id);
        tweets.push(tweet);
      }
    }
  }
  return tweets;
}

function unwrapTweet(node: unknown): Record<string, unknown> | null {
  if (!node || typeof node !== 'object') return null;
  const record = node as Record<string, unknown>;
  if (record.__typename === 'TweetWithVisibilityResults' && record.tweet) return unwrapTweet(record.tweet);
  if (typeof record.rest_id === 'string' && record.legacy) return record;
  return null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * A boolean X actually stated, or nothing.
 *
 * Deliberately not `Boolean(value)`. A key X did not send would become `false`,
 * and `false` here means "they do not follow you" -- a measured fact the bridge
 * score treats differently from an unknown one. Absence has to survive.
 */
function bool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/**
 * Where X currently keeps the viewer's relationship with somebody.
 *
 * It moved off `legacy` into its own object at some point and both shapes are
 * still seen in the wild depending on which fields the query asked for. Read
 * defensively rather than pinned to this week's arrangement -- the cost of
 * being wrong is a permanently absent signal that looks exactly like an account
 * nobody follows.
 */
function perspectives(result: Record<string, unknown>): Record<string, unknown> {
  const direct = result.relationship_perspectives;
  if (direct && typeof direct === 'object') return direct as Record<string, unknown>;
  const legacy = (result.legacy ?? {}) as Record<string, unknown>;
  const nested = legacy.relationship_perspectives;
  return nested && typeof nested === 'object' ? (nested as Record<string, unknown>) : {};
}

/** X's JSON for one user, as the contract's shape. */
export function toUser(result: Record<string, unknown>, backend: string): XUser | null {
  const restId = result.rest_id;
  const legacy = (result.legacy ?? {}) as Record<string, unknown>;
  const core = (result.core ?? {}) as Record<string, unknown>;
  const handle = (core.screen_name ?? legacy.screen_name) as string | undefined;
  if (typeof restId !== 'string' || !handle) return null;

  const urls = ((legacy.entities as Record<string, unknown> | undefined)?.url as Record<string, unknown> | undefined)
    ?.urls as { expanded_url?: string }[] | undefined;

  return {
    userId: restId,
    handle,
    displayName: ((core.name ?? legacy.name) as string | undefined) ?? null,
    bio: (legacy.description as string | undefined) ?? null,
    avatarUrl: (legacy.profile_image_url_https as string | undefined)?.replace('_normal', '_400x400') ?? null,
    bannerUrl: (legacy.profile_banner_url as string | undefined) ?? null,
    location: ((legacy.location as string | undefined) || null) ?? null,
    website: urls?.[0]?.expanded_url ?? null,
    followers: followerCountOf(result),
    following: followingCountOf(result),
    posts: num(legacy.statuses_count),
    createdAt: (legacy.created_at as string | undefined) ?? null,
    verified: typeof legacy.verified === 'boolean' ? legacy.verified : (result.is_blue_verified as boolean | undefined) ?? null,
    protected: typeof legacy.protected === 'boolean' ? legacy.protected : null,
    // The viewer's own relationship with them, which X answers because the
    // query was made as somebody. It has lived in two places across X's
    // schema revisions -- on `legacy` and under `relationship_perspectives` --
    // and both are read rather than one being assumed, because the failure is
    // silent: a missing key is indistinguishable from "they do not follow you"
    // unless the absence is preserved, which is what `bool` does.
    weFollow: bool(legacy.following) ?? bool(perspectives(result).following),
    followsUs: bool(legacy.followed_by) ?? bool(perspectives(result).followed_by),
    provenance: provenanceFor(backend, { url: `https://x.com/${handle}` }),
  };
}

/**
 * How many people follow somebody, wherever this week's payload put it.
 *
 * X used to send it as `legacy.followers_count`. It now drops the author's
 * `legacy` block and sends `relationship_counts` instead, and every author read
 * came back with no audience at all: measured on a live installation, the
 * agent could not tell an account of two hundred thousand from an empty one.
 * Both places are read, old first, and a missing number stays missing.
 */
export function followerCountOf(user: Record<string, unknown> | undefined): number | null {
  if (!user) return null;
  const legacy = (user.legacy ?? {}) as Record<string, unknown>;
  const counts = (user.relationship_counts ?? {}) as Record<string, unknown>;
  return num(legacy.followers_count) ?? num(counts.followers) ?? num(counts.followers_count) ?? null;
}

function followingCountOf(user: Record<string, unknown>): number | null {
  const legacy = (user.legacy ?? {}) as Record<string, unknown>;
  const counts = (user.relationship_counts ?? {}) as Record<string, unknown>;
  return num(legacy.friends_count) ?? num(counts.following) ?? num(counts.friends_count) ?? null;
}

/** X's JSON for one post, as the contract's shape. */
export function toPost(tweet: Record<string, unknown>, backend: string): XPostRecord | null {
  const postId = tweet.rest_id;
  const legacy = (tweet.legacy ?? {}) as Record<string, unknown>;
  if (typeof postId !== 'string') return null;

  const userResult = ((tweet.core as Record<string, unknown> | undefined)?.user_results as Record<string, unknown> | undefined)
    ?.result as Record<string, unknown> | undefined;
  const userCore = (userResult?.core ?? {}) as Record<string, unknown>;
  const userLegacy = (userResult?.legacy ?? {}) as Record<string, unknown>;
  const handle = ((userCore.screen_name ?? userLegacy.screen_name) as string | undefined) ?? '';

  // Long-form posts carry their text somewhere else entirely, and reading
  // `full_text` alone silently truncates them at the old limit.
  const note = ((tweet.note_tweet as Record<string, unknown> | undefined)?.note_tweet_results as Record<string, unknown> | undefined)
    ?.result as Record<string, unknown> | undefined;
  const text = ((note?.text as string | undefined) ?? (legacy.full_text as string | undefined) ?? '').trim();

  const entities = (legacy.entities ?? {}) as Record<string, unknown>;
  const media = (((legacy.extended_entities ?? entities) as Record<string, unknown>).media ?? []) as Record<string, unknown>[];

  return {
    postId,
    authorId: (userResult?.rest_id as string | undefined) ?? (legacy.user_id_str as string | undefined) ?? null,
    authorHandle: handle,
    text,
    createdAt: (legacy.created_at as string | undefined) ?? null,
    url: handle ? `https://x.com/${handle}/status/${postId}` : `https://x.com/i/web/status/${postId}`,
    conversationId: (legacy.conversation_id_str as string | undefined) ?? null,
    replyToPostId: (legacy.in_reply_to_status_id_str as string | undefined) ?? null,
    replyToUserId: (legacy.in_reply_to_user_id_str as string | undefined) ?? null,
    quotedPostId: (legacy.quoted_status_id_str as string | undefined) ?? null,
    repost: typeof legacy.retweeted_status_result === 'object' && legacy.retweeted_status_result !== null,
    lang: (legacy.lang as string | undefined) ?? null,
    metrics: {
      replies: num(legacy.reply_count),
      reposts: num(legacy.retweet_count),
      likes: num(legacy.favorite_count),
      quotes: num(legacy.quote_count),
      views: num(Number((tweet.views as Record<string, unknown> | undefined)?.count)),
      bookmarks: num(legacy.bookmark_count),
    },
    // The author object arrives with the post, so this costs no extra request.
    authorFollowers: followerCountOf(userResult),
    media: media.map((item) => ({
      kind:
        item.type === 'photo' ? 'photo' : item.type === 'video' ? 'video' : item.type === 'animated_gif' ? 'gif' : 'unknown',
      url: (item.media_url_https as string | undefined) ?? null,
      altText: (item.ext_alt_text as string | undefined) ?? null,
    })),
    links: (((entities.urls ?? []) as { expanded_url?: string }[]) ?? [])
      .map((u) => u.expanded_url)
      .filter((u): u is string => typeof u === 'string'),
    provenance: provenanceFor(backend, { url: handle ? `https://x.com/${handle}/status/${postId}` : null }),
  };
}

/** The cursor for the next page, when the timeline offered one. */
export function nextCursor(json: unknown): string | null {
  for (const entry of timelineEntries(json)) {
    const id = entry.entryId;
    if (typeof id === 'string' && id.startsWith('cursor-bottom')) {
      const content = entry.content as Record<string, unknown> | undefined;
      const value =
        (content?.value as string | undefined) ??
        ((content?.itemContent as Record<string, unknown> | undefined)?.value as string | undefined);
      if (value) return value;
    }
  }
  return null;
}

const NAME = 'x-graphql';

export const pageGraphqlBackend: XIntelligenceBackend = {
  name: NAME,

  async readiness(ctx: XReadContext): Promise<XBackendReadiness> {
    const channel = ctx.channel as ChannelContext | null;
    if (!channel) {
      return { state: 'UNAVAILABLE', detail: 'No browser session to read through.', can: [] };
    }
    try {
      return await withSession(channel, 'RESEARCH', async (session) => {
        /*
          On X before asking what X exposes.

          The RESEARCH tab is opened blank and stays blank until something
          navigates it, and `about:blank` has no scripts -- so readiness on a
          fresh tab reported "X did not expose its read operations", every
          capability showed UNAVAILABLE on the health screen, and the one place
          an owner could have seen that the structured reader was not running
          said the opposite of the truth. The read paths already did this; the
          question about whether they can is the one that was asking on an empty
          page.
        */
        await ensureOnX(session.page);
        const ids = await discoverOperationIds(session.page);
        if (ids.size === 0) {
          return {
            state: 'DEGRADED' as const,
            detail: 'X did not expose its read operations to this page; falling back to reading the rendered page.',
            can: [],
          };
        }
        const can: XBackendReadiness['can'] = [];
        if (ids.has(OPERATIONS.userByScreenName)) can.push('resolveUser', 'getUser');
        if (ids.has(OPERATIONS.userTweets) || ids.has(OPERATIONS.userTweetsAndReplies)) can.push('getUserPosts');
        if (ids.has(OPERATIONS.searchTimeline) && Date.now() >= searchRefusedUntil) can.push('searchPosts');
        if (ids.has(OPERATIONS.tweetDetail)) can.push('getPost', 'getThread');
        return {
          state: can.length > 0 ? ('READY' as const) : ('DEGRADED' as const),
          detail: `Reading X's own data through the signed-in browser (${can.length} of ${X_CAPABILITIES.length} reads available).`,
          can,
        };
      });
    } catch (error) {
      return { state: 'UNAVAILABLE', detail: `The browser could not be used: ${(error as Error).message}`, can: [] };
    }
  },

  async resolveUser(ctx: XReadContext, handle: string): Promise<XReadResult<XUser | null>> {
    const channel = ctx.channel as ChannelContext | null;
    if (!channel) return emptyResult(NAME, 'UNAVAILABLE', 'No browser session to read through.', null);

    return withSession(channel, 'RESEARCH', async (session) => {
      await ensureOnX(session.page);
      const ids = await discoverOperationIds(session.page);
      const queryId = ids.get(OPERATIONS.userByScreenName);
      if (!queryId) {
        return emptyResult(NAME, 'SCHEMA_CHANGED', 'X did not expose its profile read to this page.', null);
      }

      const answer = await askGraphql(
        session.page,
        queryId,
        OPERATIONS.userByScreenName,
        { screen_name: handle, withSafetyModeUserFields: true },
        featuresFor(ids, OPERATIONS.userByScreenName),
      );
      if (!answer.ok) {
        const { outcome, detail } = outcomeFromError(answer.status, answer.error);
        return emptyResult(NAME, outcome, detail, null);
      }

      const result = findUserResult(answer.json);
      if (!result) return emptyResult(NAME, 'NOT_FOUND', `X did not return a profile for @${handle}.`, null);
      const user = toUser(result, NAME);
      if (!user) return emptyResult(NAME, 'SCHEMA_CHANGED', 'The profile came back in a shape this reader did not understand.', null);
      return { outcome: 'OK', detail: '', data: user, provenance: user.provenance };
    });
  },

  async getUserPosts(ctx: XReadContext, request: XPostsRequest): Promise<XReadResult<XPostRecord[]>> {
    const channel = ctx.channel as ChannelContext | null;
    if (!channel) return emptyResult(NAME, 'UNAVAILABLE', 'No browser session to read through.', []);
    const budget = ctx.budget ?? DEFAULT_BUDGET;

    return withSession(channel, 'RESEARCH', async (session) => {
      await ensureOnX(session.page);
      const ids = await discoverOperationIds(session.page);
      const wantReplies = request.includeReplies !== false;
      const operation = wantReplies ? OPERATIONS.userTweetsAndReplies : OPERATIONS.userTweets;
      const queryId = ids.get(operation) ?? ids.get(OPERATIONS.userTweets);
      if (!queryId) {
        return emptyResult(NAME, 'SCHEMA_CHANGED', 'X did not expose its timeline read to this page.', []);
      }

      const collected = new Map<string, XPostRecord>();
      const startedAt = Date.now();
      let cursor: string | null = null;
      let quiet = 0;
      let stopped: ReturnType<typeof classifyDetailed> | null = null;

      for (let page = 0; page < budget.maxPages; page += 1) {
        if (request.signal?.aborted) break;
        if (Date.now() - startedAt > budget.maxMs) break;

        const answer: GraphqlAnswer = await askGraphql(
          session.page,
          queryId,
          operation,
          {
            userId: request.userId,
            count: 40,
            includePromotedContent: false,
            withQuickPromoteEligibilityTweetFields: false,
            withVoice: true,
            withV2Timeline: true,
            ...(cursor ? { cursor } : {}),
          },
          featuresFor(ids, operation),
        );

        if (!answer.ok) {
          stopped = outcomeFromError(answer.status, answer.error);
          break;
        }

        const before = collected.size;
        for (const tweet of tweetsFrom(answer.json)) {
          const post = toPost(tweet, NAME);
          if (!post || !post.text) continue;
          if (!isByRequestedUser(post, request)) continue;
          if (post.repost && request.includeReposts === false) continue;
          if (request.sincePostId && post.postId === request.sincePostId) {
            cursor = null;
            break;
          }
          collected.set(post.postId, post);
        }
        request.onProgress?.(collected.size);

        if (collected.size >= request.limit) break;
        quiet = collected.size > before ? 0 : quiet + 1;
        if (quiet >= budget.maxQuietPages) break;

        cursor = nextCursor(answer.json);
        if (!cursor) break;
        // Paced deliberately. The page's own scrolling is slower than this.
        await session.page.waitForTimeout(400);
      }

      const posts = [...collected.values()].slice(0, request.limit);
      if (stopped && posts.length === 0) return emptyResult(NAME, stopped.outcome, stopped.detail, []);
      if (posts.length === 0) {
        return emptyResult(NAME, 'EMPTY', `X returned no posts for @${request.handle}.`, []);
      }
      return {
        outcome: 'OK',
        detail: `Read ${posts.length} posts by @${request.handle}.`,
        data: posts,
        provenance: provenanceFor(NAME, {
          url: `https://x.com/${request.handle}`,
          // A partial read says so rather than presenting itself as the whole
          // timeline, because the difference decides whether a persona built
          // from it is a sample or a summary.
          gaps: stopped ? [`stopped early: ${stopped.detail}`] : [],
        }),
      };
    });
  },

  /**
   * One post, by its id.
   *
   * The same query X's own status page makes, which is also why this one query
   * serves both `getPost` and `getThread`: the answer carries the focal post and
   * the conversation X has already resolved around it.
   */
  async getPost(ctx: XReadContext, postId: XId): Promise<XReadResult<XPostRecord | null>> {
    const channel = ctx.channel as ChannelContext | null;
    if (!channel) return emptyResult(NAME, 'UNAVAILABLE', 'No browser session to read through.', null);

    return withSession(channel, 'RESEARCH', async (session) => {
      const detail = await readTweetDetail(session.page, postId);
      if (detail.outcome !== 'OK') return emptyResult(NAME, detail.outcome, detail.detail, null);

      const found = detail.posts.find((post) => post.postId === postId) ?? null;
      if (!found) {
        // X answered, and the post asked for was not in the answer. A deleted
        // post and one hidden from this viewer both land here, and neither is a
        // schema problem -- so this is NOT_FOUND, which stops the read rather
        // than sending it to a second backend that would ask X again.
        return emptyResult(NAME, 'NOT_FOUND', 'X did not return that post.', null);
      }
      return {
        outcome: 'OK',
        detail: '',
        data: found,
        provenance: provenanceFor(NAME, { url: found.url }),
      };
    });
  },

  /**
   * A post and the posts above it, root first.
   *
   * **The chain is walked, not sliced.** X returns the conversation as a list of
   * entries, and the obvious implementation takes everything before the focal
   * post -- which is how a sibling branch ends up in a thread. The reply-to ids
   * are in the data, so the ancestry is followed through them: start at the
   * focal post, climb `replyToPostId` while the parent is present, reverse.
   *
   * That is the same conclusion `x/conversation.ts` reached for the rendered
   * page, arrived at differently because the JSON carries the links the DOM does
   * not. Both refuse the positional shortcut for the same reason: a thread that
   * quietly contains somebody else's tangent is a prompt that quietly contains
   * somebody else's tangent.
   */
  async getThread(ctx: XReadContext, postId: XId): Promise<XReadResult<XPostRecord[]>> {
    const channel = ctx.channel as ChannelContext | null;
    if (!channel) return emptyResult(NAME, 'UNAVAILABLE', 'No browser session to read through.', []);

    return withSession(channel, 'RESEARCH', async (session) => {
      const detail = await readTweetDetail(session.page, postId);
      if (detail.outcome !== 'OK') return emptyResult(NAME, detail.outcome, detail.detail, []);

      const chain = ancestorChain(detail.posts, postId);
      if (chain.length === 0) return emptyResult(NAME, 'NOT_FOUND', 'X did not return that post.', []);

      const root = chain[0]!;
      const reachedRoot = root.replyToPostId === null;
      return {
        outcome: 'OK',
        detail: `Read ${chain.length} post${chain.length === 1 ? '' : 's'} in the conversation.`,
        data: chain,
        provenance: provenanceFor(NAME, {
          url: chain[chain.length - 1]!.url,
          // Said rather than implied. A chain that stops because X did not
          // return the parent is not the start of the conversation, and a
          // prompt built from it would open partway through an exchange while
          // looking complete.
          gaps: reachedRoot ? [] : ['the conversation continues above the oldest post X returned'],
        }),
      };
    });
  },

  async searchPosts(
    ctx: XReadContext,
    request: { query: string; limit: number; latest?: boolean },
  ): Promise<XReadResult<XPostRecord[]>> {
    const channel = ctx.channel as ChannelContext | null;
    if (!channel) return emptyResult(NAME, 'UNAVAILABLE', 'No browser session to read through.', []);

    return withSession(channel, 'RESEARCH', async (session) => {
      await ensureOnX(session.page);
      const ids = await discoverOperationIds(session.page);
      const queryId = ids.get(OPERATIONS.searchTimeline);
      if (!queryId) return emptyResult(NAME, 'SCHEMA_CHANGED', 'X did not expose search to this page.', []);

      const answer = await askGraphql(
        session.page,
        queryId,
        OPERATIONS.searchTimeline,
        {
          rawQuery: request.query,
          count: Math.min(Math.max(request.limit, 1), 50),
          querySource: 'typed_query',
          product: request.latest === false ? 'Top' : 'Latest',
        },
        featuresFor(ids, OPERATIONS.searchTimeline),
      );
      if (!answer.ok) {
        reportRefusal(session.page, OPERATIONS.searchTimeline, queryId, answer.status, answer.error);
        if (answer.status === 404 && !answer.error?.trim()) searchRefusedUntil = Date.now() + 30 * 60_000;
        const { outcome, detail } = outcomeFromError(answer.status, answer.error);
        return emptyResult(NAME, outcome, detail, []);
      }

      const posts: XPostRecord[] = [];
      for (const tweet of tweetsFrom(answer.json)) {
        const post = toPost(tweet, NAME);
        if (post?.text) posts.push(post);
        if (posts.length >= request.limit) break;
      }
      if (posts.length === 0) return emptyResult(NAME, 'EMPTY', 'X returned nothing for that search.', []);
      return {
        outcome: 'OK',
        detail: `Found ${posts.length} posts.`,
        data: posts,
        provenance: provenanceFor(NAME, { url: `https://x.com/search?q=${encodeURIComponent(request.query)}` }),
      };
    });
  },
};

/**
 * The conversation X renders around one post, as normalised records.
 *
 * One query serves both `getPost` and `getThread` because X's status page makes
 * exactly this request and gets both from it: the post asked for, the chain
 * above it already resolved, and the replies below. Asking twice would be two
 * requests for one answer.
 */
async function readTweetDetail(
  page: Page,
  postId: XId,
): Promise<{ outcome: XReadOutcome; detail: string; posts: XPostRecord[] }> {
  await ensureOnX(page);
  const ids = await discoverOperationIds(page);
  const queryId = ids.get(OPERATIONS.tweetDetail);
  if (!queryId) {
    return { outcome: 'SCHEMA_CHANGED', detail: 'X did not expose its post read to this page.', posts: [] };
  }

  const answer = await askGraphql(
    page,
    queryId,
    OPERATIONS.tweetDetail,
    {
      focalTweetId: postId,
      with_rux_injections: false,
      includePromotedContent: false,
      withCommunity: true,
      withQuickPromoteEligibilityTweetFields: false,
      withBirdwatchNotes: false,
      withVoice: true,
      withV2Timeline: true,
    },
    featuresFor(ids, OPERATIONS.tweetDetail),
  );
  if (!answer.ok) {
    const { outcome, detail } = outcomeFromError(answer.status, answer.error);
    return { outcome, detail, posts: [] };
  }

  const posts: XPostRecord[] = [];
  for (const tweet of tweetsFrom(answer.json)) {
    const post = toPost(tweet, NAME);
    if (post) posts.push(post);
  }
  if (posts.length === 0) {
    return { outcome: 'EMPTY', detail: 'X returned nothing for that post.', posts: [] };
  }
  return { outcome: 'OK', detail: '', posts };
}

/**
 * The focal post and everything it is an answer to, root first.
 *
 * Pure, and exported so eleven lines of reasoning about somebody else's data
 * model can be pinned against fixtures rather than against a live X. The rule
 * it implements is small and the failure it prevents is not: **follow the
 * reply-to links, never the order of the list.**
 *
 * A status page carries the ancestors, the focal post, its replies, and the
 * replies to those. Taking "everything before the focal post" gets the right
 * answer often enough to look correct and puts a stranger's tangent into a
 * prompt the rest of the time. Climbing `replyToPostId` cannot: a post either
 * is the parent or is not.
 *
 * Stops on a post it has already seen, because a cycle in this data would
 * otherwise be an infinite loop in a worker. X should never produce one; a
 * reader that trusts a remote service not to is a reader that hangs.
 */
export function ancestorChain(posts: XPostRecord[], focalId: XId): XPostRecord[] {
  const byId = new Map(posts.map((post) => [post.postId, post]));
  const focal = byId.get(focalId);
  if (!focal) return [];

  const chain: XPostRecord[] = [focal];
  const seen = new Set<string>([focal.postId]);
  let current = focal;
  while (current.replyToPostId) {
    const parent = byId.get(current.replyToPostId);
    if (!parent || seen.has(parent.postId)) break;
    seen.add(parent.postId);
    chain.push(parent);
    current = parent;
  }
  return chain.reverse();
}

/** The user object, wherever this week's wrappers put it. */
export function findUserResult(json: unknown): Record<string, unknown> | null {
  let found: Record<string, unknown> | null = null;
  const walk = (node: unknown, depth: number) => {
    if (found || !node || typeof node !== 'object' || depth > 10) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    const record = node as Record<string, unknown>;
    if (typeof record.rest_id === 'string' && (record.legacy || record.core)) {
      const legacy = (record.legacy ?? {}) as Record<string, unknown>;
      const core = (record.core ?? {}) as Record<string, unknown>;
      if (legacy.screen_name || core.screen_name) {
        found = record;
        return;
      }
    }
    for (const value of Object.values(record)) walk(value, depth + 1);
  };
  walk(json, 0);
  return found;
}

/**
 * The GraphQL calls are same-origin, so the page has to be on X first.
 *
 * Cheap when it already is, which is the common case: the RESEARCH tab spends
 * its life there.
 */
async function ensureOnX(page: Page): Promise<void> {
  const url = page.url();
  if (/^https:\/\/(x|twitter)\.com\//.test(url)) return;
  await goto(page, 'https://x.com/home');
  await settle();
}
