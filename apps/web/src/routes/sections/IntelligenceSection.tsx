import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, del, put } from '@app/lib/api';
import { useResource } from '@app/lib/hooks';
import type { ModelConfig, ProviderCredential } from '@app/lib/types';
import { EmptyState, Field, Modal, Spinner } from '@app/components/ui';
import { staleModel } from '@xbam/shared/contracts';
import { IndexedRow, Section } from './Section';

/**
 * The roles this screen can set, and what each one actually does.
 *
 * Two were missing and one was mislabelled, which had a cost. There was no row
 * for `vision`, so there was no way to give an agent one from anywhere in the
 * application -- an agent asked about a screenshot could never see it, and the
 * only sign was a skipped media row in a trace. And `classifier` said "reserved
 * for future classification steps" while three code paths were already asking
 * for it, so anyone reading this screen would reasonably leave it empty.
 *
 * A role that nothing asks for does not belong here. These are read by
 * `mediaResolve`, `plan`, `arcs`, `voice` and `xIntelligence`; the rest of
 * MODEL_ROLES is not wired to anything yet and would be a promise rather than
 * a setting.
 */
const ROLES = [
  { role: 'primary', label: 'Primary model', hint: 'Tried first for every generation.' },
  { role: 'fallback_1', label: 'Fallback', hint: 'Used when the primary fails or is unavailable.' },
  { role: 'fallback_2', label: 'Second fallback', hint: 'Last resort before the job retries later.' },
  {
    role: 'vision',
    label: 'Vision',
    hint: 'Reads images and video frames. Without one, an image is an admitted gap.',
  },
  {
    role: 'classifier',
    label: 'Cheap classifier',
    hint: 'Decides what to look up, and summarises long threads. Small and fast is the point.',
  },
  {
    role: 'voice_rewrite',
    label: 'Voice rewrite',
    hint: 'Optional second pass that pulls a draft back towards the agent\'s own voice.',
  },
  {
    role: 'research',
    label: 'Research',
    hint: 'Searches X’s own index during the call, which a browser cannot reach. Needs a provider that can do it — xAI can. Billed per search, and off until Tools allows it.',
  },
] as const;

