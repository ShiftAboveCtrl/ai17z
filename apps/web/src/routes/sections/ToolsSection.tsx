import { useState } from 'react';
import type { PolicyConfig } from '@xbam/shared/contracts';
import type { AgentTool } from '@app/lib/types';
import { ApiError, post, put } from '@app/lib/api';
import { useResource } from '@app/lib/hooks';
import { Field, Modal, Spinner } from '@app/components/ui';
import { IndexedRow, Section } from './Section';

interface ToolVerdict {
  key: string;
  state: 'READY' | 'BLOCKED' | 'OFF';
  /** Whether anything actually uses it, which is not the same as being on. */
  supply: 'RUNTIME_SUPPLIES' | 'ANOTHER_LAYER' | 'NOTHING_CALLS_IT';
  says: string;
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
  policy,
  onChanged,
}: {
  index: number;
  agentId: string;
  tools: AgentTool[];
  allowedKeys: string[];
  policy: PolicyConfig | null;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState<AgentTool | null>(null);
  const [allowedHosts, setAllowedHosts] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [granting, setGranting] = useState<string | null>(null);
  const [grantError, setGrantError] = useState<string | null>(null);
  const [lookupBusy, setLookupBusy] = useState<string | null>(null);

  /**
   * Turning one lookup source off.
   *
   * Written as a policy change rather than a tool row because that is what it
   * is: research is not a tool the model chooses, it is a step the runtime
   * decides to take. A source that is off is still reported to the model as a
   * gap, so the agent says it does not know rather than inventing an answer.
   */
  const setLookupSource = async (source: 'web' | 'market' | 'xIntelligence', enabled: boolean) => {
    if (!policy) return;
    setLookupBusy(source);
    setGrantError(null);
    const named = { web: 'web search', market: 'market lookups', xIntelligence: 'searching X itself' }[source];
    try {
      await put(`/api/agents/${agentId}/policy`, {
        config: { ...policy, tools: { ...policy.tools, research: { ...policy.tools.research, [source]: enabled } } },
        changeNote: `${enabled ? 'allowed' : 'stopped'} ${named}`,
      });
      onChanged();
    } catch (e) {
      setGrantError(e instanceof ApiError ? e.message : 'That could not be saved.');
    } finally {
      setLookupBusy(null);
    }
  };

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
              meta={verdict?.says ? `${tool.description} ${verdict.says}` : tool.description}
              status={
                <span className="flex flex-wrap items-center justify-end gap-1.5">
                  <span className={`chip ${live ? 'border-signal-live/40 text-signal-live' : ''}`}>
                    {verdict ? verdict.state.toLowerCase() : tool.enabled ? 'enabled' : 'disabled'}
                  </span>
                  {/* On is not the same as used. A tool nothing calls says so
                      rather than sitting there looking ready. */}
                  {verdict?.supply === 'NOTHING_CALLS_IT' && (
                    <span className="chip border-signal-warn/40 text-signal-warn">nothing calls it</span>
                  )}
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

      {/*
        The thing this screen used to leave unsaid.

        Switching a tool on and permitting it in the policy is two decisions,
        and the screen explained both. Neither of them makes anything call the
        tool, and until now the prompt listed every enabled one under "tools
        available" -- so a model was told it could check things it could not,
        and answered as though it had.
      */}
      {readiness.some((r) => r.state === 'READY' && r.supply === 'NOTHING_CALLS_IT') && (
        <p className="mt-6 max-w-2xl break-words rounded-lg border border-signal-warn/40 bg-signal-warn/5 p-3 text-[13px] leading-relaxed text-signal-warn">
          Some of these are switched on and permitted, and nothing in AI17Z calls them. The agent does not choose
          tools: the runtime looks things up itself, before the reply is written, and hands over what it found. Leaving
          one on does no harm and does nothing.
        </p>
      )}

      {grantError && <p className="mt-4 text-sm text-signal-fail">{grantError}</p>}

      {/*
        Looking things up is not a tool the model chooses. It is a step the
        runtime takes when the question depends on something current, which is
        why it has its own switches here rather than a row in the list above.
      */}
      {policy && (
        <div className="mt-10 border-t border-ink-line pt-8">
          <p className="eyebrow">Looking things up</p>
          <h4 className="mt-2 text-base font-light text-bone">Where it may check before answering</h4>
          <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-bone-faint">
            An agent asked about a post from an hour ago cannot answer from a training set, and one asked anyway
            invents something. The first two are on because of that. Switching one off does not make the agent guess:
            it is told the answer was not looked up, and says it does not know. The third is off because it spends
            money on your own provider key every time it runs.
          </p>

          <div className="mt-5 space-y-3">
            {(
              [
                ['web', 'Search the web', 'Through the browser it is already running, for anything that changes by the day.'],
                ['market', 'Look up market data', 'For a contract address or a ticker. The price of a token, and which token it is.'],
                [
                  'xIntelligence',
                  'Search X itself',
                  'Asks the provider to search X’s own index during the call — the one source a browser cannot reach. Costs money on every lookup, needs a Research model under Intelligence, and is off until you turn it on.',
                ],
              ] as const
            ).map(([source, label, hint]) => {
              const on = policy.tools.research[source];
              return (
                <button
                  key={source}
                  type="button"
                  role="switch"
                  aria-checked={on}
                  aria-label={label}
                  disabled={lookupBusy === source}
                  onClick={() => void setLookupSource(source, !on)}
                  className="flex w-full items-start gap-3 rounded-lg border border-ink-line px-3 py-2.5 text-left transition-colors hover:border-bone-faint disabled:opacity-50"
                >
                  <span
                    className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] ${
                      on ? 'border-signal-calm/60 bg-signal-calm/25 text-signal-calm' : 'border-ink-line'
                    }`}
                    aria-hidden
                  >
                    {on ? '✓' : ''}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[13px] text-bone">{label}</span>
                    <span className="mt-0.5 block text-xs leading-relaxed text-bone-faint">{hint}</span>
                  </span>
                  {lookupBusy === source && <Spinner />}
                </button>
              );
            })}
          </div>

          <p className="mt-4 max-w-2xl text-xs leading-relaxed text-bone-faint">
            How many lookups one message may cause is a limit rather than a switch, and lives with the other limits
            under Policies.
          </p>
        </div>
      )}

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
