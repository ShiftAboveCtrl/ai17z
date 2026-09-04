import { useState } from 'react';
import type { AgentTool } from '@app/lib/types';
import { ApiError, post, put } from '@app/lib/api';
import { useResource } from '@app/lib/hooks';
import { Field, Modal, Spinner } from '@app/components/ui';
import { IndexedRow, Section } from './Section';

interface ToolVerdict {
  key: string;
  state: 'READY' | 'BLOCKED' | 'OFF';
  summary: string;
  setting: string;
  fix: string | null;
  fixableInEasyMode: boolean;
  grant: { addToolToPolicyAllowlist: string } | { enableForAgent: string } | null;
}

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
  const [granting, setGranting] = useState<string | null>(null);
  const [grantError, setGrantError] = useState<string | null>(null);

  // Why each tool will or will not run, worked out by the API rather than
  // re-derived here and phrased differently.
  const diagnostics = useResource<{ readiness: ToolVerdict[] }>(`/api/agents/${agentId}/tools`);
  const readiness = diagnostics.data?.readiness ?? [];

  const allowTool = async (key: string) => {
    setGranting(key);
    setGrantError(null);
    try {
      await post(`/api/agents/${agentId}/tools/${encodeURIComponent(key)}/allow`, {});
      diagnostics.reload();
      onChanged();
    } catch (e) {
      setGrantError(e instanceof ApiError ? e.message : 'That could not be changed.');
    } finally {
      setGranting(null);
    }
  };

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
          const verdict = readiness.find((r) => r.key === tool.key);
          const live = verdict ? verdict.state === 'READY' : tool.enabled && allowedKeys.includes(tool.key);
          return (
            <IndexedRow
              key={tool.key}
              index={i + 1}
              label={tool.key}
              title={tool.name}
              meta={tool.description}
              status={
                <span className={`chip ${live ? 'border-signal-live/40 text-signal-live' : ''}`}>
                  {verdict ? verdict.state.toLowerCase() : tool.enabled ? 'enabled' : 'disabled'}
                </span>
              }
              onClick={() => open(tool)}
            />
          );
        })}
      </div>

      {/*
        "Blocked by policy" was the whole explanation, and it names no policy,
        no setting and nothing to do. Somebody reading it had already switched
        the tool on and was being told it was on and also not working.
      */}
      {readiness.filter((r) => r.state === 'BLOCKED').map((verdict) => (
        <div key={verdict.key} className="mt-6 rounded border border-signal-wait/40 bg-signal-wait/[0.06] p-4">
          <p className="text-sm text-bone">{verdict.summary}</p>
          <dl className="mt-3 space-y-1 text-[13px]">
            <div className="flex flex-wrap gap-2">
              <dt className="text-bone-faint">Setting</dt>
              <dd className="text-bone-dim">{verdict.setting}</dd>
            </div>
            {verdict.fix && (
              <div className="flex flex-wrap gap-2">
                <dt className="text-bone-faint">Fix</dt>
                <dd className="text-bone-dim">{verdict.fix}</dd>
              </div>
            )}
          </dl>
          {verdict.grant && 'addToolToPolicyAllowlist' in verdict.grant && (
            <button
              type="button"
              className="btn-ghost mt-3"
              disabled={granting !== null}
              onClick={() => void allowTool(verdict.key)}
            >
              {granting === verdict.key && <Spinner />}
              Allow {tools.find((t) => t.key === verdict.key)?.name ?? verdict.key} on this agent
            </button>
          )}
          <p className="mt-2 text-[11px] text-bone-faint">
            This adds only this tool to the allowlist. Nothing else about the policy changes.
          </p>
        </div>
      ))}

      {grantError && <p className="mt-4 text-sm text-signal-fail">{grantError}</p>}

      <p className="mt-6 max-w-2xl text-xs leading-relaxed text-bone-faint">
        A tool must be switched on here and permitted by this agent policy before the model is told it exists. Anything
        stopping that is spelled out above.
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
