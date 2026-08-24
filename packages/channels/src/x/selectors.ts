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
};

export const SEL = {
  /** Present only when a session is authenticated. */
  loggedIn: '[data-testid="SideNav_AccountSwitcher_Button"], [data-testid="AppTabBar_Home_Link"]',
  loginForm: '[data-testid="loginButton"], input[autocomplete="username"]',
  tweetArticle: 'article[data-testid="tweet"]',
  userName: '[data-testid="User-Name"]',
  tweetText: '[data-testid="tweetText"]',
  replyButton: '[data-testid="reply"]',
  dialog: 'div[role="dialog"]',
  composer: '[data-testid="tweetTextarea_0"]',
  submitInline: 'div[role="dialog"] [data-testid="tweetButtonInline"]',
  submitButton: 'div[role="dialog"] [data-testid="tweetButton"]',
  timeLink: 'a[href*="/status/"] time',
} as const;

/**
 * Anchors to the exact post by status id rather than trusting position.
 * "If we cannot find the exact article, do not risk replying to the wrong one."
 */
export function articleForStatus(statusId: string): string {
  return `article[data-testid="tweet"]:has(a[href*="/status/${statusId}"])`;
}
