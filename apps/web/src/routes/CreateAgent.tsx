import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { DEFAULT_TRIGGER_EVENT_TYPES } from '@xbam/shared/contracts';
import { ArrowLeft, ArrowRight, Check } from 'lucide-react';
import { ApiError, post, put } from '@app/lib/api';
import { useResource } from '@app/lib/hooks';
import type { ChannelInfo, ProviderCredential } from '@app/lib/types';
import { AgentGlyph } from '@app/components/AgentGlyph';
import { AnimatedText, FadeIn } from '@app/components/motion';
import { ErrorPanel, Field, Spinner, Toggle } from '@app/components/ui';

const STEPS = ['Identity', 'Portrait', 'Persona', 'Intelligence', 'Channel', 'Memory', 'Automation', 'Review'] as const;

interface Draft {
  name: string;
  description: string;
  avatarUrl: string;
  identityKind: 'FICTIONAL' | 'INSPIRED_BY' | 'BRAND' | 'REAL_PERSON_AUTHORIZED' | 'DISCLOSED_AI';
  personality: string;
  tone: string;
  topics: string;
  languagePolicy: string;
  responseLength: 'TERSE' | 'SHORT' | 'MEDIUM' | 'LONG' | 'ADAPTIVE';
  providerId: string;
  model: string;
  channel: 'none' | 'mock' | 'x';
  handle: string;
  rememberUserFacts: boolean;
  threadMemory: boolean;
  automation: 'OFF' | 'MONITOR_ONLY' | 'MANUAL_ONLY' | 'REVIEW_BEFORE_ACTION' | 'AUTONOMOUS';
  dryRunDefault: boolean;
  maxCharacters: number;
}

const INITIAL: Draft = {
  name: '',
  description: '',
  avatarUrl: '',
  identityKind: 'DISCLOSED_AI',
  personality: '',
  tone: '',
  topics: '',
  languagePolicy: '',
  responseLength: 'SHORT',
  providerId: '',
  model: '',
  channel: 'mock',
  handle: '',
  rememberUserFacts: true,
  threadMemory: true,
  automation: 'REVIEW_BEFORE_ACTION',
  dryRunDefault: true,
  maxCharacters: 280,
};

const IDENTITY_HELP: Record<Draft['identityKind'], string> = {
  DISCLOSED_AI: 'Open about being an AI. The safest default.',
  FICTIONAL: 'An invented character. Never claims to be a real person.',
  INSPIRED_BY: 'Borrows a public figure voice while stating it is not them.',
  BRAND: 'Speaks as an organisation, not an individual.',
  REAL_PERSON_AUTHORIZED: 'Represents a named person who authorised this account.',
};

