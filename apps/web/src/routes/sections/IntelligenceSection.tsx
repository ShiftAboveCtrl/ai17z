import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, del, put } from '@app/lib/api';
import { useResource } from '@app/lib/hooks';
import type { ModelConfig, ProviderCredential } from '@app/lib/types';
import { EmptyState, Field, Modal, Spinner } from '@app/components/ui';
import { IndexedRow, Section } from './Section';

const ROLES = [
  { role: 'primary', label: 'Primary model', hint: 'Tried first for every generation.' },
  { role: 'fallback_1', label: 'Fallback', hint: 'Used when the primary fails or is unavailable.' },
  { role: 'fallback_2', label: 'Second fallback', hint: 'Last resort before the job retries later.' },
  { role: 'classifier', label: 'Cheap classifier', hint: 'Reserved for future classification steps.' },
] as const;

export function IntelligenceSection({
  index,
  agentId,
  models,
  onChanged,
}: {
  index: number;
  agentId: string;
  models: ModelConfig[];
  onChanged: () => void;
}) {
  const providers = useResource<{ items: ProviderCredential[] }>('/api/providers');
  const [editing, setEditing] = useState<(typeof ROLES)[number]['role'] | null>(null);
  const [providerId, setProviderId] = useState('');
  const [model, setModel] = useState('');
  const [temperature, setTemperature] = useState('');
  const [maxTokens, setMaxTokens] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openEditor = (role: (typeof ROLES)[number]['role']) => {
    const existing = models.find((m) => m.role === role);
    setProviderId(existing?.providerCredentialId ?? providers.data?.items[0]?.id ?? '');
    setModel(existing?.model ?? '');
    setTemperature(existing?.parameters.temperature != null ? String(existing.parameters.temperature) : '');
    setMaxTokens(existing?.parameters.maxTokens != null ? String(existing.parameters.maxTokens) : '');
    setError(null);
    setEditing(role);
  };

  const save = async () => {
    if (!editing) return;
    setBusy(true);
    setError(null);
    try {
      const parameters: Record<string, number> = {};
      if (temperature.trim()) parameters.temperature = Number(temperature);
      if (maxTokens.trim()) parameters.maxTokens = Number(maxTokens);
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

  return (
    <Section
      id="intelligence"
      index={index}
      eyebrow="Intelligence"
      heading="What it thinks with."
      lede="Providers are adapters. Swapping one changes nothing about the persona, the memory, or the pipeline, and every attempt is recorded whether it succeeded or not."
    >
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
            return (
              <IndexedRow
                key={entry.role}
                index={i + 1}
                label={entry.label}
                title={config ? config.model : 'Not set'}
                meta={config ? `${config.providerLabel} · ${config.provider}` : entry.hint}
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
            <Field label="Max tokens" htmlFor="mmax">
              <input id="mmax" className="field" inputMode="numeric" value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} placeholder="300" />
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
