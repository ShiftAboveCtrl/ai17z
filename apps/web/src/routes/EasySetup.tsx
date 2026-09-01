import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Check, Sparkles } from 'lucide-react';
import { EASY_STYLE_PRESETS } from '@xbam/shared/contracts';
import type { EasySetup as EasySetupType, EasyAudience, EasyStylePreset } from '@xbam/shared/contracts';
import { ApiError, post, put } from '@app/lib/api';
import { usePolling, useResource } from '@app/lib/hooks';
import type { AccountRow, ProviderCredential } from '@app/lib/types';
import { AgentGlyph } from '@app/components/AgentGlyph';
import { AnimatedText, FadeIn } from '@app/components/motion';
import { SignInProgress } from '@app/components/SignInProgress';
import { ErrorPanel, Field, Spinner, StatusDot, Toggle } from '@app/components/ui';
import { CharacterBuilder, CompletenessBar, type CharacterDraft } from '@app/components/CharacterBuilder';

/**
 * Making one agent, in the fewest decisions that still produce a real one.
 *
 * The old flow asked eight screens of configuration before anything existed.
 * This asks who the agent is, which account it speaks through, which model is
 * behind it, who it answers, and whether it posts — and every answer writes to
 * the same versioned persona and policy the advanced screens edit. Nothing here
 * is a simplified copy of the runtime; it is a smaller vocabulary over it.
 *
 * The agent record is created after the first step rather than at the end,
 * because connecting an X account needs something to connect it to, and because
 * a wizard that loses everything if you close it is a wizard people distrust.
 */

// Connect AI sits before Character deliberately. Describing a character is the
// step that can hand the questions to the agent's own model and let it fill
// them in, and there is no model to ask until this step is done.
const STEPS = ['Agent', 'Connect X', 'Connect AI', 'Character', 'Replies', 'Posts', 'Operation', 'Review'] as const;


const AUDIENCE_OPTIONS: { value: EasyAudience; label: string; detail: string }[] = [
  { value: 'EVERYONE', label: 'Everyone', detail: 'Anything that mentions or replies to it gets an answer.' },
  {
    value: 'EXCEPT_SPAM',
    label: 'Everyone except spam and noise',
    detail: 'The usual choice. Skips mass tags and posts not really addressed to anybody.',
  },
  { value: 'VERIFIED_ONLY', label: 'Verified accounts only', detail: 'Only accounts X has verified.' },
  { value: 'ALLOWLIST', label: 'Only people I choose', detail: 'Nobody else gets a reply.' },
];

const PROVIDERS: { kind: ProviderCredential['provider']; label: string; needsKey: boolean; hint: string }[] = [
  { kind: 'openrouter', label: 'OpenRouter', needsKey: true, hint: 'One key, most models.' },
  { kind: 'openai', label: 'OpenAI', needsKey: true, hint: '' },
  { kind: 'anthropic', label: 'Claude', needsKey: true, hint: '' },
  { kind: 'deepseek', label: 'DeepSeek', needsKey: true, hint: '' },
  { kind: 'ollama', label: 'Ollama', needsKey: false, hint: 'Runs on this machine. No key needed.' },
];

interface Draft {
  name: string;
  avatarUrl: string;
  handle: string;
  setup: EasySetupType;
  providerKind: ProviderCredential['provider'];
  apiKey: string;
  baseUrl: string;
  model: string;
  examplesText: string;
  caresText: string;
  allowlistText: string;
  avoidsText: string;
}

const EMPTY: Draft = {
  name: '',
  avatarUrl: '',
  handle: '',
  setup: {
    character: {
      name: '',
      description: '',
      personality: '',
      tone: '',
      caresAbout: [],
      speaksLike: '',
      examples: [],
      preset: 'CONCISE',
    },
    replies: {
      audience: 'EXCEPT_SPAM',
      selectivity: 'BALANCED',
      filters: {
        spam: true,
        massTags: true,
        repetition: true,
        blocked: true,
        verifiedOnly: false,
        directMentionsOnly: false,
        repliesToOwnPosts: true,
        repliesInConversations: true,
      },
      allowlist: [],
    },
    emoji: { use: 'MINIMAL', allowed: [], maxPerMessage: 1, messagesPercent: 25 },
    language: 'MIRROR',
    languageDetail: '',
    posting: { enabled: false, frequency: 'OCCASIONALLY' },
    operation: 'REVIEW_FIRST',
  },
  providerKind: 'openrouter',
  apiKey: '',
  baseUrl: '',
  model: '',
  examplesText: '',
  caresText: '',
  allowlistText: '',
  avoidsText: '',
};

