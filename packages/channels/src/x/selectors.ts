/**
 * Every piece of X DOM knowledge lives in this file.
 *
 * Selectors are the most brittle part of browser automation; keeping them in one
 * place means a platform redesign is a single-file change and never leaks into
 * memory, prompts, or job state.
 */

export const X_URLS = {
  home: 'https://x.com/home',
  notifications: 'https://x.com/notifications',
  mentions: 'https://x.com/notifications/mentions',
  login: 'https://x.com/i/flow/login',
  /** X renamed this from /compose/tweet; both still resolve. */
  compose: 'https://x.com/compose/post',
  profile: (handle: string) => `https://x.com/${handle}`,
};

export const SEL = {
  /** Present only when a session is authenticated. */
  loggedIn: '[data-testid="SideNav_AccountSwitcher_Button"], [data-testid="AppTabBar_Home_Link"]',
  loginForm: '[data-testid="loginButton"], input[autocomplete="username"]',
  tweetArticle: 'article[data-testid="tweet"]',
  userName: '[data-testid="User-Name"]',
  /** The badge X puts beside a verified account's name. */
  verifiedBadge: '[data-testid="User-Name"] [data-testid="icon-verified"]',
  tweetText: '[data-testid="tweetText"]',
  replyButton: '[data-testid="reply"]',
  dialog: 'div[role="dialog"]',
  composer: '[data-testid="tweetTextarea_0"]',
  submitInline: 'div[role="dialog"] [data-testid="tweetButtonInline"]',
  submitButton: 'div[role="dialog"] [data-testid="tweetButton"]',
  /** The composer on the timeline, used when the compose route does not open. */
  inlineComposer: '[data-testid="tweetTextarea_0"]',
  inlineSubmit: '[data-testid="tweetButtonInline"], [data-testid="tweetButton"]',
  timeLink: 'a[href*="/status/"] time',
} as const;

/**
 * Anchors to the exact post by status id rather than trusting position.
 * "If we cannot find the exact article, do not risk replying to the wrong one."
 */
export function articleForStatus(statusId: string): string {
  return `article[data-testid="tweet"]:has(a[href*="/status/${statusId}"])`;
}

/**
 * Signals that X is asking for something only the account owner can supply.
 *
 * These exist so AI17Z can recognise a challenge and stop. They are not here to
 * be answered, worked around, or automated: the agent hands the open window back
 * to the person and waits. Matching is deliberately generous, because a
 * challenge that goes unrecognised is one an automated flow might blunder into.
 */
export const CHALLENGE_SIGNALS: { kind: string; describe: string; selector?: string; text?: RegExp }[] = [
  {
    kind: 'two_factor',
    describe: 'X is asking for a two-factor code.',
    selector: 'input[data-testid="ocfEnterTextTextInput"][name="text"]',
    text: /two-factor|2-factor|authentication code|verification code/i,
  },
  {
    kind: 'email_verification',
    describe: 'X is asking for a code it emailed to the account.',
    text: /we sent you a code|check your email|confirm your email/i,
  },
  {
    kind: 'phone_verification',
    describe: 'X is asking for a phone number or a code sent by text.',
    text: /phone number|sent you a text|confirm your phone/i,
  },
  {
    kind: 'captcha',
    describe: 'X is showing a CAPTCHA.',
    selector: 'iframe[src*="recaptcha"], iframe[src*="arkoselabs"], iframe[title*="challenge" i]',
    text: /solve this puzzle|prove you.re human|are you a robot/i,
  },
  {
    kind: 'suspicious_login',
    describe: 'X flagged the sign-in as unusual and wants the owner to confirm it.',
    text: /unusual (login|activity)|suspicious (login|activity)|verify it.s you|help us keep your account safe/i,
  },
  {
    kind: 'account_locked',
    describe: 'The account is locked or suspended. Only the owner can resolve this with X.',
    text: /your account (has been )?(locked|suspended)|account is temporarily/i,
  },
  {
    kind: 'hardware_key',
    describe: 'X is asking for a hardware security key.',
    text: /security key|use your passkey|insert your key/i,
  },
];

/** The sign-in form is showing, so nobody has entered anything yet. */
export const SEL_AUTH = {
  usernameField: 'input[autocomplete="username"]',
  passwordField: 'input[name="password"], input[autocomplete="current-password"]',
} as const;
