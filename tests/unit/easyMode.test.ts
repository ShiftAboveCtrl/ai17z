import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, EasySetup, type PolicyConfig } from '@xbam/shared/contracts';
import { postIntervalSeconds, readEasyView, toCadence, toPersona, toPolicy, toRadarSourceKinds } from '@xbam/runtime';

/**
 * Easy Mode is a view, not a second configuration system.
 *
 * These tests exist to keep that true. The risk with a simplified interface is
 * that it quietly becomes its own thing: its own storage, its own defaults, its
 * own behaviour, and two agents that look identical on screen behaving
 * differently at run time. So the properties asserted here are:
 *
 *   - Easy answers project onto the real persona and policy documents
 *   - reading those documents back gives the same Easy answers
 *   - settings Easy Mode has no word for are reported, never flattened
 *   - Easy Mode never turns off an intelligence feature to be simple
 */

const character = {
  name: 'Atlas',
  description: 'Watches protocol governance and says what changed.',
  personality: 'Sceptical, patient, allergic to hype.',
  tone: '',
  caresAbout: ['governance', 'token distribution'],
  speaksLike: '',
  examples: ['Distribution changed. The vote did not.'],
  preset: 'CONCISE' as const,
};

const setup = EasySetup.parse({
  character,
  replies: { audience: 'EXCEPT_SPAM', selectivity: 'BALANCED' },
  posting: { enabled: true, frequency: 'FEW_PER_DAY' },
  operation: 'AUTOMATIC',
});

describe('Easy answers become real configuration', () => {
  it('writes the character into an ordinary persona', () => {
    const persona = toPersona(setup);
    expect(persona.displayName).toBe('Atlas');
    expect(persona.topics).toEqual(['governance', 'token distribution']);
    expect(persona.styleExamples).toEqual(['Distribution changed. The vote did not.']);
    // The preset supplied a tone because the owner left it blank.
    expect(persona.tone).toContain('Direct');
    expect(persona.responseLength).toBe('TERSE');
  });

  it('lets what the owner typed beat the preset', () => {
    const persona = toPersona({ ...setup, character: { ...character, tone: 'Warm and a bit chaotic.' } });
    expect(persona.tone).toBe('Warm and a bit chaotic.');
  });

  it('maps automatic operation onto the real automation mode', () => {
    expect(toPolicy(setup).automation.mode).toBe('AUTONOMOUS');
    expect(toPolicy({ ...setup, operation: 'REVIEW_FIRST' }).automation.mode).toBe('REVIEW_BEFORE_ACTION');
  });

  it('does not confuse "wait for approval" with "pretend to act"', () => {
    // Review means a person approves a real action. Dry run is a different,
    // deliberate thing and Easy Mode must never switch it on by accident.
    expect(toPolicy({ ...setup, operation: 'REVIEW_FIRST' }).automation.dryRunDefault).toBe(false);
  });

  it('turns the audience into engagement policy rather than a new mechanism', () => {
    const everyone = toPolicy({ ...setup, replies: { ...setup.replies, audience: 'EVERYONE' } });
    expect(everyone.engagement.strategy).toBe('ALWAYS_REPLY');
    expect(everyone.engagement.minimumReplyValue).toBe(0);
    expect(everyone.engagement.ignoreMassTags).toBe(false);

    const selective = toPolicy(setup);
    expect(selective.engagement.strategy).toBe('SELECTIVE');
    expect(selective.engagement.minimumReplyValue).toBe(35);
  });

  it('puts an allowlist where the policy gate already looks for one', () => {
    const policy = toPolicy({
      ...setup,
      replies: { ...setup.replies, audience: 'ALLOWLIST', allowlist: ['alice', 'bob'] },
    });
    expect(policy.content.allowedRemoteHandles).toEqual(['alice', 'bob']);
  });

  it('clears the allowlist when the audience is not an allowlist', () => {
    // Otherwise switching from Allowlist to Everyone would leave the gate
    // silently still enforcing it.
    const base: PolicyConfig = { ...DEFAULT_POLICY, content: { ...DEFAULT_POLICY.content, allowedRemoteHandles: ['alice'] } };
    expect(toPolicy(setup, base).content.allowedRemoteHandles).toEqual([]);
  });

  it('makes "verified accounts only" a rule the gate enforces', () => {
    // This is the one Easy Mode control that would otherwise be decoration: the
    // audience has to land on a policy field somebody actually reads.
    const policy = toPolicy({ ...setup, replies: { ...setup.replies, audience: 'VERIFIED_ONLY' } });
    expect(policy.content.requireVerifiedAuthor).toBe(true);
    expect(toPolicy(setup).content.requireVerifiedAuthor).toBe(false);
  });

  it('reads the verified rule back as the verified audience', () => {
    const policy = toPolicy({ ...setup, replies: { ...setup.replies, audience: 'VERIFIED_ONLY' } });
    const view = readEasyView({
      persona: toPersona(setup),
      policy,
      postIntervalSeconds: null,
      radarSourceKinds: toRadarSourceKinds(setup),
    });
    expect(view.setup.replies.audience).toBe('VERIFIED_ONLY');
    expect(view.setup.replies.filters.verifiedOnly).toBe(true);
  });

  it('makes the emoji answer a rule the validator enforces', () => {
    const none = toPolicy({ ...setup, emoji: { use: 'NONE', allowed: [], maxPerMessage: 1, messagesPercent: 25 } });
    expect(none.output.emoji.use).toBe('NONE');

    const picked = toPolicy({
      ...setup,
      emoji: { use: 'SELECTED', allowed: ['🔥'], maxPerMessage: 2, messagesPercent: 50 },
    });
    expect(picked.output.emoji.allowed).toEqual(['🔥']);
    expect(picked.output.emoji.maxPerMessage).toBe(2);
    expect(picked.output.emoji.messagesPercent).toBe(50);
  });

  it('reads the emoji rule back unchanged', () => {
    const answers = { use: 'SELECTED' as const, allowed: ['🔥'], maxPerMessage: 2, messagesPercent: 50 };
    const policy = toPolicy({ ...setup, emoji: answers });
    const view = readEasyView({
      persona: toPersona(setup),
      policy,
      postIntervalSeconds: null,
      radarSourceKinds: toRadarSourceKinds(setup),
    });
    expect(view.setup.emoji).toEqual(answers);
  });

  it('turns posting frequency into an interval, and off into nothing', () => {
    expect(postIntervalSeconds(setup)).toBe(5 * 3_600);
    expect(postIntervalSeconds({ ...setup, posting: { enabled: false, frequency: 'DAILY' } })).toBeNull();
  });

  it('always runs both discovery surfaces', () => {
    // Notifications and mention search miss different things. An Easy Mode user
    // gets both without being asked, because one alone is the single point of
    // failure the radar exists to remove.
    const kinds = toRadarSourceKinds(setup);
    expect(kinds).toContain('notifications');
    expect(kinds).toContain('mention_search');
  });

  it('drops reply search when only direct mentions are wanted', () => {
    const kinds = toRadarSourceKinds({
      ...setup,
      replies: { ...setup.replies, filters: { ...setup.replies.filters, directMentionsOnly: true } },
    });
    expect(kinds).not.toContain('reply_search');
    expect(kinds).toContain('notifications');
  });
});

