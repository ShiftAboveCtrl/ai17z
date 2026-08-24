import { useState } from 'react';
import type { AgentTool } from '@app/lib/types';
import { ApiError, put } from '@app/lib/api';
import { Field, Modal, Spinner } from '@app/components/ui';
import { IndexedRow, Section } from './Section';

export function ToolsSection({
  index,
  agentId,
  tools,
  allowedKeys,
  onChanged,
}: {
  index: number;
  agentId: string;
  tools: AgentTool[];
  allowedKeys: string[];
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState<AgentTool | null>(null);
  const [allowedHosts, setAllowedHosts] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = (tool: AgentTool) => {
    const hosts = Array.isArray(tool.config.allowedHosts) ? (tool.config.allowedHosts as string[]) : [];
    setAllowedHosts(hosts.join(', '));
    setError(null);
    setEditing(tool);
  };

  const save = async (enabled: boolean) => {
    if (!editing) return;
    setBusy(true);
    setError(null);
    try {
      await put(`/api/agents/${agentId}/tools/${editing.key}`, {
        enabled,
        config:
          editing.kind === 'HTTP'
            ? { allowedHosts: allowedHosts.split(',').map((h) => h.trim()).filter(Boolean) }
            : editing.config,
      });
      setEditing(null);
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That tool could not be updated.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      id="tools"
      index={index}
      eyebrow="Tools"
      heading="What it can reach."
      lede="Tools are opt-in per agent, and a tool that can reach the network stays inert until you give it an explicit host allowlist."
    >
      <div className="border-b border-ink-line">
        {tools.map((tool, i) => {
          const live = tool.enabled && allowedKeys.includes(tool.key);
          return (
            <IndexedRow
              key={tool.key}
              index={i + 1}
              label={tool.key}
              title={tool.name}
              meta={tool.description}
              status={
                <span className={`chip ${live ? 'border-signal-live/40 text-signal-live' : ''}`}>
                  {tool.enabled ? (live ? 'enabled' : 'blocked by policy') : 'disabled'}
                </span>
              }
              onClick={() => open(tool)}
            />
          );
        })}
      </div>
      <p className="mt-6 max-w-2xl text-xs leading-relaxed text-bone-faint">
        A tool must be enabled here and also listed in the agent policy tool allowlist before the model is told it
        exists. Both states are shown above.
      </p>

      <Modal open={Boolean(editing)} onClose={() => setEditing(null)} title={editing?.name ?? 'Tool'}>
        {editing && (
          <div className="space-y-5">
            <p className="text-sm leading-relaxed text-bone-dim">{editing.description}</p>
            {editing.kind === 'HTTP' && (
              <Field
                label="Allowed hosts"
                htmlFor="hosts"
                hint="Comma separated. Subdomains of a listed host are permitted. Without at least one host this tool refuses every request."
              >
                <input id="hosts" className="field" value={allowedHosts} onChange={(e) => setAllowedHosts(e.target.value)} placeholder="example.com, docs.example.com" />
              </Field>
            )}
            {error && <p className="text-sm text-signal-fail">{error}</p>}
            <div className="flex gap-2">
              <button type="button" className="btn-primary flex-1" onClick={() => void save(true)} disabled={busy}>
                {busy && <Spinner />}
                Enable
              </button>
              <button type="button" className="btn-ghost" onClick={() => void save(false)} disabled={busy}>
                Disable
              </button>
            </div>
          </div>
        )}
      </Modal>
    </Section>
  );
}
