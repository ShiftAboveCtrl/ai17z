import type { AccountStatus, ChannelId } from './enums';

/**
 * What a sign-in problem means, in words a person can act on.
 *
 * Isomorphic on purpose: the start check, the health screen, the owner
 * notification and the account screen all describe the same state, and four
 * places each writing their own sentence is how one of them ends up telling
 * somebody the wrong fix. A browser channel's problems are described by the
 * sign-in window itself; this covers the channel that has none.
 */
export interface SignInExplanation {
  /** What is wrong, as a fact. */
  what: string;
  /** What to do about it, as an instruction. */
  fix: string;
}

const BLUESKY: Partial<Record<AccountStatus, SignInExplanation>> = {
  NEEDS_AUTH: {
    what: 'Bluesky does not accept the app password stored for this account.',
    fix: 'Make a new app password in Bluesky under Settings, Privacy and security, App passwords, and store it here. Nothing is read or sent until then.',
  },
  CHALLENGE_REQUIRES_USER: {
    what: 'Bluesky is asking for a code it emailed.',
    fix: 'AI17Z never answers that. Link the account again with an app password, which does not ask for one. Nothing is read or sent until then.',
  },
  ERROR: {
    what: 'Bluesky signed in but says this account is not available, for example suspended or deactivated.',
    fix: 'Check the account in Bluesky. AI17Z will not act on it until Bluesky says it is available.',
  },
  DISCONNECTED: {
    what: 'This Bluesky account is not connected.',
    fix: 'Store an app password for it to connect.',
  },
};

/** The explanation for an account that needs attention, or null if it does not or the channel has none. */
export function describeSignIn(channel: ChannelId | string, status: AccountStatus | string): SignInExplanation | null {
  if (channel !== 'bluesky') return null;
  return BLUESKY[status as AccountStatus] ?? null;
}
