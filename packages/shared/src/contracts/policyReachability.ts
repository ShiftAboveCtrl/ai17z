import { DEFAULT_POLICY } from './policy';

/**
 * Where each policy setting can be reached from, and why when it cannot.
 *
 * A runtime-enforced setting with no way to change it is the worst kind of
 * defect: the system works exactly as designed, says so, and leaves the owner
 * with no move. It had happened twice before anybody counted -- the address
 * allowlist refused every address while the field that granted them was not
 * rendered, and the posting schedule could only be switched on from Easy Mode.
 *
 * Counting found thirty more. Of a hundred and thirteen policy leaves, thirty
 * were enforced by the runtime and reachable from no screen at all, and nine
 * were settable in Easy Mode and invisible in Advanced -- which inverts the
 * design, because Advanced is supposed to be the fuller projection.
 *
 * Every leaf is classified here, and `policyReachability.test.ts` fails when a
 * new one appears without a decision. That is the point: the classification is
 * cheap, and the thing it prevents is a setting silently becoming enforced with
 * nowhere to change it.
 *
 * EASY_AND_ADVANCED  offered in both projections
 * ADVANCED_ONLY      Advanced expresses it, Easy has no word for it
 * INTERNAL           runtime tuning; an owner has no basis to choose. Needs a reason.
 * DEPRECATED         nothing reads it. Kept for compatibility. Needs a reason.
 */
export type PolicyReach = 'EASY_AND_ADVANCED' | 'ADVANCED_ONLY' | 'INTERNAL' | 'DEPRECATED';

export interface PolicyPlacement {
  where: PolicyReach;
  /** Required for INTERNAL and DEPRECATED. */
  why?: string;
}