describe('Easy Mode leaves advanced settings alone', () => {
  it('carries through every policy field it does not name', () => {
    const advanced: PolicyConfig = {
      ...DEFAULT_POLICY,
      identity: { ...DEFAULT_POLICY.identity, disclosure: 'ALWAYS', representedEntity: 'Acme' },
      output: { ...DEFAULT_POLICY.output, maxCharacters: 180, bannedPhrases: ['as an AI'] },
      rate: { ...DEFAULT_POLICY.rate, maxActionsPerHour: 4 },
      tools: { allowed: ['web.search'] },
    };
    const result = toPolicy(setup, advanced);

    expect(result.identity).toEqual(advanced.identity);
    expect(result.output).toEqual(advanced.output);
    expect(result.rate).toEqual(advanced.rate);
    expect(result.tools).toEqual(advanced.tools);
    expect(result.memory).toEqual(advanced.memory);
    expect(result.voice).toEqual(advanced.voice);
    expect(result.stance).toEqual(advanced.stance);
    expect(result.media).toEqual(advanced.media);
    expect(result.relationships).toEqual(advanced.relationships);
  });

  it('does not weaken the agent to make the interface simple', () => {
    // The point of Easy Mode is simpler configuration, not a lesser agent. Every
    // one of these is on by default and Easy Mode must not turn any of it off.
    const policy = toPolicy(setup);
    expect(policy.memory.retrieval.thread.enabled).toBe(true);
    expect(policy.memory.retrieval.user.enabled).toBe(true);
    expect(policy.media.resolveQuotedPosts).toBe(true);
    expect(policy.safety.requireTargetVerification).toBe(true);
    expect(policy.voice).toEqual(DEFAULT_POLICY.voice);
    expect(policy.stance).toEqual(DEFAULT_POLICY.stance);
    expect(policy.relationships).toEqual(DEFAULT_POLICY.relationships);
    expect(toCadence(setup).polling.enabled).toBe(true);
  });
});