export function IntelligenceSection({
  index,
  agentId,
  models,
  onChanged,
  compact,
}: {
  index: number;
  agentId: string;
  models: ModelConfig[];
  onChanged: () => void;
  compact?: boolean;
}) {
  const providers = useResource<{ items: ProviderCredential[] }>('/api/providers');
  const [editing, setEditing] = useState<(typeof ROLES)[number]['role'] | null>(null);
  const [providerId, setProviderId] = useState('');
  const [model, setModel] = useState('');
  const [temperature, setTemperature] = useState('');
  const [maxTokens, setMaxTokens] = useState('');
  const [maxRetries, setMaxRetries] = useState('');
  const [priceIn, setPriceIn] = useState('');
  const [priceOut, setPriceOut] = useState('');
  const [reasoning, setReasoning] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openEditor = (role: (typeof ROLES)[number]['role']) => {
    const existing = models.find((m) => m.role === role);
    setProviderId(existing?.providerCredentialId ?? providers.data?.items[0]?.id ?? '');
    setModel(existing?.model ?? '');
    setTemperature(existing?.parameters.temperature != null ? String(existing.parameters.temperature) : '');
    setMaxTokens(existing?.parameters.maxTokens != null ? String(existing.parameters.maxTokens) : '');
    setMaxRetries(existing?.parameters.maxRetries != null ? String(existing.parameters.maxRetries) : '');
    setPriceIn(existing?.parameters.costPer1kPromptUsd != null ? String(existing.parameters.costPer1kPromptUsd) : '');
    setPriceOut(existing?.parameters.costPer1kCompletionUsd != null ? String(existing.parameters.costPer1kCompletionUsd) : '');
    setReasoning(typeof existing?.parameters.reasoningEffort === 'string' ? existing.parameters.reasoningEffort : '');
    setError(null);
    setEditing(role);
  };

  const save = async () => {
    if (!editing) return;
    setBusy(true);
    setError(null);
    try {
      const parameters: Record<string, number | string> = {};
      if (temperature.trim()) parameters.temperature = Number(temperature);
      if (maxTokens.trim()) parameters.maxTokens = Number(maxTokens);
      if (maxRetries.trim()) parameters.maxRetries = Number(maxRetries);
      if (reasoning) parameters.reasoningEffort = reasoning;
      // Prices are what make a spending limit enforceable. Without them a
      // call is recorded with no cost and a USD cap can never fire.
      if (priceIn.trim()) parameters.costPer1kPromptUsd = Number(priceIn);
      if (priceOut.trim()) parameters.costPer1kCompletionUsd = Number(priceOut);
      await put(`/api/agents/${agentId}/models`, { role: editing, providerCredentialId: providerId, model: model.trim(), parameters });
      setEditing(null);
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That model could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (role: string) => {
    await del(`/api/agents/${agentId}/models/${role}`).catch(() => undefined);
    setEditing(null);
    onChanged();
  };

  const selected = providers.data?.items.find((p) => p.id === providerId);

  /*
    Two roles do their damage by being absent rather than wrong, so they are
    called out rather than left as another "Not set" row among nine.

    Without `vision` an agent replies to a screenshot having never looked at it,
    and everything succeeds: the media is marked skipped, the reply is written,
    and the only sign is one line in a trace nobody opens. Somebody asked "what
    did he roundtrip on?" under a trade screenshot and got an answer assembled
    from three articles about sleep.

    Without `classifier` the agent still works, but it decides what to look up
    from patterns alone, which is right at both ends of the range and blind in
    the middle.
  */
  const hasVision = models.some((m) => m.role === 'vision');
  const hasClassifier = models.some((m) => m.role === 'classifier');
  const visionCandidates = (providers.data?.items ?? [])
    .flatMap((p) => p.availableModels.map((m) => ({ provider: p.label, model: m })))
    .filter((c) => /vision|vl\b|multimodal|omni/i.test(c.model));

  return (
    <Section
      compact={compact}
      id="intelligence"
      index={index}
      eyebrow="Intelligence"
      heading="What it thinks with."
      lede="Providers are adapters. Swapping one changes nothing about the persona, the memory, or the pipeline, and every attempt is recorded whether it succeeded or not."
    >
      {(providers.data?.items.length ?? 0) > 0 && !hasVision && (
        <div className="mb-5 rounded-2xl border border-signal-wait/30 bg-signal-wait/[0.06] p-5">
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-signal-wait">Cannot read images</p>
          <p className="mt-2 break-words text-sm leading-relaxed text-bone-dim">
            No vision model is set, so an image on a post is described to this agent as something it could not see. It
            will say so rather than guess, but it cannot answer a question about a chart or a screenshot.
            {visionCandidates.length > 0 && (
              <>
                {' '}
                Your providers offer{' '}
                <span className="text-bone">{visionCandidates.slice(0, 3).map((c) => c.model).join(', ')}</span>.
              </>
            )}
          </p>
          <button type="button" className="btn-ghost mt-4" onClick={() => openEditor('vision')}>
            Set a vision model
          </button>
        </div>
      )}

      {(providers.data?.items.length ?? 0) > 0 && !hasClassifier && (
        <div className="mb-5 rounded-2xl border border-ink-line p-5">
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-bone-faint">Deciding without help</p>
          <p className="mt-2 break-words text-sm leading-relaxed text-bone-dim">
            No classifier model is set. What to look up before replying is decided by rules alone, which is reliable for
            an ordinary reply and weaker on a message that asks two different things at once. A cheap, fast model here
            is asked only when there is something to decide.
          </p>
          <button type="button" className="btn-ghost mt-4" onClick={() => openEditor('classifier')}>
            Set a classifier model
          </button>
        </div>
      )}

      {providers.data?.items.length === 0 ? (
        <EmptyState
          title="No providers configured."
          detail="Add one in Settings. Ollama runs locally and needs no API key."
          action={
            <Link to="/settings" className="btn-ghost">
              Open settings
            </Link>
          }
        />
      ) : (
        <div className="border-b border-ink-line">
          {ROLES.map((entry, i) => {
            const config = models.find((m) => m.role === entry.role);
            // A model the provider has retired reads as healthy on every screen
            // and fails every generation. Said on the row, where somebody is
            // already looking at their models, rather than in a log.
            const stale = config ? staleModel(config) : null;
            return (
              <IndexedRow
                key={entry.role}
                index={i + 1}
                label={entry.label}
                title={config ? config.model : 'Not set'}
                meta={stale ?? (config ? `${config.providerLabel} · ${config.provider}` : entry.hint)}
                status={stale ? <span className="chip border-signal-fail/40 text-signal-fail">unavailable</span> : undefined}
                onClick={() => openEditor(entry.role)}
              />
            );
          })}
        </div>
      )}

      <Modal open={Boolean(editing)} onClose={() => setEditing(null)} title={ROLES.find((r) => r.role === editing)?.label ?? 'Model'}>
        <div className="space-y-5">
          <Field label="Provider" htmlFor="mprovider">
            <select id="mprovider" className="field" value={providerId} onChange={(e) => setProviderId(e.target.value)}>
              <option value="">Select a provider</option>
              {providers.data?.items.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label} ({p.provider})
                </option>
              ))}
            </select>
          </Field>
          <Field label="Model" htmlFor="mmodel" hint={selected?.availableModels.length ? 'Suggestions come from the provider.' : 'Exactly as the provider names it.'}>
            <input id="mmodel" className="field" list="agent-model-options" value={model} onChange={(e) => setModel(e.target.value)} placeholder={selected?.defaultModel ?? 'model-id'} />
            <datalist id="agent-model-options">
              {selected?.availableModels.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Temperature" htmlFor="mtemp">
              <input id="mtemp" className="field" inputMode="decimal" value={temperature} onChange={(e) => setTemperature(e.target.value)} placeholder="0.7" />
            </Field>
            <Field
              label="Max tokens"
              htmlFor="mmax"
              hint="A reasoning model charges its thinking to this too. Leave room, or it runs out before the answer starts."
            >
              <input id="mmax" className="field" inputMode="numeric" value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} placeholder={editing === 'vision' ? '1500' : '300'} />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Field
              label="Price per 1k input tokens"
              htmlFor="mpricein"
              hint="In USD, as the provider lists it. Leave blank and calls are not costed."
            >
              <input id="mpricein" className="field" inputMode="decimal" value={priceIn} onChange={(e) => setPriceIn(e.target.value)} placeholder="0.003" />
            </Field>
            <Field label="Price per 1k output tokens" htmlFor="mpriceout" hint="Usually the higher of the two.">
              <input id="mpriceout" className="field" inputMode="decimal" value={priceOut} onChange={(e) => setPriceOut(e.target.value)} placeholder="0.015" />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Attempts" htmlFor="mretry" hint="Tries against this provider before the fallback takes over.">
              <input id="mretry" className="field" inputMode="numeric" value={maxRetries} onChange={(e) => setMaxRetries(e.target.value)} placeholder="2" />
            </Field>
            <Field label="Reasoning effort" htmlFor="mreason" hint="Reasoning models only. Ignored elsewhere.">
              <select id="mreason" className="field" value={reasoning} onChange={(e) => setReasoning(e.target.value)}>
                <option value="">Not set</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </Field>
          </div>
          {error && <p className="text-sm text-signal-fail">{error}</p>}
          <div className="flex gap-2">
            <button type="button" className="btn-primary flex-1" onClick={() => void save()} disabled={busy || !providerId || !model.trim()}>
              {busy && <Spinner />}
              Save
            </button>
            {editing && models.some((m) => m.role === editing) && (
              <button type="button" className="btn-danger" onClick={() => void remove(editing)}>
                Remove
              </button>
            )}
          </div>
        </div>
      </Modal>
    </Section>
  );
}
