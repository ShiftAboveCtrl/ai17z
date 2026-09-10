export * from './contract';
export * from './registry';
export { mockAdapter } from './mock/index';
export { xAdapter } from './x/index';
export { observeAuthPage } from './x/auth';
export { signInWithStoredCredentials } from './x/credentialSignIn';
export { CHALLENGE_SIGNALS, SEL } from './x/selectors';
export { linksInText, upgradeImageUrl, readMediaInventory } from './x/media';
export { webSearch, readPage, extractBraveAnswer, type WebResult } from './x/websearch';
 export * as xMonitors from './x/monitors';
export { fingerprint } from './x/index';
// Exported for the composer-discipline tests: these are the steps that decide
// whether a draft is complete before anything irreversible happens.
export { readyForTyping, fillComposer, submitComposer, ensureEngaged } from './x/index';
export type { EngagementOutcome } from './x/index';
export {
  normalizeTargetId,
  extractStatusId,
  buildStatusUrl,
  normalizeHandle,
  handleFromUrl,
  looksUnavailable,
  UNAVAILABLE_MARKERS,
} from './x/targets';
export {
  resolveBranch,
  branchFromEventOnly,
  parentTextOf,
  DEFAULT_MAX_ANCESTORS,
  type ArticleSnapshot,
  type BranchInput,
  type BranchOutcome,
} from './x/conversation';
export { replyingToHandles } from './x/index';

/**
 * Reading X as a capability rather than as a pipeline step.
 *
 * These take a `ChannelContext` and return the normalised shapes in
 * `contracts/xDomain`. The runtime supplies the context and registers them as
 * capabilities; nothing about the DOM crosses this line.
 */
export { readPost, readProfile, parseCount, parseCounts, searchPosts, readThread } from './x/index';
export {
  readNotifications,
  classifyNotification,
  othersCount,
  toNotifications,
  type NotificationCell,
} from './x/index';
export { readConnections, toConnections, type UserCell } from './x/index';
export { readTimeline, toTimelinePosts } from './x/index';
export { readInbox, readConversation, toThreads, type ConversationRow } from './x/index';
export { readPostAnalytics, parseAnalytics, type PostAnalyticsReading } from './x/index';
/** The timeline row shape the harvester produces, for anything that maps it. */
export type { Seen } from './x/monitors';
