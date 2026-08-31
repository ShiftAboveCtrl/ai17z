import type {
  CadenceConfig,
  EasyAudience,
  EasyFilters,
  EasyPostFrequency,
  EasySelectivity,
  EasySetup,
  EasyStylePreset,
  EasyView,
  PersonaDraft,
  PolicyConfig,
  RadarSourceKind,
} from '@xbam/shared/contracts';
import { DEFAULT_POLICY, EasySetup as EasySetupSchema, defaultCadence } from '@xbam/shared/contracts';

/**
 * Easy Mode projected onto the real configuration, and read back off it.
 *
 * Everything here is pure. `toPersona`, `toPolicy`, and `toCadence` take an
 * Easy answer sheet and return the same documents the advanced screens edit;
 * `readEasyView` goes the other way. There is no Easy Mode storage, no Easy
 * Mode runtime path, and no setting that exists only in one of the two views.
 *
 * The projection is deliberately partial in one direction: Advanced can express
 * things Easy has no word for. When that happens `readEasyView` reports them
 * instead of flattening them, and saving from Easy leaves them untouched.
 */

// ── The numbers behind the words ─────────────────────────────────────────────

/**
 * Reply-value thresholds for the three selectivity settings.
 *
 * 35 is the platform default and the middle option. 10 answers nearly anything
 * that is not noise; 60 is roughly "there is a question here I can answer".
 * These are the only place the numbers live, so Easy and Advanced cannot drift.
 */
const SELECTIVITY_VALUE: Record<EasySelectivity, number> = {
  ALMOST_EVERYTHING: 10,
  BALANCED: 35,
  ONLY_WHEN_USEFUL: 60,
};

/**
 * How often an agent that posts of its own accord should look for something to
 * say. It posts only if the backlog has an idea worth using, so these are
 * ceilings rather than schedules — a quiet agent stays quiet.
 */
const POST_INTERVAL_SECONDS: Record<EasyPostFrequency, number> = {
  OCCASIONALLY: 6 * 3_600,
  FEW_PER_DAY: 5 * 3_600,
  DAILY: 22 * 3_600,
};

/** What each preset actually writes into the persona. */
const PRESETS: Record<
  Exclude<EasyStylePreset, 'CUSTOM'>,
  { tone: string; style: string; length: PersonaDraft['responseLength'] }
> = {
  CONCISE: {
    tone: 'Direct and unhurried. Says the thing and stops.',
    style: 'One or two sentences. No preamble, no summary of the question, no sign-off.',
    length: 'TERSE',
  },
  CASUAL: {
    tone: 'Relaxed and conversational, the way you would talk to someone you know.',
    style: 'Short sentences, contractions, no corporate register. Plain words over precise ones.',
    length: 'SHORT',
  },
  PROFESSIONAL: {
    tone: 'Measured and courteous. Confident without being emphatic.',
    style: 'Complete sentences, no slang, no exclamation marks. Answer first, qualify after.',
    length: 'SHORT',
  },
  WITTY: {
    tone: 'Dry. Amused by things without announcing that it is joking.',
    style: 'Understatement over punchlines. Never explain the joke, and never make one at the expense of the person asking.',
    length: 'TERSE',
  },
  TECHNICAL: {
    tone: 'Precise. Comfortable with detail and unwilling to round it off.',
    style: 'Name things exactly. Give the number or say there is not one. No analogies where the real mechanism fits.',
    length: 'MEDIUM',
  },
  OPINIONATED: {
    tone: 'Has a view and says it, without needing agreement.',
    style: 'Take a position in the first sentence. Give the reason in the second. Do not hedge with "it depends" unless it genuinely does.',
    length: 'SHORT',
  },
  FRIENDLY: {
    tone: 'Warm and open. Interested in the person, not only the question.',
    style: 'Answer the question, then leave a door open. No effusiveness and no emoji unless the other person used one.',
    length: 'SHORT',
  },
};

// ── Easy answers -> real configuration ───────────────────────────────────────