export function CreateAgent() {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<Draft>(INITIAL);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const providers = useResource<{ items: ProviderCredential[] }>('/api/providers');
  const channels = useResource<{ items: ChannelInfo[] }>('/api/channels');

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));

  const provider = useMemo(
    () => providers.data?.items.find((p) => p.id === draft.providerId) ?? null,
    [providers.data, draft.providerId],
  );

  const canAdvance = step !== 0 || draft.name.trim().length > 0;

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const agent = await post<{ id: string }>('/api/agents', {
        name: draft.name.trim(),
        description: draft.description.trim(),
        avatarUrl: draft.avatarUrl.trim() || null,
        avatarMode: 'PORTRAIT_25D',
        persona: {
          displayName: draft.name.trim(),
          identityKind: draft.identityKind,
          personality: draft.personality.trim(),
          tone: draft.tone.trim(),
          languagePolicy: draft.languagePolicy.trim(),
          responseLength: draft.responseLength,
          topics: draft.topics.split(',').map((t) => t.trim()).filter(Boolean),
        },
        policy: {
          automation: { mode: draft.automation, dryRunDefault: draft.dryRunDefault },
          output: { maxCharacters: draft.maxCharacters },
          memory: {
            write: {
              thread: { enabled: draft.threadMemory },
              user: { enabled: draft.rememberUserFacts, extractor: draft.rememberUserFacts ? 'heuristic' : 'off' },
            },
          },
        },
      });

      if (draft.providerId && draft.model.trim()) {
        await put(`/api/agents/${agent.id}/models`, {
          role: 'primary',
          providerCredentialId: draft.providerId,
          model: draft.model.trim(),
          parameters: {},
        });
      }

      if (draft.channel !== 'none') {
        const handle = draft.handle.trim() || draft.name.trim().toLowerCase().replace(/\s+/g, '_');
        const account = await post<{ id: string }>('/api/accounts', {
          channel: draft.channel,
          handle,
          displayName: draft.name.trim(),
        });
        await post(`/api/agents/${agent.id}/accounts`, {
          accountId: account.id,
          triggerEventTypes: [...DEFAULT_TRIGGER_EVENT_TYPES],
          actionType: 'REPLY',
        });
      }

      navigate(`/agents/${agent.id}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The agent could not be created.');
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto max-w-3xl px-6 pb-32 pt-32 sm:px-10 sm:pt-40">
      <FadeIn>
        <p className="eyebrow mb-6">
          Step {step + 1} of {STEPS.length}
        </p>
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
          <span key={label} className={`h-0.5 flex-1 rounded-full transition-colors duration-500 ${index <= step ? 'bg-signal-calm' : 'bg-ink-line'}`} />
        ))}
      </div>

      <div className="min-h-[22rem] space-y-6">
        {step === 0 && (
          <>
            <Field label="Name" htmlFor="name" hint="Shown everywhere in AI17Z and used as the agent display name.">
              <input id="name" className="field" autoFocus value={draft.name} onChange={(e) => set('name', e.target.value)} placeholder="Nova" />
            </Field>
            <Field label="Description" htmlFor="description" hint="For you, not for the model.">
              <textarea id="description" rows={3} className="field resize-y" value={draft.description} onChange={(e) => set('description', e.target.value)} placeholder="Answers product questions on X." />
            </Field>
          </>
        )}

        {step === 1 && (
          <div className="grid gap-8 sm:grid-cols-[auto_1fr] sm:items-start">
            <AgentGlyph agentId="preview" name={draft.name || 'Agent'} imageUrl={draft.avatarUrl || null} size="lg" />
            <Field label="Portrait URL" htmlFor="avatar" hint="Any image URL. It becomes the agent likeness, rendered with depth and parallax on its page. Leave blank for a generated mark.">
              <input id="avatar" className="field" value={draft.avatarUrl} onChange={(e) => set('avatarUrl', e.target.value)} placeholder="https://..." />
            </Field>
          </div>
        )}

        {step === 2 && (
          <>
            <Field label="Identity" hint={IDENTITY_HELP[draft.identityKind]}>
              <div className="grid gap-2 sm:grid-cols-2">
                {(Object.keys(IDENTITY_HELP) as Draft['identityKind'][]).map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    onClick={() => set('identityKind', kind)}
                    className={`rounded-lg border px-3.5 py-3 text-left text-sm capitalize transition-colors ${draft.identityKind === kind ? 'border-signal-calm/60 bg-signal-calm/[0.07] text-bone' : 'border-ink-line text-bone-dim hover:border-bone-faint'}`}
                  >
                    {kind.replace(/_/g, ' ').toLowerCase()}
                  </button>
                ))}
              </div>
            </Field>
            <Field label="Personality" htmlFor="personality">
              <textarea id="personality" rows={3} className="field resize-y" value={draft.personality} onChange={(e) => set('personality', e.target.value)} placeholder="Calm, direct, allergic to filler." />
            </Field>
            <div className="grid gap-6 sm:grid-cols-2">
              <Field label="Tone" htmlFor="tone">
                <input id="tone" className="field" value={draft.tone} onChange={(e) => set('tone', e.target.value)} placeholder="Dry, warm, unhurried" />
              </Field>
              <Field label="Topics" htmlFor="topics" hint="Comma separated.">
                <input id="topics" className="field" value={draft.topics} onChange={(e) => set('topics', e.target.value)} placeholder="markets, product, risk" />
              </Field>
            </div>
            <Field label="Language" htmlFor="language" hint="Leave blank to mirror whatever language it is written to in.">
              <input id="language" className="field" value={draft.languagePolicy} onChange={(e) => set('languagePolicy', e.target.value)} placeholder="Always reply in Simplified Chinese" />
            </Field>
          </>
        )}

        {step === 3 &&
          (providers.data && providers.data.items.length === 0 ? (
            <ErrorPanel title="No model providers yet." detail="You can still create this agent and add a model afterwards. Settings has an Ollama option that needs no API key." />
          ) : (
            <>
              <Field label="Provider" htmlFor="provider">
                <select id="provider" className="field" value={draft.providerId} onChange={(e) => set('providerId', e.target.value)}>
                  <option value="">Choose later</option>
                  {providers.data?.items.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label} ({p.provider})
                    </option>
                  ))}
                </select>
              </Field>
              {provider && (
                <Field label="Model" htmlFor="model" hint={provider.availableModels.length ? 'Suggestions come from the provider itself.' : 'Type the model id exactly as the provider expects it.'}>
                  <input id="model" className="field" list="model-options" value={draft.model} onChange={(e) => set('model', e.target.value)} placeholder={provider.defaultModel ?? 'model-id'} />
                  <datalist id="model-options">
                    {provider.availableModels.map((m) => (
                      <option key={m} value={m} />
                    ))}
                  </datalist>
                </Field>
              )}
            </>
          ))}

        {step === 4 && (
          <>
            <Field label="Channel" hint="The mock channel is real: it runs the entire pipeline and stops at the action boundary.">
              <div className="grid gap-2 sm:grid-cols-3">
                {(['mock', 'x', 'none'] as const).map((option) => {
                  const info = channels.data?.items.find((c) => c.id === option);
                  return (
                    <button
                      key={option}
                      type="button"
                      onClick={() => set('channel', option)}
                      className={`rounded-lg border px-3.5 py-3 text-left text-sm transition-colors ${draft.channel === option ? 'border-signal-calm/60 bg-signal-calm/[0.07] text-bone' : 'border-ink-line text-bone-dim hover:border-bone-faint'}`}
                    >
                      <span className="block">{option === 'none' ? 'No channel' : (info?.displayName ?? option)}</span>
                      <span className="mt-1 block text-[11px] text-bone-faint">
                        {option === 'mock' ? 'Local, deterministic' : option === 'x' ? 'Needs a browser sign-in' : 'Add one later'}
                      </span>
                    </button>
                  );
                })}
              </div>
            </Field>
            {draft.channel !== 'none' && (
              <Field
                label="Handle"
                htmlFor="handle"
                hint={draft.channel === 'x' ? 'The X username this agent posts from, without the @.' : 'Any label. The mock channel does not check it.'}
              >
                <input id="handle" className="field" value={draft.handle} onChange={(e) => set('handle', e.target.value)} placeholder={draft.channel === 'x' ? 'your_handle' : 'local'} />
              </Field>
            )}
          </>
        )}

        {step === 5 && (
          <div className="space-y-4">
            <Toggle
              checked={draft.threadMemory}
              onChange={(v) => set('threadMemory', v)}
              label="Remember conversations"
              description="Stores both sides of every exchange, scoped to the thread it happened in."
            />
            <Toggle
              checked={draft.rememberUserFacts}
              onChange={(v) => set('rememberUserFacts', v)}
              label="Remember facts about people"
              description="Extracts durable statements so the agent recalls them in a completely different conversation later."
            />
          </div>
        )}

        {step === 6 && (
          <>
            <Field label="Automation" hint="Changeable at any time, and the agent can be paused instantly from its page.">
              <div className="space-y-2">
                {(['REVIEW_BEFORE_ACTION', 'AUTONOMOUS', 'MANUAL_ONLY'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => set('automation', mode)}
                    className={`block w-full rounded-lg border px-3.5 py-3 text-left text-sm transition-colors ${draft.automation === mode ? 'border-signal-calm/60 bg-signal-calm/[0.07] text-bone' : 'border-ink-line text-bone-dim hover:border-bone-faint'}`}
                  >
                    <span className="block capitalize">{mode.replace(/_/g, ' ').toLowerCase()}</span>
                    <span className="mt-1 block text-[11px] text-bone-faint">
                      {mode === 'REVIEW_BEFORE_ACTION'
                        ? 'Generates, then waits for you to approve or edit before anything is sent.'
                        : mode === 'AUTONOMOUS'
                          ? 'Sends without asking, subject to the policy limits.'
                          : 'Only acts when you trigger it by hand.'}
                    </span>
                  </button>
                ))}
              </div>
            </Field>
            <Toggle
              checked={draft.dryRunDefault}
              onChange={(v) => set('dryRunDefault', v)}
              label="Dry run by default"
              description="Runs the whole pipeline including target verification, then stops before touching the remote account."
            />
            <Field label="Maximum reply length" htmlFor="maxchars">
              <input id="maxchars" type="number" min={20} max={5000} className="field" value={draft.maxCharacters} onChange={(e) => set('maxCharacters', Number(e.target.value) || 280)} />
            </Field>
          </>
        )}

        {step === 7 && (
          <div className="space-y-5">
            <div className="flex items-center gap-5">
              <AgentGlyph agentId="preview" name={draft.name || 'Agent'} imageUrl={draft.avatarUrl || null} size="lg" />
              <div className="min-w-0">
                <p className="truncate text-3xl font-light text-bone">{draft.name || 'Untitled agent'}</p>
                <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.16em] text-bone-faint">
                  {draft.identityKind.replace(/_/g, ' ').toLowerCase()}
                </p>
              </div>
            </div>
            <dl className="divide-y divide-ink-line rounded-xl border border-ink-line">
              <Row label="Model" value={provider ? `${provider.label} · ${draft.model || provider.defaultModel || 'not set'}` : 'Not configured yet'} />
              <Row label="Channel" value={draft.channel === 'none' ? 'None' : `${draft.channel} @${draft.handle || 'auto'}`} />
              <Row label="Automation" value={draft.automation.replace(/_/g, ' ').toLowerCase()} />
              <Row label="Dry run" value={draft.dryRunDefault ? 'On, nothing is sent remotely' : 'Off, real actions permitted'} />
              <Row label="Memory" value={[draft.threadMemory && 'conversations', draft.rememberUserFacts && 'user facts'].filter(Boolean).join(', ') || 'none'} />
            </dl>
            {error && <ErrorPanel title="The agent could not be created." detail={error} />}
          </div>
        )}
      </div>

      <div className="mt-12 flex items-center justify-between gap-4 border-t border-ink-line pt-6">
        <button type="button" className="btn-quiet" onClick={() => (step === 0 ? navigate('/') : setStep(step - 1))} disabled={busy}>
          <ArrowLeft className="h-4 w-4" aria-hidden />
          {step === 0 ? 'Cancel' : 'Back'}
        </button>
        {step < STEPS.length - 1 ? (
          <button type="button" className="btn-primary" onClick={() => setStep(step + 1)} disabled={!canAdvance}>
            Continue
            <ArrowRight className="h-4 w-4" aria-hidden />
          </button>
        ) : (
          <button type="button" className="btn-primary" onClick={() => void create()} disabled={busy || !draft.name.trim()}>
            {busy ? <Spinner /> : <Check className="h-4 w-4" aria-hidden />}
            Create agent
          </button>
        )}
      </div>
    </main>
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