function list(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function EasySetup() {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [providerId, setProviderId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blockers, setBlockers] = useState<{ what: string; fix: string }[]>([]);
  const [draftCompleteness, setDraftCompleteness] = useState<CharacterDraft['completeness'] | null>(null);

  const providers = useResource<{ items: ProviderCredential[] }>('/api/providers');

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const setSetup = (patch: Partial<EasySetupType>) => setDraft((d) => ({ ...d, setup: { ...d.setup, ...patch } }));

  const providerSpec = PROVIDERS.find((p) => p.kind === draft.providerKind) ?? PROVIDERS[0]!;

  /**
   * Folds a built character into the wizard's own fields.
   *
   * Deliberately not saved here: it becomes the contents of the form, so
   * whoever built it reads and edits it before it is anybody's agent.
   */
  const applyDraft = (built: CharacterDraft) => {
    setDraftCompleteness(built.completeness);
    setDraft((d) => ({
      ...d,
      name: built.answers.name.trim() || d.name,
      caresText: built.answers.caresAbout.join(', '),
      examplesText: built.answers.examples.join('\n'),
      avoidsText: built.answers.avoids.join('\n'),
      setup: {
        ...d.setup,
        character: {
          ...d.setup.character,
          description: built.answers.description,
          personality: built.answers.personality,
          tone: built.answers.tone,
          speaksLike: built.answers.speaksLike,
          // Hand-written or model-written, it is no longer one of the presets.
          preset: 'CUSTOM',
        },
      },
    }));
  };

  /** Everything the wizard has collected, in the shape the API stores. */
  const currentSetup = (): EasySetupType => ({
    ...draft.setup,
    character: {
      ...draft.setup.character,
      name: draft.name.trim(),
      caresAbout: list(draft.caresText),
      examples: list(draft.examplesText),
    },
    replies: { ...draft.setup.replies, allowlist: list(draft.allowlistText) },
  });

  /** Creates the agent so the rest of the flow has something to attach to. */
  const createAgent = async () => {
    if (agentId) return agentId;
    const agent = await post<{ id: string }>('/api/agents', {
      name: draft.name.trim(),
      description: '',
      avatarUrl: draft.avatarUrl.trim() || null,
      avatarMode: 'PORTRAIT_25D',
      persona: { displayName: draft.name.trim() },
      // Nothing acts until Review, whatever is chosen later on.
      policy: { automation: { mode: 'MANUAL_ONLY', dryRunDefault: false } },
    });
    setAgentId(agent.id);
    return agent.id;
  };

  const advance = async () => {
    setBusy(true);
    setError(null);
    try {
      if (step === 0) await createAgent();
      setStep((s) => s + 1);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  /** Writes every answer through the same endpoints the Advanced screens use. */
  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const id = await createAgent();
      await put(`/api/agents/${id}/easy`, currentSetup());

      // Checked before activating rather than after: an agent that goes ACTIVE
      // and fails on its first job has told nobody anything useful.
      const outcome = await post<{ started: boolean; blockers: { what: string; fix: string }[] }>(
        `/api/agents/${id}/start`,
        {},
      );
      if (!outcome.started) {
        setBlockers(outcome.blockers);
        setBusy(false);
        return;
      }

      navigate(`/agents/${id}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The agent could not be started.');
      setBusy(false);
    }
  };

  /** Keeps everything configured, leaves the agent stopped, and goes to it. */
  const finishLater = async () => {
    setBusy(true);
    setError(null);
    try {
      const id = await createAgent();
      await put(`/api/agents/${id}/easy`, currentSetup());
      navigate(`/agents/${id}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That could not be saved.');
      setBusy(false);
    }
  };

  const canAdvance = step !== 0 || draft.name.trim().length > 0;

  return (
    <main className="mx-auto max-w-2xl px-6 pb-32 pt-32 sm:px-10 sm:pt-40">
      <FadeIn>
        <div className="mb-6 flex items-baseline justify-between gap-4">
          <p className="eyebrow">
            Step {step + 1} of {STEPS.length}
          </p>
          <Link to="/agents/new/advanced" className="font-mono text-[10px] uppercase tracking-[0.18em] text-bone-faint hover:text-bone-dim">
            Advanced setup
          </Link>
        </div>
      </FadeIn>
      <AnimatedText as="h1" key={step} text={STEPS[step]!} className="monument mb-6 text-[13vw] leading-[0.85] sm:text-[6vw]" />

      <div
        className="mb-12 flex gap-1.5"
        role="progressbar"
        aria-valuenow={step + 1}
        aria-valuemin={1}
        aria-valuemax={STEPS.length}
        aria-label="Setup progress"
      >
        {STEPS.map((label, index) => (
          <span
            key={label}
            className={`h-0.5 flex-1 rounded-full transition-colors duration-500 ${index <= step ? 'bg-signal-calm' : 'bg-ink-line'}`}
          />
        ))}
      </div>

      <div className="min-h-[20rem] space-y-6">
        {step === 0 && (
          <>
            <p className="text-[15px] font-light leading-relaxed text-bone-dim">
              An agent is a character with an account, a model, and rules about who it answers. This takes about two
              minutes.
            </p>
            <Field label="What is it called?" htmlFor="name">
              <input
                id="name"
                autoFocus
                className="field"
                value={draft.name}
                onChange={(e) => set({ name: e.target.value })}
                placeholder="Atlas"
              />
            </Field>
            <div className="grid gap-6 sm:grid-cols-[auto_1fr] sm:items-start">
              <AgentGlyph agentId="preview" name={draft.name || 'Agent'} imageUrl={draft.avatarUrl || null} size="lg" />
              <Field label="Profile picture" htmlFor="avatar" hint="Any image URL. Leave blank for a generated mark.">
                <input
                  id="avatar"
                  className="field"
                  value={draft.avatarUrl}
                  onChange={(e) => set({ avatarUrl: e.target.value })}
                  placeholder="https://..."
                />
              </Field>
            </div>
          </>
        )}

        {step === 1 && (
          <ConnectX
            agentId={agentId}
            handle={draft.handle}
            onHandle={(handle) => set({ handle })}
            accountId={accountId}
            onAccount={setAccountId}
          />
        )}

        {step === 3 && (
          <>
            {agentId && (
              <CharacterBuilder
                agentId={agentId}
                onDraft={(draft) => applyDraft(draft)}
              />
            )}

            {draftCompleteness && (
              <div className="rounded-xl border border-ink-line p-5">
                <CompletenessBar completeness={draftCompleteness} />
              </div>
            )}

            <p className="pt-2 text-[13px] leading-relaxed text-bone-faint">
              Or fill it in yourself. Anything the builder produced is editable below.
            </p>

            <Field label="Who is this?" htmlFor="description" hint="One line. Shown wherever the agent is listed.">
              <input
                id="description"
                className="field"
                value={draft.setup.character.description}
                onChange={(e) => setSetup({ character: { ...draft.setup.character, description: e.target.value } })}
                placeholder="Watches protocol governance and says what changed."
              />
            </Field>

            <Field label="How do they speak?" hint="A starting point. Everything here stays editable afterwards.">
              <div className="grid gap-2 sm:grid-cols-2">
                {(Object.keys(EASY_STYLE_PRESETS) as Exclude<EasyStylePreset, 'CUSTOM'>[]).map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => setSetup({ character: { ...draft.setup.character, preset, tone: '', speaksLike: '' } })}
                    className={`rounded-lg border px-3.5 py-3 text-left transition-colors ${
                      draft.setup.character.preset === preset
                        ? 'border-signal-calm/60 bg-signal-calm/[0.07] text-bone'
                        : 'border-ink-line text-bone-dim hover:border-bone-faint'
                    }`}
                  >
                    <span className="block text-sm">{EASY_STYLE_PRESETS[preset].label}</span>
                    <span className="mt-1 block text-[11px] text-bone-faint">{EASY_STYLE_PRESETS[preset].blurb}</span>
                    {/*
                      The sentences the model is actually given, shown on the
                      chosen one. A label is a promise; this is the instruction
                      that has to keep it, and somebody picking a voice should
                      be able to read it.
                    */}
                    {draft.setup.character.preset === preset && (
                      <span className="mt-2 block border-t border-ink-line pt-2 text-[10px] leading-relaxed text-bone-faint">
                        {EASY_STYLE_PRESETS[preset].tone} {EASY_STYLE_PRESETS[preset].style}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </Field>

            <Field label="Personality" htmlFor="personality">
              <textarea
                id="personality"
                rows={3}
                className="field resize-y"
                value={draft.setup.character.personality}
                onChange={(e) => setSetup({ character: { ...draft.setup.character, personality: e.target.value } })}
                placeholder="Sceptical, patient, allergic to hype."
              />
            </Field>

            <Field label="What do they care about?" htmlFor="cares" hint="One per line, or comma separated.">
              <textarea
                id="cares"
                rows={2}
                className="field resize-y"
                value={draft.caresText}
                onChange={(e) => set({ caresText: e.target.value })}
                placeholder="governance, token distribution"
              />
            </Field>

            <Field
              label="What language should it reply in?"
              hint="With no rule it answers in whatever language it was written to, which surprises most people the first time it happens."
            >
              <div className="grid gap-2 sm:grid-cols-3">
                {(
                  [
                    ['MIRROR', 'Match the message', 'Polish in, Polish out'],
                    ['ENGLISH', 'Always English', 'Whatever it was asked in'],
                    ['CUSTOM', 'Something else', 'Write the rule yourself'],
                  ] as const
                ).map(([value, label, hint]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setSetup({ language: value })}
                    className={`rounded-lg border px-3.5 py-3 text-left transition-colors ${
                      draft.setup.language === value
                        ? 'border-signal-calm/60 bg-signal-calm/[0.07] text-bone'
                        : 'border-ink-line text-bone-dim hover:border-bone-faint'
                    }`}
                  >
                    <span className="block text-sm">{label}</span>
                    <span className="mt-1 block text-[11px] text-bone-faint">{hint}</span>
                  </button>
                ))}
              </div>
            </Field>

            {draft.setup.language === 'CUSTOM' && (
              <Field label="Which language?" htmlFor="lang-detail">
                <input
                  id="lang-detail"
                  className="field"
                  value={draft.setup.languageDetail}
                  onChange={(e) => setSetup({ languageDetail: e.target.value })}
                  placeholder="Always reply in Simplified Chinese."
                />
              </Field>
            )}

            <Field label="Emoji" hint="Models left alone put one in every sentence, which is the fastest way to read as a bot.">
              <div className="grid gap-2 sm:grid-cols-2">
                {(
                  [
                    ['NONE', 'None at all', 'Not even when the other person uses them'],
                    ['MINIMAL', 'Rarely', 'At most one, and only when it earns its place'],
                    ['SELECTED', 'Only ones I pick', 'From a list you choose'],
                    ['UNRESTRICTED', 'No rule', 'Whatever the model does'],
                  ] as const
                ).map(([value, label, hint]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setSetup({ emoji: { ...draft.setup.emoji, use: value } })}
                    className={`rounded-lg border px-3.5 py-3 text-left transition-colors ${
                      draft.setup.emoji.use === value
                        ? 'border-signal-calm/60 bg-signal-calm/[0.07] text-bone'
                        : 'border-ink-line text-bone-dim hover:border-bone-faint'
                    }`}
                  >
                    <span className="block text-sm">{label}</span>
                    <span className="mt-1 block text-[11px] text-bone-faint">{hint}</span>
                  </button>
                ))}
              </div>
            </Field>

            {draft.setup.emoji.use === 'SELECTED' && (
              <Field label="Which ones?" htmlFor="emoji-allowed" hint="Paste the emoji it may use. Anything else is removed.">
                <input
                  id="emoji-allowed"
                  className="field text-lg"
                  value={draft.setup.emoji.allowed.join(' ')}
                  onChange={(e) =>
                    setSetup({
                      emoji: { ...draft.setup.emoji, allowed: [...e.target.value.matchAll(/\p{Extended_Pictographic}/gu)].map((m) => m[0]) },
                    })
                  }
                  placeholder="🔥 👀 🫡"
                />
              </Field>
            )}

            {(draft.setup.emoji.use === 'MINIMAL' || draft.setup.emoji.use === 'SELECTED') && (
              <div className="grid gap-6 sm:grid-cols-2">
                <Field label="At most, per message" htmlFor="emoji-max">
                  <input
                    id="emoji-max"
                    type="number"
                    min={0}
                    max={5}
                    className="field"
                    value={draft.setup.emoji.maxPerMessage}
                    onChange={(e) => setSetup({ emoji: { ...draft.setup.emoji, maxPerMessage: Number(e.target.value) || 0 } })}
                  />
                </Field>
                <Field label="In how many messages" htmlFor="emoji-share" hint={`About ${draft.setup.emoji.messagesPercent}% of them.`}>
                  <input
                    id="emoji-share"
                    type="range"
                    min={0}
                    max={100}
                    step={5}
                    className="w-full"
                    value={draft.setup.emoji.messagesPercent}
                    onChange={(e) => setSetup({ emoji: { ...draft.setup.emoji, messagesPercent: Number(e.target.value) } })}
                  />
                </Field>
              </div>
            )}

            <Field
              label="Things they would say"
              htmlFor="examples"
              hint="Optional, and the single most useful thing you can give it. One per line."
            >
              <textarea
                id="examples"
                rows={4}
                className="field resize-y"
                value={draft.examplesText}
                onChange={(e) => set({ examplesText: e.target.value })}
                placeholder={'Distribution changed. The vote did not.\nThat number is annualised. It should not be.'}
              />
            </Field>
          </>
        )}

        {step === 2 && (
          <ConnectAI
            spec={providerSpec}
            draft={draft}
            set={set}
            providers={providers.data?.items ?? []}
            providerId={providerId}
            onProvider={setProviderId}
            agentId={agentId}
          />
        )}

        {step === 4 && (
          <>
            <Field label="Who should it answer?">
              <div className="space-y-2">
                {AUDIENCE_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() =>
                      setSetup({
                        replies: {
                          ...draft.setup.replies,
                          audience: option.value,
                          filters: {
                            ...draft.setup.replies.filters,
                            verifiedOnly: option.value === 'VERIFIED_ONLY',
                          },
                        },
                      })
                    }
                    className={`block w-full rounded-lg border px-3.5 py-3 text-left transition-colors ${
                      draft.setup.replies.audience === option.value
                        ? 'border-signal-calm/60 bg-signal-calm/[0.07] text-bone'
                        : 'border-ink-line text-bone-dim hover:border-bone-faint'
                    }`}
                  >
                    <span className="block text-sm">{option.label}</span>
                    <span className="mt-1 block text-[11px] text-bone-faint">{option.detail}</span>
                  </button>
                ))}
              </div>
            </Field>

            {draft.setup.replies.audience === 'ALLOWLIST' && (
              <Field label="Who?" htmlFor="allowlist" hint="Handles, without the @. One per line.">
                <textarea
                  id="allowlist"
                  rows={3}
                  className="field resize-y"
                  value={draft.allowlistText}
                  onChange={(e) => set({ allowlistText: e.target.value })}
                  placeholder="alice"
                />
              </Field>
            )}

            <Field label="How selective should it be?">
              <div className="grid gap-2 sm:grid-cols-3">
                {(
                  [
                    ['ALMOST_EVERYTHING', 'Reply to almost everything'],
                    ['BALANCED', 'Balanced'],
                    ['ONLY_WHEN_USEFUL', 'Only when it has something useful to say'],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setSetup({ replies: { ...draft.setup.replies, selectivity: value } })}
                    className={`rounded-lg border px-3.5 py-3 text-left text-sm transition-colors ${
                      draft.setup.replies.selectivity === value
                        ? 'border-signal-calm/60 bg-signal-calm/[0.07] text-bone'
                        : 'border-ink-line text-bone-dim hover:border-bone-faint'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </Field>

            <div className="space-y-3 border-t border-ink-line pt-6">
              <Toggle
                checked={draft.setup.replies.filters.massTags}
                onChange={(v) =>
                  setSetup({ replies: { ...draft.setup.replies, filters: { ...draft.setup.replies.filters, massTags: v } } })
                }
                label="Ignore mass-tag spam"
                description="A post tagging a dozen accounts at once is rarely addressed to any of them."
              />
              <Toggle
                checked={draft.setup.replies.filters.repetition}
                onChange={(v) =>
                  setSetup({ replies: { ...draft.setup.replies, filters: { ...draft.setup.replies.filters, repetition: v } } })
                }
                label="Do not answer the same person over and over"
                description="At most a few replies to one account in an hour."
              />
              <Toggle
                checked={draft.setup.replies.filters.repliesToOwnPosts}
                onChange={(v) =>
                  setSetup({
                    replies: { ...draft.setup.replies, filters: { ...draft.setup.replies.filters, repliesToOwnPosts: v } },
                  })
                }
                label="Watch its own posts for replies"
                description="Some replies never produce a notification. This is how it sees them."
              />
              <Toggle
                checked={draft.setup.replies.filters.directMentionsOnly}
                onChange={(v) =>
                  setSetup({
                    replies: { ...draft.setup.replies, filters: { ...draft.setup.replies.filters, directMentionsOnly: v } },
                  })
                }
                label="Only when it is named"
                description="Ignores replies in a conversation that do not mention it."
              />
            </div>
          </>
        )}

        {step === 5 && (
          <>
            <Toggle
              checked={draft.setup.posting.enabled}
              onChange={(v) => setSetup({ posting: { ...draft.setup.posting, enabled: v } })}
              label="Make posts of its own"
              description="It writes from things it has actually thought about in conversations. With nothing to say, it says nothing."
            />
            {draft.setup.posting.enabled && (
              <Field label="How often?" hint="A ceiling, not a schedule. It stays quiet when it has nothing worth posting.">
                <div className="grid gap-2 sm:grid-cols-3">
                  {(
                    [
                      ['OCCASIONALLY', 'Occasionally'],
                      ['FEW_PER_DAY', 'A few times a day'],
                      ['DAILY', 'About daily'],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setSetup({ posting: { ...draft.setup.posting, frequency: value } })}
                      className={`rounded-lg border px-3.5 py-3 text-sm transition-colors ${
                        draft.setup.posting.frequency === value
                          ? 'border-signal-calm/60 bg-signal-calm/[0.07] text-bone'
                          : 'border-ink-line text-bone-dim hover:border-bone-faint'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </Field>
            )}
          </>
        )}

        {step === 6 && (
          <Field label="How should it operate?">
            <div className="space-y-2">
              {(
                [
                  [
                    'REVIEW_FIRST',
                    'Review first',
                    'It writes the reply and waits for you to approve or edit it. Start here if you are not sure.',
                  ],
                  ['AUTOMATIC', 'Automatic', 'It replies and posts on its own, within the rules you just set.'],
                ] as const
              ).map(([value, label, detail]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setSetup({ operation: value })}
                  className={`block w-full rounded-lg border px-3.5 py-3 text-left transition-colors ${
                    draft.setup.operation === value
                      ? 'border-signal-calm/60 bg-signal-calm/[0.07] text-bone'
                      : 'border-ink-line text-bone-dim hover:border-bone-faint'
                  }`}
                >
                  <span className="block text-sm">{label}</span>
                  <span className="mt-1 block text-[11px] text-bone-faint">{detail}</span>
                </button>
              ))}
            </div>
          </Field>
        )}

        {step === 7 && (
          <div className="space-y-5">
            <div className="flex items-center gap-5">
              <AgentGlyph agentId={agentId ?? 'preview'} name={draft.name || 'Agent'} imageUrl={draft.avatarUrl || null} size="lg" />
              <div className="min-w-0">
                <p className="truncate text-3xl font-light text-bone">{draft.name || 'Untitled'}</p>
                {draft.handle && (
                  <p className="mt-1 font-mono text-[11px] text-bone-faint">@{draft.handle.replace(/^@/, '')}</p>
                )}
              </div>
            </div>
            <dl className="divide-y divide-ink-line rounded-xl border border-ink-line">
              <Row label="X" value={draft.handle ? `@${draft.handle.replace(/^@/, '')}` : 'Not connected'} />
              <Row
                label="AI"
                value={providerId ? `${providerSpec.label} · ${draft.model || 'default model'}` : 'Not connected'}
              />
              <Row
                label="Replies"
                value={AUDIENCE_OPTIONS.find((o) => o.value === draft.setup.replies.audience)!.label.toLowerCase()}
              />
              <Row
                label="Posts"
                value={
                  draft.setup.posting.enabled
                    ? draft.setup.posting.frequency.toLowerCase().replace(/_/g, ' ')
                    : 'Off'
                }
              />
              <Row label="Operation" value={draft.setup.operation === 'AUTOMATIC' ? 'Automatic' : 'Review first'} />
              <Row label="Character" value={draft.setup.character.preset.toLowerCase()} />
            </dl>
            {!draft.handle && (
              <p className="text-[13px] leading-relaxed text-bone-faint">
                With no X account connected it will run, but it has nothing to read. You can connect one from its page.
              </p>
            )}
            {blockers.length > 0 && (
              <div className="space-y-2 rounded-lg border border-signal-wait/40 bg-signal-wait/[0.06] p-4">
                <p className="text-sm text-bone">Nearly. This needs sorting first:</p>
                <ul className="space-y-2">
                  {blockers.map((blocker) => (
                    <li key={blocker.what} className="text-[13px] leading-relaxed text-bone-dim">
                      {blocker.what} <span className="text-bone-faint">{blocker.fix}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {error && <ErrorPanel title="The agent could not be started." detail={error} />}
          </div>
        )}

        {step !== 7 && error && <ErrorPanel title="That did not work." detail={error} />}
      </div>

      <div className="mt-12 flex items-center justify-between gap-4 border-t border-ink-line pt-6">
        <button
          type="button"
          className="btn-quiet"
          onClick={() => (step === 0 ? navigate('/') : setStep(step - 1))}
          disabled={busy}
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
          {step === 0 ? 'Cancel' : 'Back'}
        </button>
        {step < STEPS.length - 1 ? (
          <button type="button" className="btn-primary" onClick={() => void advance()} disabled={!canAdvance || busy}>
            {busy ? <Spinner /> : null}
            Continue
            <ArrowRight className="h-4 w-4" aria-hidden />
          </button>
        ) : (
          <div className="flex flex-wrap items-center justify-end gap-2">
            {/*
              Skipping a step has to lead somewhere. Without this the only way
              out of the last screen was Start, which refuses when nothing is
              connected — so anybody who skipped X was stuck on a finished
              wizard with no way to keep what they had made.
            */}
            <button type="button" className="btn-quiet" onClick={() => void finishLater()} disabled={busy}>
              Save and finish later
            </button>
            <button type="button" className="btn-primary" onClick={() => void start()} disabled={busy}>
              {busy ? <Spinner /> : <Check className="h-4 w-4" aria-hidden />}
              Start agent
            </button>
          </div>
        )}
      </div>
    </main>
  );
}

/**
 * Connecting X, without asking anybody what CDP is.
 *
 * Underneath this is the same real Google Chrome pipeline as everywhere else:
 * AI17Z starts Chrome with a profile kept for this account and the person signs
 * in by hand, once. None of that appears here; it is all under Advanced.
 */
function ConnectX({
  agentId,
  handle,
  onHandle,
  accountId,
  onAccount,
}: {
  agentId: string | null;
  handle: string;
  onHandle: (value: string) => void;
  accountId: string | null;
  onAccount: (id: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const account = useResource<{ account: AccountRow }>(accountId ? `/api/accounts/${accountId}/session` : null, [
    accountId,
  ]);

  // While a sign-in is in flight the state changes underneath us, so this
  // follows it rather than making somebody press refresh.
  const status = account.data?.account.status ?? null;
  const settled = status === 'CONNECTED' || status === null;
  usePolling(() => account.reload(), 2_000, Boolean(accountId) && !settled);

  const connect = async () => {
    if (!agentId) return;
    setBusy(true);
    setError(null);
    try {
      const clean = handle.trim().replace(/^@/, '');
      // The API returns the existing account when this handle is already
      // connected, so reconnecting one is not an error.
      const created = await post<{ id: string; status: string }>('/api/accounts', {
        channel: 'x',
        handle: clean,
        displayName: clean,
      });
      await post(`/api/agents/${agentId}/accounts`, {
        accountId: created.id,
        triggerEventTypes: ['MENTION', 'REPLY'],
        actionType: 'REPLY',
      });
      onAccount(created.id);

      // An account already signed in needs no sign-in window. Opening one would
      // close over a working session and ask somebody to log in again.
      if (created.status !== 'CONNECTED') {
        await post(`/api/accounts/${created.id}/session/tasks`, { kind: 'OPEN_AUTH' });
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'X could not be connected.');
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!accountId) return;
    await post(`/api/accounts/${accountId}/session/tasks`, { kind: 'CANCEL_AUTH' }).catch(() => undefined);
    account.reload();
  };

  if (status === 'CONNECTED') {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3 rounded-lg border border-signal-live/40 bg-signal-live/[0.06] px-4 py-4">
          <StatusDot state="live" />
          <div className="min-w-0">
            <p className="text-sm text-bone">@{account.data?.account.handle}</p>
            <p className="mt-0.5 text-[11px] text-bone-faint">Connected. Signed in through your own Google Chrome.</p>
          </div>
        </div>
      </div>
    );
  }

  if (accountId && account.data) {
    return (
      <div className="space-y-4">
        <SignInProgress account={account.data.account} onCancel={() => void cancel()} cancelling={false} />
        <p className="text-[13px] leading-relaxed text-bone-faint">
          A Chrome window is opening. Sign in there and this page follows along on its own.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <p className="text-[15px] font-light leading-relaxed text-bone-dim">
        AI17Z opens a real Chrome window with a profile kept for this account. You sign in once, by hand; it is
        remembered after that.
      </p>
      <Field label="Which account?" htmlFor="handle" hint="The X username it will post from, without the @.">
        <input
          id="handle"
          className="field"
          value={handle}
          onChange={(e) => onHandle(e.target.value)}
          placeholder="your_handle"
        />
      </Field>
      <button
        type="button"
        className="btn-primary"
        onClick={() => void connect()}
        disabled={busy || !handle.trim() || !agentId}
      >
        {busy ? <Spinner /> : null}
        Connect X
      </button>
      <p className="text-[12px] text-bone-faint">You can skip this and connect an account later from the agent page.</p>
      {error && <ErrorPanel title="X could not be connected." detail={error} />}
    </div>
  );
}

/** Choosing the model. Only what is actually required for the one chosen. */
function ConnectAI({
  spec,
  draft,
  set,
  providers,
  providerId,
  onProvider,
  agentId,
}: {
  spec: (typeof PROVIDERS)[number];
  draft: Draft;
  set: (patch: Partial<Draft>) => void;
  providers: ProviderCredential[];
  providerId: string | null;
  onProvider: (id: string) => void;
  agentId: string | null;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; detail: string } | null>(null);

  const existing = useMemo(
    () => providers.find((p) => p.provider === draft.providerKind && p.enabled) ?? null,
    [providers, draft.providerKind],
  );
  useEffect(() => setResult(null), [draft.providerKind]);

  const connect = async () => {
    if (!agentId) return;
    setBusy(true);
    setResult(null);
    try {
      const credential =
        existing ??
        (await post<ProviderCredential>('/api/providers', {
          provider: draft.providerKind,
          label: spec.label,
          apiKey: draft.apiKey.trim() || null,
          baseUrl: draft.baseUrl.trim() || null,
        }));
      onProvider(credential.id);

      const test = await post<{ ok: boolean; detail: string; provider: ProviderCredential }>(
        `/api/providers/${credential.id}/test`,
        {},
      );
      setResult({ ok: test.ok, detail: test.detail });
      if (!test.ok) return;

      const model = draft.model.trim() || test.provider.defaultModel || '';
      if (model) {
        set({ model });
        // Written to the primary role. Classification, critic, and voice models
        // are Advanced concerns and fall back to this one.
        await put(`/api/agents/${agentId}/models`, {
          role: 'primary',
          providerCredentialId: credential.id,
          model,
          parameters: {},
        });
      }
    } catch (e) {
      setResult({ ok: false, detail: e instanceof ApiError ? e.message : 'That provider could not be reached.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <Field label="Which AI is behind this agent?">
        <div className="grid gap-2 sm:grid-cols-2">
          {PROVIDERS.map((option) => (
            <button
              key={option.kind}
              type="button"
              onClick={() => set({ providerKind: option.kind })}
              className={`rounded-lg border px-3.5 py-3 text-left transition-colors ${
                draft.providerKind === option.kind
                  ? 'border-signal-calm/60 bg-signal-calm/[0.07] text-bone'
                  : 'border-ink-line text-bone-dim hover:border-bone-faint'
              }`}
            >
              <span className="block text-sm">{option.label}</span>
              {option.hint && <span className="mt-1 block text-[11px] text-bone-faint">{option.hint}</span>}
            </button>
          ))}
        </div>
      </Field>

      {spec.needsKey && !existing && (
        <Field label="API key" htmlFor="apikey" hint="Sealed on this machine and never shown again, in logs or anywhere else.">
          <input
            id="apikey"
            type="password"
            className="field font-mono text-[13px]"
            value={draft.apiKey}
            onChange={(e) => set({ apiKey: e.target.value })}
            placeholder="sk-..."
          />
        </Field>
      )}
      {existing && (
        <p className="rounded-lg border border-ink-line px-3.5 py-3 text-[12px] text-bone-faint">
          Using the {spec.label} key already saved in Settings.
        </p>
      )}
      {!spec.needsKey && (
        <Field label="Where is it running?" htmlFor="baseurl" hint="Leave blank for the default local address.">
          <input
            id="baseurl"
            className="field font-mono text-[13px]"
            value={draft.baseUrl}
            onChange={(e) => set({ baseUrl: e.target.value })}
            placeholder="http://127.0.0.1:11434"
          />
        </Field>
      )}

      <Field label="Model" htmlFor="model" hint="Leave blank to use the provider's default.">
        <input
          id="model"
          className="field font-mono text-[13px]"
          value={draft.model}
          onChange={(e) => set({ model: e.target.value })}
          placeholder="anthropic/claude-sonnet-4"
        />
      </Field>

      <button type="button" className="btn-ghost" onClick={() => void connect()} disabled={busy}>
        {busy ? <Spinner /> : <Sparkles className="h-4 w-4" aria-hidden />}
        Test and connect
      </button>

      {result && (
        <div
          className={`rounded-lg border px-3.5 py-3 text-sm ${
            result.ok ? 'border-signal-live/40 bg-signal-live/[0.06] text-bone' : 'border-signal-fail/40 bg-signal-fail/[0.06] text-bone'
          }`}
        >
          {result.ok ? `Connected. ${result.detail}` : result.detail}
        </div>
      )}
      {providerId && !result && <p className="text-[12px] text-bone-faint">Provider saved.</p>}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-6 px-4 py-3">
      <dt className="font-mono text-[10px] uppercase tracking-[0.16em] text-bone-faint">{label}</dt>
      <dd className="text-right text-sm capitalize text-bone-dim">{value}</dd>
    </div>
  );
}