/** The persona an Easy Mode character describes. */
export function toPersona(setup: EasySetup, base?: Partial<PersonaDraft>): PersonaDraft {
  const easy = EasySetupSchema.parse(setup);
  const preset = easy.character.preset === 'CUSTOM' ? null : PRESETS[easy.character.preset];

  return {
    identityKind: base?.identityKind ?? 'FICTIONAL',
    displayName: easy.character.name,
    biography: easy.character.description,
    personality: easy.character.personality,
    // What the owner typed wins over the preset. The preset is a starting
    // point, and a starting point that overwrites you is not one.
    tone: easy.character.tone || preset?.tone || '',
    styleGuidelines: easy.character.speaksLike || preset?.style || '',
    styleExamples: easy.character.examples,
    topics: easy.character.caresAbout,
    languagePolicy: languageRule(easy),
    responseLength: preset?.length ?? base?.responseLength ?? 'SHORT',
    prohibitedBehaviors: base?.prohibitedBehaviors ?? [],
    customInstructions: base?.customInstructions ?? '',
    changeNote: 'Easy Mode',
  };
}

/** The persona's language instruction, from the Easy Mode answer. */
function languageRule(easy: EasySetup): string {
  if (easy.language === 'ENGLISH') return 'Always reply in English, whatever language you were written to in.';
  if (easy.language === 'CUSTOM') return easy.languageDetail.trim();
  // Empty means mirror, which is what the prompt engine already does with no
  // instruction at all.
  return '';
}

/**
 * The policy an Easy Mode answer sheet describes.
 *
 * Everything not named in Easy Mode is carried through from `base` untouched.
 * That is what makes it safe to open Easy Mode on an agent somebody configured
 * in detail: it edits eleven fields and leaves the rest exactly as they were.
 */
export function toPolicy(setup: EasySetup, base: PolicyConfig = DEFAULT_POLICY): PolicyConfig {
  const easy = EasySetupSchema.parse(setup);
  const { audience, selectivity, filters, allowlist } = easy.replies;

  return {
    ...base,
    automation: {
      ...base.automation,
      mode: easy.operation === 'AUTOMATIC' ? 'AUTONOMOUS' : 'REVIEW_BEFORE_ACTION',
      // Review means a person approves a real action, not that the action is
      // pretended. Dry run is a separate, deliberate thing.
      dryRunDefault: false,
    },
    output: {
      ...base.output,
      // Enforced on the finished text, not merely asked for in the prompt.
      emoji: {
        use: easy.emoji.use,
        allowed: easy.emoji.allowed,
        maxPerMessage: easy.emoji.maxPerMessage,
        messagesPercent: easy.emoji.messagesPercent,
      },
    },
    content: {
      ...base.content,
      allowedRemoteHandles: audience === 'ALLOWLIST' ? allowlist : [],
      requireVerifiedAuthor: audience === 'VERIFIED_ONLY' || filters.verifiedOnly,
    },
    engagement: {
      ...base.engagement,
      strategy: audience === 'EVERYONE' ? 'ALWAYS_REPLY' : 'SELECTIVE',
      // "Everyone" means everyone, so nothing is scored out.
      minimumReplyValue: audience === 'EVERYONE' ? 0 : SELECTIVITY_VALUE[selectivity],
      ignoreMassTags: audience === 'EVERYONE' ? false : filters.massTags,
      maxRepliesPerPersonPerHour: filters.repetition ? 3 : 50,
      allowThreadFollowUps: filters.repliesInConversations,
    },
  };
}

/** The account cadence an Easy Mode answer sheet describes. */
export function toCadence(setup: EasySetup, base: CadenceConfig = defaultCadence()): CadenceConfig {
  const easy = EasySetupSchema.parse(setup);
  return {
    ...base,
    polling: {
      ...base.polling,
      // An agent that only replies still has to read; posting changes what it
      // does with a quiet timeline, not whether it looks.
      enabled: true,
    },
  };
}

