import type { ChannelId } from './enums';
import type { RadarSourceKind } from './radar';
import { X_READ_PACING, type XReadPace } from './xPacing';

/**
 * What one network is, as far as the engine that drives it needs to know.
 *
 * The engine used to ask `channel === 'x'` in about sixteen places, and each of
 * those was really asking a narrower question: does this network need a
 * browser, does reading it spend the account's budget, what does it seed a new
 * account's radar with, where does a post live. A profile answers each of
 * those by name, so a second browser-driven network is a new entry here and a
 * new adapter folder, and none of those sixteen places is edited again.
 *
 * Everything here is data: no selector, no cookie, no page. What a challenge
 * looks like and where the composer sits stay in the adapter, behind the
 * boundary `CLAUDE.md` draws. This is the part that is the same on any page of
 * any network: how long a post may be, which tabs the account keeps, how often
 * a kind of page may be read.
 *
 * **An unknown channel has no profile**, and every lookup below answers that
 * with the behaviour a non-browser channel already had: no browser, no read
 * budget, no radar defaults. Never a throw, because a channel nobody has built
 * an adapter for is a normal state of this codebase.
 */

/** The four tabs an account keeps. Named for what a person would recognise. */
export const NETWORK_TAB_ROLES = ['ACTION', 'MENTIONS', 'NOTIFICATIONS', 'RESEARCH'] as const;
export type NetworkTabRole = (typeof NETWORK_TAB_ROLES)[number];

/** How often a kind of page may be read. One table per network, floors included. */
export type NetworkReadPacing = Record<Exclude<RadarSourceKind, 'market_signal'>, XReadPace>;

export interface NetworkRadarPreset {
  kind: RadarSourceKind;
  label: string;
  intervalSeconds: number;
}

export interface NetworkProfile {
  channel: ChannelId;
  displayName: string;
  /** `browser` is driven through the signed-in Chrome; `api` talks to the network's own HTTP API. */
  engine: 'browser' | 'api';

  text: {
    /** What the network itself accepts for a post. Policy may be stricter, never looser. */
    postMaxChars: number;
    replyMaxChars: number;
    /** Null when there is no direct message surface to write to. */
    dmMaxChars: number | null;
  };

  media: {
    /** True where a post without a picture or a clip cannot be published at all. */
    postRequiresMedia: boolean;
  };

  surfaces: {
    /** Where a reply is typed: a dialog or inline on the post page, or only a comment box. */
    reply: 'INLINE_OR_DIALOG' | 'COMMENT_BOX' | 'DIALOG_ONLY' | 'API';
    directMessages: boolean;
    search: boolean;
  };

  /**
   * The tabs a browser-driven account keeps, and what a tab whose tag was lost
   * looks like. Null for a network that is not driven through a browser.
   */
  browser: {
    /** Where a freshly started Chrome is sent. */
    startUrl: string;
    /** Where an idle action tab is parked between jobs. */
    homeUrl: string;
    tabs: NetworkTabPatterns;
  } | null;

  urls: {
    /** A person's profile page. */
    profile: (handle: string) => string;
    /**
     * A post's permalink, from its id and, where the network needs it, its
     * author. Null when the network cannot say from what it was given.
     */
    post: (id: string, authorHandle?: string | null) => string | null;
  };

  /**
   * What a post id looks like inside a pasted link or on its own. Null when the
   * network's posts cannot be read back from a link yet.
   */
  postIdPattern: { inLink: RegExp; bare: RegExp } | null;

  /**
   * Hosts a public screenshot may never be taken of, redirects and embedded
   * requests included: the network belongs to the signed-in reading layer. A
   * host matches itself and any subdomain.
   */
  refusedCaptureHosts: readonly string[];

  pacing: {
    read: NetworkReadPacing | null;
    /** What a new account on this network starts watching. Empty when it has no radar. */
    defaultRadar: readonly NetworkRadarPreset[];
  };

  /**
   * Things a network may or may not have, named so a gate reads as a question
   * about the feature and never as a comparison against a channel's name.
   */
  features: {
    /** Reading it on an account's behalf spends from the one capacity budget. */
    spendsReadBudget: boolean;
    /** The canonical reading layer can resolve a user, read their posts and a thread. */
    accountReads: boolean;
    /** The agent may be handed `x.*` style read tools bound to this network. */
    capabilityTools: boolean;
    /** Studio's mirrored audience counts are measured for it. */
    studioCounts: boolean;
  };
}

/**
 * Which tab shows what, for a tab whose `window.name` did not survive.
 *
 * Only roles with an unambiguous page appear. ACTION deliberately has no
 * pattern: its page is whichever post is being answered, and guessing there
 * would claim a stranger's tab.
 */
export interface NetworkTabPatterns {
  /** Roles this network uses. All four on X. */
  roles: readonly NetworkTabRole[];
  /** What each role's page looks like, where the shape is unambiguous. */
  looksLike: Partial<Record<NetworkTabRole, RegExp>>;
  /** A page on this network, which an untagged tab may become the action tab by. */
  onNetwork: RegExp;
}

function xDefaultRadar(): NetworkRadarPreset[] {
  return [
    { kind: 'notifications', label: 'Notifications', intervalSeconds: X_READ_PACING.notifications.defaultSeconds },
    { kind: 'mention_search', label: 'Mention search', intervalSeconds: X_READ_PACING.mention_search.defaultSeconds },
    { kind: 'reply_search', label: 'Reply search', intervalSeconds: X_READ_PACING.reply_search.defaultSeconds },
    { kind: 'own_threads', label: 'Replies to own posts', intervalSeconds: X_READ_PACING.own_threads.defaultSeconds },
  ];
}

