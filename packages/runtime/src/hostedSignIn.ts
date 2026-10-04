/**
 * Connecting an account on a runtime the owner cannot see.
 *
 * Locally this is settled: `OPEN_AUTH` opens the real browser window, a person
 * signs in, the session lives in the profile, and `observeAuthPage` only
 * looks. Hosting breaks the one assumption that rested on, which is that the
 * owner is at the keyboard, and the obvious replacement is the one thing that
 * must not be built: a form on a website asking somebody for their username,
 * their password and the code from their phone, and a database holding all
 * three for every customer.
 *
 * So this file is the list of routes that exist, the list that is refused, and
 * the reason for each. It is a list rather than a function because the pressure
 * here is product pressure: the refused route is always easier, and a refusal
 * that lives only in somebody's memory of a conversation is a refusal that
 * lasts until they are on holiday.
 *
 * The absolute is unchanged and hosting does not create an exception to it.
 * **AI17Z never answers a security challenge.** A CAPTCHA, a second factor, an
 * emailed or texted code, a hardware key, a confirmation of an unusual login
 * or a locked account stops the agent, leaves the page alone, and stops
 * reading it. There is no setting, no code path and no hosted variant.
 */

import { SECRET_PLACEMENT_RULES } from './hostedSecrets';

// ---------------------------------------------------------------------------
// The routes that exist
// ---------------------------------------------------------------------------

export const HOSTED_SIGNIN_ROUTES = ['OWNER_DRIVES_STREAM', 'RUNTIME_HELD_CREDENTIAL'] as const;
export type HostedSignInRoute = (typeof HOSTED_SIGNIN_ROUTES)[number];

export interface RouteDescription {
  route: HostedSignInRoute;
  /** What the owner actually does. */
  how: string;
  /** Where the credential ends up, said precisely. */
  credentialLands: string;
  /** Whether this is the default. Exactly one is. */
  isDefault: boolean;
  /** What it does not buy, because both of these buy less than they look like. */
  limits: readonly string[];
}

export const ROUTE_DESCRIPTIONS: readonly RouteDescription[] = [
  {
    route: 'OWNER_DRIVES_STREAM',
    how:
      'The owner takes the runtime browser through the takeover stream and types into the real page themselves, exactly as they would on their own machine.',
    credentialLands: 'Nowhere. It is typed into the page and the session lives in that runtime\'s own browser profile.',
    isDefault: true,
    limits: [
      'It needs the owner present, which is the point and is also why it cannot be the only route for an account that signs out at three in the morning.',
      'Frames cross the host and the control plane, so the stream is not end to end encrypted and is never described as though it were.',
      'A challenge still stops everything and waits for the person. That is the same stop as locally.',
    ],
  },
  {
    route: 'RUNTIME_HELD_CREDENTIAL',
    how:
      'The owner stores a username and password on their own runtime, through the gateway bound to that runtime, and the runtime seals it under its own master key.',
    credentialLands:
      'In that one runtime\'s own database, sealed under that one runtime\'s own key. Never in the control plane, never in a shared store, never readable by another tenant.',
    isDefault: false,
    limits: [
      'An account with two factor authentication on, which it should have, reaches the code step on every fresh sign-in and still needs a person.',
      'Filling a form programmatically is more likely to be challenged than a person typing, so this can produce the challenge that stops it.',
      'It is off by default and the interface says all of the above before it is turned on.',
    ],
  },
];

/** Exactly one default, checked rather than asserted in a comment. */
export function defaultRoute(): HostedSignInRoute {
  const defaults = ROUTE_DESCRIPTIONS.filter((r) => r.isDefault);
  if (defaults.length !== 1) throw new Error('There must be exactly one default sign-in route.');
  return defaults[0]!.route;
}

// ---------------------------------------------------------------------------
// The routes that are refused
// ---------------------------------------------------------------------------

export interface RefusedRoute {
  /** What somebody would call it when proposing it. */
  proposal: string;
  /** Why not, in a sentence an owner would accept as a reason. */
  why: string;
}

/**
 * Each of these is easier than the routes above, which is why they are written
 * down rather than left to be re-decided under pressure.
 */