/** How often to look for something worth posting, or null when it does not. */
export function postIntervalSeconds(setup: EasySetup): number | null {
  const easy = EasySetupSchema.parse(setup);
  return easy.posting.enabled ? POST_INTERVAL_SECONDS[easy.posting.frequency] : null;
}

/**
 * Which radar sources an Easy Mode answer sheet turns on.
 *
 * Notifications and mention search are always both on: they miss different
 * things, and one of them alone is the single point of failure the radar exists
 * to remove. Easy Mode users get that without being asked about it.
 */
export function toRadarSourceKinds(setup: EasySetup): RadarSourceKind[] {
  const easy = EasySetupSchema.parse(setup);
  const kinds: RadarSourceKind[] = ['notifications', 'mention_search'];
  if (!easy.replies.filters.directMentionsOnly) kinds.push('reply_search');
  if (easy.replies.filters.repliesToOwnPosts) kinds.push('own_threads');
  return kinds;
}

// ── Real configuration -> Easy answers ───────────────────────────────────────

function audienceOf(policy: PolicyConfig): EasyAudience {
  if (policy.content.allowedRemoteHandles.length > 0) return 'ALLOWLIST';
  if (policy.content.requireVerifiedAuthor) return 'VERIFIED_ONLY';
  if (policy.engagement.strategy === 'ALWAYS_REPLY' && policy.engagement.minimumReplyValue === 0) {
    return 'EVERYONE';
  }
  return 'EXCEPT_SPAM';
}

function selectivityOf(policy: PolicyConfig): EasySelectivity {
  const value = policy.engagement.minimumReplyValue;
  // Nearest of the three, so a hand-tuned 40 reads as "balanced" rather than as
  // something Easy Mode cannot show. The difference is reported separately.
  let closest: EasySelectivity = 'BALANCED';
  let distance = Infinity;
  for (const [key, threshold] of Object.entries(SELECTIVITY_VALUE) as [EasySelectivity, number][]) {
    const d = Math.abs(threshold - value);
    if (d < distance) {
      distance = d;
      closest = key;
    }
  }
  return closest;
}

function presetOf(persona: Pick<PersonaDraft, 'tone' | 'styleGuidelines'>): EasyStylePreset {
  for (const [name, preset] of Object.entries(PRESETS) as [Exclude<EasyStylePreset, 'CUSTOM'>, (typeof PRESETS)[keyof typeof PRESETS]][]) {
    if (persona.tone === preset.tone && persona.styleGuidelines === preset.style) return name;
  }
  return 'CUSTOM';
}

export interface EasyViewInput {
  persona: Pick<
    PersonaDraft,
    | 'displayName'
    | 'biography'
    | 'personality'
    | 'tone'
    | 'styleGuidelines'
    | 'styleExamples'
    | 'topics'
    | 'responseLength'
    | 'languagePolicy'
    | 'customInstructions'
    | 'prohibitedBehaviors'
  >;
  policy: PolicyConfig;
  postIntervalSeconds: number | null;
  radarSourceKinds: RadarSourceKind[];
}

/**
 * What Easy Mode makes of an agent as it is actually configured.
 *
 * Reports rather than rewrites. An agent with a fallback model chain, a custom
 * quiet-hours window, or a hand-set reply threshold still opens in Easy Mode —
 * it just says which of those Easy Mode is not showing, so nobody edits four
 * fields and silently loses a fifth.
 */