export const POLICY_REACHABILITY: Record<string, PolicyPlacement> = {
  'automation.dryRunDefault': { where: 'EASY_AND_ADVANCED' },
  'automation.mode': { where: 'EASY_AND_ADVANCED' },
  'budget.maxCostUsdPerDay': { where: 'EASY_AND_ADVANCED' },
  'budget.maxModelCallsPerDay': { where: 'EASY_AND_ADVANCED' },
  'budget.maxModelCallsPerJob': { where: 'ADVANCED_ONLY' },
  'budget.maxModelCallsPerMonth': { where: 'EASY_AND_ADVANCED' },
  'budget.maxResearchCallsPerEvent': { where: 'ADVANCED_ONLY' },
  'content.allowedRemoteHandles': { where: 'ADVANCED_ONLY' },
  'content.blockedRemoteHandles': { where: 'EASY_AND_ADVANCED' },
  'content.blockedTopics': { where: 'ADVANCED_ONLY' },
  'content.requireVerifiedAuthor': { where: 'ADVANCED_ONLY' },
  'content.selfHandles': { where: 'ADVANCED_ONLY' },
  'engagement.allowThreadFollowUps': { where: 'ADVANCED_ONLY' },
  'engagement.ignoreMassTags': { where: 'ADVANCED_ONLY' },
  'engagement.massTagThreshold': { where: 'INTERNAL', why: "How many tags make a post a mass tag. The switch is exposed; the number is not." },
  'engagement.maxRepliesPerPersonPerHour': { where: 'ADVANCED_ONLY' },
  'engagement.maxThreadDepth': { where: 'INTERNAL', why: "How deep a thread is followed before it stops being a conversation." },
  'engagement.minimumReplyValue': { where: 'EASY_AND_ADVANCED' },
  'engagement.strategy': { where: 'ADVANCED_ONLY' },
  'identity.disclosure': { where: 'ADVANCED_ONLY' },
  'identity.disclosureStatement': { where: 'ADVANCED_ONLY' },
  'identity.mayDenyBeingAI': { where: 'ADVANCED_ONLY' },
  'identity.representedEntity': { where: 'ADVANCED_ONLY' },
  'media.allowedLinkDomains': { where: 'ADVANCED_ONLY' },
  'media.analyzeGifs': { where: 'ADVANCED_ONLY' },
  'media.analyzeImages': { where: 'ADVANCED_ONLY' },
  'media.analyzeVideo': { where: 'ADVANCED_ONLY' },
  'media.extractImageText': { where: 'DEPRECATED', why: "OCR toggle. No consumer: vision reads text directly." },
  'media.linkPolicy': { where: 'ADVANCED_ONLY' },
  'media.maxItemsPerEvent': { where: 'INTERNAL', why: "How many attachments are read from one post." },
  'media.maxVideoFrames': { where: 'DEPRECATED', why: "Frames sampled from a video. Video analysis is not implemented." },
  'media.onVisionFailure': { where: 'ADVANCED_ONLY' },
  'media.resolveQuotedPosts': { where: 'ADVANCED_ONLY' },
  'media.retainArtifactHours': { where: 'DEPRECATED', why: "How long captured media is kept on disk." },
  'memory.retrieval.account.enabled': { where: 'EASY_AND_ADVANCED' },
  'memory.retrieval.account.limit': { where: 'EASY_AND_ADVANCED' },
  'memory.retrieval.episodic.enabled': { where: 'EASY_AND_ADVANCED' },
  'memory.retrieval.episodic.limit': { where: 'EASY_AND_ADVANCED' },
  'memory.retrieval.knowledge.enabled': { where: 'EASY_AND_ADVANCED' },
  'memory.retrieval.knowledge.limit': { where: 'EASY_AND_ADVANCED' },
  'memory.retrieval.persona.enabled': { where: 'EASY_AND_ADVANCED' },
  'memory.retrieval.persona.limit': { where: 'EASY_AND_ADVANCED' },
  'memory.retrieval.thread.enabled': { where: 'EASY_AND_ADVANCED' },
  'memory.retrieval.thread.limit': { where: 'EASY_AND_ADVANCED' },
  'memory.retrieval.totalCharBudget': { where: 'INTERNAL', why: "Prompt budget. Changing it changes what fits, not what the agent is." },
  'memory.retrieval.user.enabled': { where: 'EASY_AND_ADVANCED' },
  'memory.retrieval.user.limit': { where: 'EASY_AND_ADVANCED' },
  'memory.write.persona.enabled': { where: 'EASY_AND_ADVANCED' },
  'memory.write.thread.enabled': { where: 'EASY_AND_ADVANCED' },
  'memory.write.user.enabled': { where: 'EASY_AND_ADVANCED' },
  'memory.write.user.extractor': { where: 'DEPRECATED', why: "Which extractor writes user facts. One implementation exists." },
  'memory.write.user.minImportance': { where: 'DEPRECATED', why: "Write-policy tuning." },
  'memory.write.user.ttlDays': { where: 'DEPRECATED', why: "Write-policy tuning." },
  'output.bannedPhrases': { where: 'ADVANCED_ONLY' },
  'output.emoji.allowed': { where: 'EASY_AND_ADVANCED' },
  'output.emoji.maxPerMessage': { where: 'ADVANCED_ONLY' },
  'output.emoji.messagesPercent': { where: 'ADVANCED_ONLY' },
  'output.emoji.use': { where: 'EASY_AND_ADVANCED' },
  'output.forbidHashtags': { where: 'ADVANCED_ONLY' },
  'output.forbidLinks': { where: 'ADVANCED_ONLY' },
  'output.forbidMentionsOfOthers': { where: 'ADVANCED_ONLY' },
  'output.maxCharacters': { where: 'ADVANCED_ONLY' },
  'output.minCharacters': { where: 'ADVANCED_ONLY' },
  'output.stripSurroundingQuotes': { where: 'ADVANCED_ONLY' },
  'output.verifiedAddresses': { where: 'ADVANCED_ONLY' },
  'outreach.cooldownDaysPerAuthor': { where: 'ADVANCED_ONLY' },
  'outreach.enabled': { where: 'EASY_AND_ADVANCED' },
  'outreach.maxPerDay': { where: 'ADVANCED_ONLY' },
  'outreach.minimumValue': { where: 'ADVANCED_ONLY' },
  'outreach.mode': { where: 'EASY_AND_ADVANCED' },
  'outreach.requireTopicMatch': { where: 'ADVANCED_ONLY' },
  'rate.maxActionsPerDay': { where: 'ADVANCED_ONLY' },
  'rate.maxActionsPerHour': { where: 'ADVANCED_ONLY' },
  'rate.minSecondsBetweenActions': { where: 'ADVANCED_ONLY' },
  'rate.workingHours.enabled': { where: 'EASY_AND_ADVANCED' },
  'rate.workingHours.endHour': { where: 'ADVANCED_ONLY' },
  'rate.workingHours.startHour': { where: 'ADVANCED_ONLY' },
  'rate.workingHours.timezone': { where: 'ADVANCED_ONLY' },
  'relationships.callbacksAllowedFrom': { where: 'INTERNAL', why: "Which familiarity levels may be referred back to." },
  'relationships.mirrorHostility': { where: 'DEPRECATED', why: "Superseded by the DEFLECT rule, which is not optional." },
  'relationships.regularsGetBrevity': { where: 'DEPRECATED', why: "Relationship voice shaping. Applied from familiarity, not configured." },
  'relationships.strangerExplains': { where: 'DEPRECATED', why: "Relationship voice shaping." },
  'safety.maxAttempts': { where: 'ADVANCED_ONLY' },
  'safety.requireTargetVerification': { where: 'ADVANCED_ONLY' },
  'safety.reviewAfterAttempts': { where: 'DEPRECATED', why: "No consumer. Superseded by maxAttempts and reviewOnValidationFailure." },
  'safety.reviewOnValidationFailure': { where: 'ADVANCED_ONLY' },
  'stance.conflictThreshold': { where: 'INTERNAL', why: "Confidence at which two positions count as contradictory." },
  'stance.enabled': { where: 'EASY_AND_ADVANCED' },
  'stance.learnFromOwnPosts': { where: 'ADVANCED_ONLY' },
  'stance.onConflict': { where: 'ADVANCED_ONLY' },
  'stance.trackCommitments': { where: 'ADVANCED_ONLY' },
  'stance.trackPredictions': { where: 'ADVANCED_ONLY' },
  'support.describeOwnRuntime': { where: 'ADVANCED_ONLY' },
  'support.enabled': { where: 'EASY_AND_ADVANCED' },
  'support.subject': { where: 'ADVANCED_ONLY' },
  'tone.casual': { where: 'INTERNAL', why: "Tone mirroring weights. Derived from the persona rather than set." },
  'tone.hostility': { where: 'INTERNAL', why: "Tone mirroring weights." },
  'tone.humour': { where: 'DEPRECATED', why: "Tone mirroring weights. No consumer." },
  'tone.technical': { where: 'INTERNAL', why: "Tone mirroring weights." },
  'tools.allowed': { where: 'EASY_AND_ADVANCED' },
  'tools.capabilityLoop': { where: 'ADVANCED_ONLY' },
  'tools.research.market': { where: 'ADVANCED_ONLY' },
  'tools.research.web': { where: 'ADVANCED_ONLY' },
  'tools.research.xIntelligence': { where: 'EASY_AND_ADVANCED' },
  'voice.acceptAt': { where: 'DEPRECATED', why: "Voice scoring threshold. Tuned against the corpus, not chosen." },
  'voice.allowModelRewrite': { where: 'ADVANCED_ONLY' },
  'voice.avoid': { where: 'EASY_AND_ADVANCED' },
  'voice.avoidPhrases': { where: 'ADVANCED_ONLY' },
  'voice.enabled': { where: 'EASY_AND_ADVANCED' },
  'voice.genericRewriteAbove': { where: 'INTERNAL', why: "Generic-register threshold." },
  'voice.lightRewriteAt': { where: 'INTERNAL', why: "Voice scoring threshold." },
  'voice.repetitionRewriteAbove': { where: 'INTERNAL', why: "Repetition threshold." },
  'voice.signaturePhrases': { where: 'ADVANCED_ONLY' },
  'voice.signatureRestHours': { where: 'INTERNAL', why: "How long a signature phrase rests. Anti-repetition tuning." },
};

/** Every leaf path in a fully-defaulted policy, which is what must be classified. */
export function policyLeafPaths(value: unknown = DEFAULT_POLICY, prefix = ''): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, inner]) =>
    policyLeafPaths(inner, prefix ? `${prefix}.${key}` : key),
  );
}
