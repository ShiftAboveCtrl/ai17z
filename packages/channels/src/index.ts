export * from './contract';
export { farcasterAdapter } from './farcaster/index';
export { CastReference as FarcasterCastReference } from './farcaster/client';
export * as farcasterReads from './farcaster/reads';
export * from './registry';
export { mockAdapter } from './mock/index';
export { xAdapter } from './x/index';
export { telegramAdapter, inspectBot as inspectTelegramBot, readChat as readTelegramChat, describeChat as describeTelegramChat } from './telegram/index';
export { eventOf as telegramEventOf, addressing as telegramAddressing } from './telegram/normalise';
// Bluesky, over the AT Protocol's HTTP API. The reads are a namespace because
// readPost, readThread and readProfile are already X's names above.
export { blueskyAdapter } from './bluesky/index';
export * as blueskyReads from './bluesky/reads';
export {
  UNSAFE_DEV_ORIGIN_ENV as BLUESKY_UNSAFE_DEV_ORIGIN_ENV,
  DEFAULT_SERVICE_URL as BLUESKY_DEFAULT_SERVICE_URL,
  serviceTargetFor as blueskyServiceTargetFor,
  forgetBlueskySession,
  resetBlueskySessionsForTest,
  cachedSessionFor as cachedBlueskySession,
} from './bluesky/client';
export {
  notificationToEvent as blueskyNotificationToEvent,
  parseNotifications as parseBlueskyNotifications,
  branchFromThread as blueskyBranchFromThread,
  eventTypeForReason as blueskyEventTypeForReason,
} from './bluesky/normalise';
export {
  notificationsSeenThrough as blueskyNotificationsSeenThrough,
  notificationsResume as blueskyNotificationsResume,
  sessionGenerationOf as blueskySessionGenerationOf,
  notificationsVersionOf as blueskyNotificationsVersionOf,
  WATERMARK_KEY as BLUESKY_WATERMARK_KEY,
  RESUME_KEY as BLUESKY_RESUME_KEY,
  SESSION_GENERATION_KEY as BLUESKY_SESSION_GENERATION_KEY,
  VERSION_KEY as BLUESKY_VERSION_KEY,
} from './bluesky/watermark';
export { inventoryOf as blueskyInventoryOf } from './bluesky/normalise';
export {
  parsePostReference as parseBlueskyPostReference,
  parseAtUri,
  postPermalink as blueskyPermalink,
  isPostUri as isBlueskyPostUri,
} from './bluesky/uri';
export {
  detectSpans as detectBlueskySpans,
  buildFacets as buildBlueskyFacets,
  graphemeCount,
  lengthProblem as blueskyLengthProblem,
  MAX_POST_GRAPHEMES as BLUESKY_MAX_POST_GRAPHEMES,
} from './bluesky/text';
export { observeAuthPage } from './x/auth';
export { signInWithStoredCredentials } from './x/credentialSignIn';
export { CHALLENGE_SIGNALS, SEL } from './x/selectors';
// The canonical way AI17Z reads X. One layer, several backends, and nothing
// downstream knows which one answered -- see x/intelligence/contract.ts.
export * as xIntelligenceReads from './x/intelligence/index';
export {
  xIntelligence,
  DEFAULT_BUDGET,
  FRESHNESS_SECONDS,
  STOP_ASKING,
  WORTH_ANOTHER_BACKEND,
  X_READ_OUTCOMES,
  emptyResult,
  provenanceFor,
  pageDomBackend,
  pageGraphqlBackend,
  // The parsing of X's own payloads. Pure, and where its shape bites.
  tweetsFrom,
  isByRequestedUser,
  toUser,
  toPost,
  nextCursor,
  classifyDetailed,
  findUserResult,
  ancestorChain,
  forgetXReads,
  emptyTimelineDetail,
  emptyTimelineIsReal,
} from './x/intelligence/index';
export type {
  XId,
  XUser,
  XPostRecord,
  XReadResult,
  XReadOutcome,
  XProvenance,
  XIntelligenceBackend,
  XIntelligenceHealth,
  XCapability,
} from './x/intelligence/index';
export {
  PERSONA_MINIMUM_POSTS,
  PERSONA_TARGET_POSTS,
  authoredBy,
  collectPersonaCorpus,
  normaliseHandle,
  profileOfUrl,
  readTimelineState,
  type AuthoredPost,
  type CorpusOutcome,
  type PersonaCorpus,
} from './x/personaCorpus';
export { linksInText, upgradeImageUrl, readMediaInventory } from './x/media';
export { webSearch, readPage, extractBraveAnswer, type WebResult } from './x/websearch';
// The Research Fabric's X half: what a post URL is, which hosts are one mirror,
// and what a bot check looks like. See x/researchSources.ts.
export {
  canonicalWebUrl,
  canonicalXStatusUrl,
  collectIndexedMirror,
  indexedMirrorStatus,
  mirrorStatusLinks,
  isChallengePage,
  MIRROR_PROFILE_URLS,
  observationFromSearchResult,
  observationFromXPost,
  observationsFromMirrorArticles,
  readMirrorPage,
  sourceFamilyOfUrl,
  xPostKey,
  xProfileKey,
  xStatusRefOf,
  type IndexedMirrorAnswer,
  type IndexedMirrorStatus,
  type MirrorArticle,
  type MirrorFamily,
  type MirrorPageRead,
  type XStatusRef,
} from './x/researchSources';
// How a canonical read becomes the shapes that cross this package's boundary,
// and the decision about when the rendered page may be tried instead. Exported
// because both are pure and both are where evidence is either kept or lost.
export { asXPost, asXProfile, canonical as canonicalOrPage } from './x/read';
 export * as xMonitors from './x/monitors';
// How a canonical read becomes a radar candidate. Exported so the translation
// can be tested without a browser: it is where the author id and the engagement
// counts either survive the trip downstream or quietly do not.
export {
  pollViaIntelligence,
  toCandidates,
  // Whether a refusal ends the poll or the rendered page is tried instead.
  fromReadResult as radarPollResultFrom,
  // Records a session X has stopped accepting, from the polling path.
  noteSignedOut,
  type RadarReadContext,
} from './x/radarIntelligence';
export { fingerprint } from './x/index';
// Exported for the composer-discipline tests: these are the steps that decide
// whether a draft is complete before anything irreversible happens.
export { readyForTyping, fillComposer, typingBudgetMs, typeIntoEditor, submitComposer, attachMedia, mediaSeenOnPost, ensureEngaged } from './x/index';
export type { EngagementOutcome } from './x/index';
export {
  normalizeTargetId,
  extractStatusId,
  buildStatusUrl,
  normalizeHandle,
  handleFromUrl,
  looksUnavailable,
  looksLikeXBroke,
  looksLikeXSaidEmpty,
  looksLikeXStalled,
  postedAtFromStatusId,
  UNAVAILABLE_MARKERS,
  RETRYABLE_MARKERS,
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
export { readTimeline, toTimelinePosts, timelineUrl } from './x/index';
export { readInbox, readConversation, toThreads, type ConversationRow } from './x/index';
export { readPostAnalytics, parseAnalytics, type PostAnalyticsReading } from './x/index';
/** The timeline row shape the harvester produces, for anything that maps it. */
export type { Seen } from './x/monitors';