export function readEasyView(input: EasyViewInput): EasyView {
  const { persona, policy } = input;
  const audience = audienceOf(policy);

  const frequency = ((): EasyPostFrequency => {
    const seconds = input.postIntervalSeconds;
    if (seconds === null) return 'OCCASIONALLY';
    let closest: EasyPostFrequency = 'OCCASIONALLY';
    let distance = Infinity;
    for (const [key, value] of Object.entries(POST_INTERVAL_SECONDS) as [EasyPostFrequency, number][]) {
      const d = Math.abs(value - seconds);
      if (d < distance) {
        distance = d;
        closest = key;
      }
    }
    return closest;
  })();

  const filters: EasyFilters = {
    spam: true,
    massTags: policy.engagement.ignoreMassTags,
    repetition: policy.engagement.maxRepliesPerPersonPerHour <= 10,
    blocked: policy.content.blockedRemoteHandles.length >= 0,
    verifiedOnly: policy.content.requireVerifiedAuthor,
    directMentionsOnly: !input.radarSourceKinds.includes('reply_search'),
    repliesToOwnPosts: input.radarSourceKinds.includes('own_threads'),
    repliesInConversations: policy.engagement.allowThreadFollowUps,
  };

  const setup: EasySetup = {
    character: {
      name: persona.displayName,
      description: persona.biography.slice(0, 500),
      personality: persona.personality,
      tone: persona.tone,
      caresAbout: persona.topics,
      speaksLike: persona.styleGuidelines,
      examples: persona.styleExamples.slice(0, 50),
      preset: presetOf(persona),
    },
    replies: {
      audience,
      selectivity: selectivityOf(policy),
      filters,
      allowlist: policy.content.allowedRemoteHandles,
    },
    language: persona.languagePolicy
      ? /always reply in english/i.test(persona.languagePolicy)
        ? ('ENGLISH' as const)
        : ('CUSTOM' as const)
      : ('MIRROR' as const),
    languageDetail: /always reply in english/i.test(persona.languagePolicy ?? '') ? '' : (persona.languagePolicy ?? ''),
    emoji: {
      use: policy.output.emoji.use,
      allowed: policy.output.emoji.allowed,
      maxPerMessage: policy.output.emoji.maxPerMessage,
      messagesPercent: policy.output.emoji.messagesPercent,
    },
    posting: { enabled: input.postIntervalSeconds !== null, frequency },
    operation: policy.automation.mode === 'AUTONOMOUS' ? 'AUTOMATIC' : 'REVIEW_FIRST',
  };

  // What Advanced has set that Easy Mode has no word for. Each entry is a
  // sentence, because a field name tells nobody what they would be losing.
  const beyond: string[] = [];

  if (!['AUTONOMOUS', 'REVIEW_BEFORE_ACTION'].includes(policy.automation.mode)) {
    beyond.push(
      `Operation is set to ${policy.automation.mode.toLowerCase().replace(/_/g, ' ')}, which Easy Mode does not offer. Saving here would change it to review first.`,
    );
  }
  if (policy.automation.dryRunDefault) {
    beyond.push('Dry run is on, so nothing is actually sent. Easy Mode does not show this.');
  }
  if (policy.engagement.minimumReplyValue !== SELECTIVITY_VALUE[setup.replies.selectivity]) {
    beyond.push(
      `The reply threshold is set to ${policy.engagement.minimumReplyValue}, between Easy Mode's three settings. The nearest is shown.`,
    );
  }
  if (policy.content.blockedRemoteHandles.length > 0) {
    beyond.push(`${policy.content.blockedRemoteHandles.length} handle(s) are blocked. Easy Mode does not edit the block list.`);
  }
  if (policy.rate.workingHours.enabled) {
    beyond.push('Working hours are set. Easy Mode does not show them and will not change them.');
  }
  if (persona.customInstructions) beyond.push('Custom instructions are set on the persona.');
  if (persona.prohibitedBehaviors.length > 0) {
    beyond.push(`${persona.prohibitedBehaviors.length} prohibited behaviour(s) are set on the persona.`);
  }
  if (policy.output.bannedPhrases.length > 0) {
    beyond.push(`${policy.output.bannedPhrases.length} banned phrase(s) are set.`);
  }
  if (policy.tools.allowed.length > 0) beyond.push(`${policy.tools.allowed.length} tool(s) are enabled.`);
  if (persona.styleExamples.length > 50) {
    beyond.push(`${persona.styleExamples.length} style examples exist; Easy Mode shows the first 50.`);
  }
  if (persona.biography.length > 500) {
    beyond.push('The biography is longer than the short description Easy Mode edits.');
  }

  return { setup, exact: beyond.length === 0, beyondEasyMode: beyond };
}