export const REFUSED_SIGNIN_ROUTES: readonly RefusedRoute[] = [
  {
    proposal: 'A Studio form collecting X username, password and 2FA code, stored centrally for every customer.',
    why:
      'One store holding every customer\'s password for somebody else\'s service is the most valuable thing this product could build, and it would be valuable to exactly one kind of person. A credential belongs on the runtime it is for, sealed under that runtime\'s own key.',
  },
  {
    proposal: 'A central vault the control plane can read, so a runtime can be re-signed-in without the owner.',
    why:
      'A vault the control plane can read is a vault an operator with the control plane can read. It would make the key custody question meaningless, and the honest answer to that question is already uncomfortable enough.',
  },
  {
    proposal: 'Relaying a texted or emailed code through AI17Z so the agent can complete a second factor.',
    why:
      'That is answering a security challenge, which AI17Z does not do. Relaying it rather than typing it does not change what it is.',
  },
  {
    proposal: 'A CAPTCHA solving service, paid or otherwise, so a hosted runtime does not stall.',
    why:
      'No solver, no bypass, no setting. A challenge stops the agent and waits for a person, and a stalled runtime an owner can fix is better than one that got past a control it was not meant to.',
  },
  {
    proposal: 'Importing a customer\'s session cookies from their own browser so the runtime starts signed in.',
    why:
      'It asks a customer to export a bearer credential for somebody else\'s service and send it somewhere, which is the shape of a phishing instruction whoever sends it. It would also carry a session the service bound to a different device.',
  },
  {
    proposal: 'Holding a recovery code or backup codes so a runtime can recover an account on its own.',
    why:
      'Recovery codes are the one credential that defeats the second factor entirely. A system that holds them has not reduced the risk of holding a password, it has concentrated it.',
  },
  {
    proposal: 'Signing in on the customer\'s behalf from a shared pool of addresses to look like ordinary traffic.',
    why:
      'That is evading a service\'s own security controls, which is outside what this product does whatever it would make easier.',
  },
];

export type RouteVerdict = { allowed: true; description: RouteDescription } | { allowed: false; why: string };

/**
 * Whether a named route is one that exists.
 *
 * Takes a string rather than the union on purpose: the thing being checked is
 * usually something that arrived from outside, and a union would make the
 * check disappear at the type level while the value still arrived.
 */
export function routeVerdict(route: string): RouteVerdict {
  const found = ROUTE_DESCRIPTIONS.find((r) => r.route === route);
  if (found) return { allowed: true, description: found };

  // Long enough to be a word somebody meant. A two-letter probe matches half
  // the list and would answer a typo with an unrelated refusal.
  const probe = route.trim().toLowerCase();
  const refused =
    probe.length >= 6 ? REFUSED_SIGNIN_ROUTES.find((r) => r.proposal.toLowerCase().includes(probe.slice(0, 24))) : undefined;
  return {
    allowed: false,
    why: refused
      ? refused.why
      : `${route} is not a sign-in route AI17Z has. The routes are ${HOSTED_SIGNIN_ROUTES.join(' and ')}.`,
  };
}

// ---------------------------------------------------------------------------
// Where a stored credential may live
// ---------------------------------------------------------------------------

/**
 * Places a credential must never be written, named so a test can check them.
 *
 * The first four are carried from the local rule about `account_credentials`,
 * which is already sealed under the master key and already kept out of
 * `browser_tasks.params` because that column is persisted in the clear and
 * shown in the panel's task history. Hosting adds the control plane, which is
 * the new place and the tempting one.
 */
export const CREDENTIAL_FORBIDDEN_PLACES: readonly string[] = [
  'an API response',
  'a log line',
  'an audit row',
  'a trace',
  'browser_tasks.params',
  'the control plane database',
  'a host assignment',
  'scheduler metadata',
  'a backup the control plane can read',
  'an exported agent package',
  'prompt context or anything a model can see',
];

export type PlacementVerdict = { ok: true } | { ok: false; why: string };

/** Whether a named destination may hold a credential. */
export function credentialPlacement(destination: string): PlacementVerdict {
  const where = destination.trim().toLowerCase();
  if (!where) return { ok: false, why: 'A credential is not written somewhere nobody named.' };

  for (const forbidden of CREDENTIAL_FORBIDDEN_PLACES) {
    if (where.includes(forbidden.toLowerCase())) {
      return { ok: false, why: `A credential is never written to ${forbidden}.` };
    }
  }

  // The only destination that is right, said positively rather than as the
  // absence of a refusal, because a new place nobody listed would otherwise
  // pass.
  if (/runtime/.test(where) && /(seal|encrypt)/.test(where)) return { ok: true };

  return {
    ok: false,
    why: 'A credential goes to the runtime it belongs to, sealed under that runtime\'s own key, and nowhere else.',
  };
}

// ---------------------------------------------------------------------------
// The stop
// ---------------------------------------------------------------------------

/**
 * Said once, here, in the words the rest of the product uses.
 *
 * Repeated rather than referenced because this is the sentence somebody will
 * read when they are looking for the exception, and finding it as a link to
 * another file is how a reader concludes there might be one.
 */
export const CHALLENGE_STOP =
  'AI17Z never answers a security challenge. A CAPTCHA, a second factor, an emailed or texted code, a hardware key, a confirmation of an unusual login or a locked account stops the agent, leaves the window open and untouched, and stops reading the page. There is no setting for this, no code path around it, and hosting does not create one.';

/** Every sentence this module commits to, for the test that reads them. */
export function signInCommitments(): readonly string[] {
  return [CHALLENGE_STOP, ...SECRET_PLACEMENT_RULES, ...REFUSED_SIGNIN_ROUTES.map((r) => r.why)];
}