export const X_NETWORK_PROFILE: NetworkProfile = {
  channel: 'x',
  displayName: 'X',
  engine: 'browser',
  text: { postMaxChars: 280, replyMaxChars: 280, dmMaxChars: 10_000 },
  media: { postRequiresMedia: false },
  surfaces: { reply: 'INLINE_OR_DIALOG', directMessages: true, search: true },
  browser: {
    startUrl: 'https://x.com/home',
    homeUrl: 'https://x.com/home',
    tabs: {
      roles: NETWORK_TAB_ROLES,
      looksLike: {
        MENTIONS: /x\.com\/search\?q=|x\.com\/[^/]+\/with_replies/i,
        NOTIFICATIONS: /x\.com\/notifications/i,
        RESEARCH: /^https?:\/\/(?!.*x\.com)/i,
      },
      onNetwork: /x\.com/i,
    },
  },
  urls: {
    profile: (handle) => `https://x.com/${handle}`,
    post: (id) => `https://x.com/i/web/status/${id}`,
  },
  postIdPattern: { inLink: /\/status(?:es)?\/(\d{5,25})/, bare: /^\d{5,25}$/ },
  refusedCaptureHosts: ['x.com', 'twitter.com', 't.co'],
  pacing: { read: X_READ_PACING, defaultRadar: xDefaultRadar() },
  features: { spendsReadBudget: true, accountReads: true, capabilityTools: true, studioCounts: true },
};

/**
 * Bluesky is here for the questions that are not about a browser. It reads over
 * its own HTTP API, so it has no tabs and no start URL, but it does spend the
 * account budget and the engine has to be able to say so by name.
 */
export const BLUESKY_NETWORK_PROFILE: NetworkProfile = {
  channel: 'bluesky',
  displayName: 'Bluesky',
  engine: 'api',
  text: { postMaxChars: 300, replyMaxChars: 300, dmMaxChars: null },
  media: { postRequiresMedia: false },
  surfaces: { reply: 'API', directMessages: false, search: false },
  browser: null,
  urls: {
    profile: (handle) => `https://bsky.app/profile/${handle}`,
    post: (id, authorHandle) => (authorHandle ? `https://bsky.app/profile/${authorHandle}/post/${id}` : null),
  },
  postIdPattern: null,
  refusedCaptureHosts: [],
  pacing: { read: null, defaultRadar: [] },
  features: { spendsReadBudget: true, accountReads: false, capabilityTools: false, studioCounts: false },
};

const PROFILES = new Map<string, NetworkProfile>([
  [X_NETWORK_PROFILE.channel, X_NETWORK_PROFILE],
  [BLUESKY_NETWORK_PROFILE.channel, BLUESKY_NETWORK_PROFILE],
]);

/**
 * The profile for a channel, or `undefined` for one that has none.
 *
 * Takes a plain string because the callers hold database rows and URL
 * parameters, and the answer for a value that is not a channel is the same as
 * for one nobody has described yet.
 */
export function getNetworkProfile(channel: string | null | undefined): NetworkProfile | undefined {
  return channel ? PROFILES.get(channel) : undefined;
}

/** Every network that has a profile, in registration order. */
export function listNetworkProfiles(): NetworkProfile[] {
  return [...PROFILES.values()];
}

/** Whether the network is driven through the signed-in browser. False for an unknown channel. */
export function isBrowserNetwork(channel: string | null | undefined): boolean {
  return getNetworkProfile(channel)?.engine === 'browser';
}

/** Whether a named feature exists on this network. False for an unknown channel. */
export function networkHas(channel: string | null | undefined, feature: keyof NetworkProfile['features']): boolean {
  return getNetworkProfile(channel)?.features[feature] ?? false;
}

/**
 * How often a kind of page may be read on a network, and whether the owner's
 * setting was raised to the floor.
 *
 * A network with no read pacing keeps exactly what it was configured with, as
 * every channel but X did before this existed.
 */
export function effectiveReadInterval(
  channel: string | null | undefined,
  kind: RadarSourceKind,
  configuredSeconds: number | null | undefined,
): { seconds: number; raised: boolean } | null {
  const table = getNetworkProfile(channel)?.pacing.read;
  if (!table) return null;
  if (kind === 'market_signal') {
    return { seconds: Math.max(300, configuredSeconds ?? 300), raised: (configuredSeconds ?? 300) < 300 };
  }
  const pace = table[kind];
  const wanted = configuredSeconds ?? pace.defaultSeconds;
  if (wanted < pace.floorSeconds) return { seconds: pace.floorSeconds, raised: true };
  return { seconds: wanted, raised: false };
}

/** A person's profile page on a network, or null when the network has no profile. */
export function profileUrlFor(channel: string | null | undefined, handle: string): string | null {
  const profile = getNetworkProfile(channel);
  return profile ? profile.urls.profile(handle.replace(/^@+/, '')) : null;
}

/** A post id from a pasted link or a bare id, on the given network. Null when it is neither. */
export function postIdFromInput(channel: string | null | undefined, input: string): string | null {
  const pattern = getNetworkProfile(channel)?.postIdPattern;
  if (!pattern) return null;
  const text = input.trim();
  if (pattern.bare.test(text)) return text;
  return text.match(pattern.inLink)?.[1] ?? null;
}

/** A post's permalink on a network, or null when the network has no profile or cannot build one. */
export function postUrlFor(channel: string | null | undefined, id: string, authorHandle?: string | null): string | null {
  return getNetworkProfile(channel)?.urls.post(id, authorHandle) ?? null;
}