describe('reading an agent back into Easy Mode', () => {
  const view = (overrides: { policy?: PolicyConfig; postSeconds?: number | null } = {}) =>
    readEasyView({
      persona: toPersona(setup),
      policy: overrides.policy ?? toPolicy(setup),
      postIntervalSeconds: overrides.postSeconds === undefined ? postIntervalSeconds(setup) : overrides.postSeconds,
      radarSourceKinds: toRadarSourceKinds(setup),
    });

  it('round-trips: configure in Easy, read back the same answers', () => {
    const result = view();
    expect(result.exact).toBe(true);
    expect(result.beyondEasyMode).toEqual([]);
    expect(result.setup.character.name).toBe('Atlas');
    expect(result.setup.character.preset).toBe('CONCISE');
    expect(result.setup.character.caresAbout).toEqual(['governance', 'token distribution']);
    expect(result.setup.replies.audience).toBe('EXCEPT_SPAM');
    expect(result.setup.replies.selectivity).toBe('BALANCED');
    expect(result.setup.operation).toBe('AUTOMATIC');
    expect(result.setup.posting).toEqual({ enabled: true, frequency: 'FEW_PER_DAY' });
  });

  it('round-trips through the projection a second time unchanged', () => {
    // Easy -> config -> Easy -> config must be a fixed point. Without this, a
    // user who opens the setup screen and presses save changes their agent.
    const once = toPolicy(setup);
    const back = readEasyView({
      persona: toPersona(setup),
      policy: once,
      postIntervalSeconds: postIntervalSeconds(setup),
      radarSourceKinds: toRadarSourceKinds(setup),
    });
    expect(toPolicy(back.setup, once)).toEqual(once);
    expect(toPersona(back.setup)).toEqual(toPersona(setup));
  });

  it('reports a mode Easy Mode cannot offer instead of hiding it', () => {
    const monitoring: PolicyConfig = {
      ...DEFAULT_POLICY,
      automation: { mode: 'MONITOR_ONLY', dryRunDefault: false },
    };
    const result = view({ policy: monitoring });
    expect(result.exact).toBe(false);
    expect(result.beyondEasyMode.join(' ')).toContain('monitor only');
    // And it says what saving would do, rather than doing it silently.
    expect(result.beyondEasyMode.join(' ')).toContain('review first');
  });

  it('reports a hand-tuned threshold and shows the nearest setting', () => {
    const tuned: PolicyConfig = {
      ...DEFAULT_POLICY,
      engagement: { ...DEFAULT_POLICY.engagement, minimumReplyValue: 44 },
    };
    const result = view({ policy: tuned });
    expect(result.setup.replies.selectivity).toBe('BALANCED');
    expect(result.exact).toBe(false);
    expect(result.beyondEasyMode.join(' ')).toContain('44');
  });

  it('reports dry run, which would otherwise look like a working agent', () => {
    const dry: PolicyConfig = { ...DEFAULT_POLICY, automation: { mode: 'AUTONOMOUS', dryRunDefault: true } };
    const result = view({ policy: dry });
    expect(result.beyondEasyMode.join(' ')).toContain('nothing is actually sent');
  });

  it('reports blocked handles, banned phrases, tools, and working hours', () => {
    const advanced: PolicyConfig = {
      ...DEFAULT_POLICY,
      content: { ...DEFAULT_POLICY.content, blockedRemoteHandles: ['spammer'] },
      output: { ...DEFAULT_POLICY.output, bannedPhrases: ['as an AI'] },
      tools: { allowed: ['web.search'] },
      rate: { ...DEFAULT_POLICY.rate, workingHours: { enabled: true, timezone: 'UTC', startHour: 9, endHour: 17 } },
    };
    const notes = view({ policy: advanced }).beyondEasyMode.join(' ');
    expect(notes).toContain('blocked');
    expect(notes).toContain('banned phrase');
    expect(notes).toContain('tool');
    expect(notes).toContain('Working hours');
  });

  it('calls a hand-written voice CUSTOM rather than claiming a preset', () => {
    const result = readEasyView({
      persona: { ...toPersona(setup), tone: 'Something nobody offered.', styleGuidelines: 'Nor this.' },
      policy: toPolicy(setup),
      postIntervalSeconds: null,
      radarSourceKinds: toRadarSourceKinds(setup),
    });
    expect(result.setup.character.preset).toBe('CUSTOM');
  });

  it('reports persona settings Easy Mode does not edit', () => {
    const result = readEasyView({
      persona: {
        ...toPersona(setup),
        languagePolicy: 'Always reply in Japanese.',
        customInstructions: 'Never mention the roadmap.',
        prohibitedBehaviors: ['Never give price predictions'],
      },
      policy: toPolicy(setup),
      postIntervalSeconds: null,
      radarSourceKinds: toRadarSourceKinds(setup),
    });
    const notes = result.beyondEasyMode.join(' ');
    expect(notes).toContain('Japanese');
    expect(notes).toContain('Custom instructions');
    expect(notes).toContain('prohibited behaviour');
  });
});
