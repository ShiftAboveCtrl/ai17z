import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowUpCircle,
  CheckCircle2,
  CircleSlash,
  Download,
  ExternalLink,
  HelpCircle,
  Package,
  Trash2,
} from 'lucide-react';
import type {
  CapabilityPermission,
  PluginConfigField,
  PluginOwnerPanel,
  PluginView,
} from '@xbam/shared/contracts';
import { del, get, post, put } from '@app/lib/api';
import { useResource } from '@app/lib/hooks';
import { ChoiceGroup, ChoiceOption, EmptyState, Field, RetryablePanel, Working } from '@app/components/ui';
import { AnimatedText, FadeIn } from '@app/components/motion';
import { Explain } from '@app/components/Explain';

/**
 * Plugins, as a place rather than a setting.
 *
 * Everything shown here is computed from the capability system: a Plugin's
 * state is the state of the permissions underneath it, and its readiness is a
 * fact about this minute. Nothing on this screen is stored separately, so
 * nothing on it can disagree with what the runtime will actually do.
 *
 * The distinctions are kept deliberately. Installed is not enabled, enabled is
 * not ready, ready is not offered, and offered is not used. A single "active"
 * badge would be shorter and would be a lie in four different ways.
 *
 * This is the canonical place an owner decides what an agent may reach for.
 * The agent's own page shows the same facts and sends people here to change
 * them, because two screens that both look authoritative about one setting is
 * how something ends up allowed on one and refused on the other.
 */

interface Agent {
  id: string;
  name: string;
}

interface RegistryState {
  url: string | null;
  key: { present: boolean; hint: string | null };
}

interface CatalogListing {
  id: string;
  name: string;
  summary: string;
  publisher: string;
  version: string;
  entitled: boolean;
}

interface Invocation {
  id: string;
  capabilityId: string;
  outcome: string;
  detail: string;
  durationMs: number;
  createdAt: string;
}

interface PanelView {
  pluginId: string;
  pluginName: string;
  panel: PluginOwnerPanel;
  runs: Invocation[];
}

type Tab = 'installed' | 'capabilities' | 'discover' | 'settings';

const STATE_WORD: Record<PluginView['state'], string> = {
  ON: 'On',
  OFF: 'Off',
  ASKS: 'Asks first',
  MIXED: 'Partly on',
};

const PERMISSION_WORD: Record<CapabilityPermission, string> = {
  ALLOWED: 'Allowed',
  OWNER_APPROVAL: 'Ask me',
  DISABLED: 'Off',
};

const FEATURE_WORD: Record<string, string> = {
  RESEARCH_SOURCE: 'Can be used as a research source',
  OWNER_PANEL: 'Has a panel of its own',
};

const when = (value: string) => new Date(value).toLocaleString();

/** One capability, as every surface on this page receives it. */
type PluginCapability = PluginView['capabilities'][number];

/**
 * One capability, with the switch that decides it.
 *
 * The switch writes `agent_capability_permissions` through the route the
 * agent's own page has always used. There is no Plugin permission store and
 * this is not a second one: a Plugin is on because its capabilities are.
 */
function CapabilityRow({
  capability,
  agentId,
  onChanged,
}: {
  capability: PluginCapability;
  agentId: string;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const icon =
    capability.status === 'AVAILABLE' ? (
      <CheckCircle2 className="h-3.5 w-3.5 text-signal-ok" />
    ) : capability.status === 'DISABLED' ? (
      <CircleSlash className="h-3.5 w-3.5 text-bone-faint" />
    ) : capability.status === 'OWNER_APPROVAL' ? (
      <HelpCircle className="h-3.5 w-3.5 text-signal-wait" />
    ) : (
      <AlertTriangle aria-hidden className="h-3.5 w-3.5 text-signal-wait" />
    );

  const set = async (permission: CapabilityPermission) => {
    setBusy(true);
    setProblem(null);
    try {
      await put(`/api/agents/${agentId}/toolspace/${capability.id}`, { permission });
      onChanged();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="py-2">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2">
          <span className="mt-0.5 shrink-0">{icon}</span>
          <div className="min-w-0 break-words">
            <div className="text-xs text-bone">
              {capability.name}
              <span className="ml-2 text-[11px] uppercase tracking-wide text-bone-faint">
                {capability.effect}
                {capability.effect === 'WRITE' ? ` / ${capability.risk}` : ''}
              </span>
              {!capability.modelCallable ? (
                <span className="ml-2 text-[11px] text-bone-faint">runtime only</span>
              ) : null}
            </div>
            <div className="text-[11px] text-bone-faint">{capability.description}</div>
            <div className="text-[11px] text-bone-faint">
              {capability.status === 'AVAILABLE'
                ? capability.lastUsedAt
                  ? `Ready. Last used ${when(capability.lastUsedAt)} (${capability.lastOutcome ?? 'no outcome'}).`
                  : 'Ready. Not used yet.'
                : (capability.why ?? capability.status)}
            </div>
          </div>
        </div>

        <Field label="Permission">
          <ChoiceGroup label="Permission" className="flex gap-1">
            {(['ALLOWED', 'OWNER_APPROVAL', 'DISABLED'] as CapabilityPermission[]).map((permission) => (
              <ChoiceOption
                key={permission}
                selected={capability.permission === permission}
                disabled={busy}
                onSelect={() => void set(permission)}
                className="px-2 py-0.5 text-[11px]"
              >
                {PERMISSION_WORD[permission]}
              </ChoiceOption>
            ))}
          </ChoiceGroup>
        </Field>
      </div>
      {problem ? <p className="mt-1 break-words text-[11px] text-signal-bad">{problem}</p> : null}
    </div>
  );
}

/**
 * What the owner still owes a Plugin before it can work.
 *
 * Drawn from the manifest the Plugin was installed with, which travels on the
 * same answer the readiness line came from. A secret is a write-only box: it
 * reports whether one is stored and never what it is, exactly as a provider
 * key does.
 */
function ConfigForm({
  plugin,
  agentId,
  onChanged,
}: {
  plugin: PluginView;
  agentId: string;
  onChanged: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  if (plugin.configFields.length === 0) return null;

  const present = new Set(plugin.secretsPresent);

  const save = async () => {
    setBusy(true);
    setProblem(null);
    setSaved(false);
    try {
      const config: Record<string, string | number | boolean | null> = {};
      for (const [key, value] of Object.entries(values)) config[key] = value.trim() === '' ? null : value;
      await put(`/api/agents/${agentId}/plugins/${plugin.id}/config`, { config, secrets });
      setValues({});
      setSecrets({});
      setSaved(true);
      onChanged();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const clearSecret = async (field: PluginConfigField) => {
    setBusy(true);
    setProblem(null);
    try {
      await put(`/api/agents/${agentId}/plugins/${plugin.id}/config`, { config: {}, secrets: { [field.key]: '' } });
      onChanged();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 rounded border border-ink-line p-3">
      <h4 className="text-xs font-medium text-bone">Setup for this agent</h4>
      <p className="mt-1 text-[11px] text-bone-faint">
        Configured per agent, because two agents on one machine are two different accounts as far as an API is
        concerned.
      </p>
      <div className="mt-3 space-y-3">
        {plugin.configFields.map((field) =>
          field.secret ? (
            <div key={field.key}>
              <Field label={`${field.label}${field.required ? '' : ' (optional)'}`} hint={field.help || undefined}>
                <input
                  type="password"
                  autoComplete="off"
                  value={secrets[field.key] ?? ''}
                  onChange={(event) => setSecrets((was) => ({ ...was, [field.key]: event.target.value }))}
                  placeholder={present.has(field.key) ? 'Stored. Paste a new one to replace it.' : 'Paste it here'}
                  className="w-full rounded border border-ink-line bg-ink-deep px-2 py-1 text-xs text-bone"
                />
              </Field>
              <p className="mt-1 text-[11px] text-bone-faint">
                {present.has(field.key)
                  ? 'Stored and sealed on this machine. It is never shown again and never leaves here.'
                  : 'Not set yet.'}
                {present.has(field.key) ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void clearSecret(field)}
                    className="ml-2 underline underline-offset-2 disabled:opacity-50"
                  >
                    Remove
                  </button>
                ) : null}
              </p>
            </div>
          ) : (
            <Field
              key={field.key}
              label={`${field.label}${field.required ? '' : ' (optional)'}`}
              hint={field.help || undefined}
            >
              <input
                value={values[field.key] ?? String(plugin.config[field.key] ?? '')}
                onChange={(event) => setValues((was) => ({ ...was, [field.key]: event.target.value }))}
                className="w-full rounded border border-ink-line bg-ink-deep px-2 py-1 text-xs text-bone"
              />
            </Field>
          ),
        )}
      </div>
      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          disabled={busy}
          onClick={() => void save()}
          className="rounded border border-ink-line px-3 py-1 text-xs text-bone hover:bg-ink-deep disabled:opacity-50"
        >
          Save setup
        </button>
        {saved ? <span className="text-[11px] text-signal-ok">Saved.</span> : null}
      </div>
      {problem ? <p className="mt-2 break-words text-[11px] text-signal-bad">{problem}</p> : null}
    </div>
  );
}

/**
 * A Plugin's own panel.
 *
 * Data, drawn by these components. A Plugin hands over a title, sentences,
 * which of its own capabilities to show runs for and links to hosts it already
 * declared. There is no markup, no template and nothing to execute, which is
 * the whole reason an owner panel is a safe thing for a third party to have.
 */
function OwnerPanel({ view }: { view: PanelView }) {
  return (
    <div className="mt-3 rounded border border-ink-line p-3">
      <h4 className="text-xs font-medium text-bone">{view.panel.title}</h4>
      {view.panel.body.map((line, at) => (
        <p key={at} className="mt-1 break-words text-[11px] text-bone-faint">
          {line}
        </p>
      ))}
      {view.runs.length > 0 ? (
        <ul className="mt-2 space-y-1 border-t border-ink-line pt-2">
          {view.runs.map((run) => (
            <li key={run.id} className="break-words text-[11px] text-bone-faint">
              {when(run.createdAt)} · {run.outcome} · {run.detail}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-[11px] text-bone-faint">Nothing has run yet.</p>
      )}
      {view.panel.links.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-3">
          {view.panel.links.map((link) => (
            <a
              key={link.url}
              href={link.url}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1 break-words text-[11px] text-bone-faint underline underline-offset-2"
            >
              {link.label} <ExternalLink aria-hidden className="h-3 w-3" />
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function PluginCard({
  plugin,
  agentId,
  panel,
  history,
  onChanged,
}: {
  plugin: PluginView;
  agentId: string | null;
  panel: PanelView | null;
  history: Invocation[];
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  /** What a newer version asks for that the installed one did not. */
  const [expansion, setExpansion] = useState<string[] | null>(null);

  const toggle = async (enabled: boolean) => {
    if (!agentId) return;
    setBusy(true);
    setProblem(null);
    try {
      await put(`/api/agents/${agentId}/plugins/${plugin.id}`, { enabled });
      onChanged();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const update = async (acknowledgeExpansion: boolean) => {
    setBusy(true);
    setProblem(null);
    try {
      const answer = await post<{ ok: boolean; why?: string; needsAcknowledgement?: string[] }>(
        '/api/plugins/registry/install',
        { id: plugin.id, acknowledgeExpansion },
      );
      if (answer.ok) {
        setExpansion(null);
        onChanged();
      } else if (answer.needsAcknowledgement && answer.needsAcknowledgement.length > 0) {
        // Not an error. The owner approved what the last manifest said, and
        // this one says something else, so they are asked again.
        setExpansion(answer.needsAcknowledgement);
        setProblem(answer.why ?? null);
      } else {
        setProblem(answer.why ?? 'It could not be updated.');
      }
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const answer = await del<{ ok: boolean; why?: string }>(`/api/plugins/${plugin.id}`);
      if (!answer.ok) setProblem(answer.why ?? 'It could not be removed.');
      onChanged();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const mine = history.filter((row) => plugin.capabilities.some((entry) => entry.id === row.capabilityId));

  return (
    <div className="rounded-lg border border-ink-line bg-ink-panel p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Package aria-hidden className="h-4 w-4 shrink-0 text-bone-faint" />
            <h3 className="truncate text-sm font-medium text-bone">{plugin.name}</h3>
            <span className="rounded bg-ink-deep px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-bone-faint">
              {plugin.source === 'BUILT_IN' ? 'Built in' : plugin.source === 'LOCAL' ? 'Installed' : 'Registry'}
            </span>
          </div>
          <p className="mt-1 break-words text-xs text-bone-faint">{plugin.summary}</p>
          <p className="mt-1 text-[11px] text-bone-faint">
            {plugin.publisher}
            {plugin.version ? ` · ${plugin.version}` : ''}
          </p>
          {plugin.features.length > 0 ? (
            <p className="mt-1 text-[11px] text-bone-faint">
              {plugin.features.map((feature) => FEATURE_WORD[feature] ?? feature).join(' · ')}
              {plugin.researchSourceName ? ` (as "${plugin.researchSourceName}")` : ''}
            </p>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <span className="text-xs text-bone-faint">{STATE_WORD[plugin.state]}</span>
          {agentId ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void toggle(plugin.state === 'OFF')}
              className="rounded border border-ink-line px-2 py-1 text-xs text-bone hover:bg-ink-deep disabled:opacity-50"
            >
              {plugin.state === 'OFF' ? 'Turn on' : 'Turn off'}
            </button>
          ) : null}
          {plugin.removable ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void remove()}
              title="Uninstall"
              aria-label={`Uninstall ${plugin.name}`}
              className="rounded border border-ink-line p-1 text-bone-faint hover:bg-ink-deep disabled:opacity-50"
            >
              <Trash2 aria-hidden className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      </div>

      {plugin.updateAvailable ? (
        <div className="mt-2 rounded border border-ink-line bg-ink-deep p-2">
          <p className="flex items-center gap-1.5 text-[11px] text-bone">
            <ArrowUpCircle className="h-3.5 w-3.5 shrink-0" />
            Version {plugin.updateAvailable} is available.
          </p>
          {expansion ? (
            <>
              <p className="mt-2 text-[11px] text-signal-wait">
                It asks for more than the version you approved:
              </p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                {expansion.map((line) => (
                  <li key={line} className="break-words text-[11px] text-signal-wait">
                    {line}
                  </li>
                ))}
              </ul>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void update(true)}
                  className="rounded border border-ink-line px-2 py-1 text-[11px] text-bone hover:bg-ink-panel disabled:opacity-50"
                >
                  Allow that and update
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setExpansion(null);
                    setProblem(null);
                  }}
                  className="rounded border border-ink-line px-2 py-1 text-[11px] text-bone-faint hover:bg-ink-panel disabled:opacity-50"
                >
                  Keep {plugin.version}
                </button>
              </div>
            </>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => void update(false)}
              className="mt-2 rounded border border-ink-line px-2 py-1 text-[11px] text-bone hover:bg-ink-panel disabled:opacity-50"
            >
              Update
            </button>
          )}
        </div>
      ) : null}

      {plugin.missingConfig.length > 0 ? (
        <p className="mt-2 rounded border border-signal-wait/40 bg-signal-wait/10 p-2 text-[11px] text-signal-wait">
          Still needs {plugin.missingConfig.join(' and ')} before it can run.
        </p>
      ) : null}
      {plugin.why ? <p className="mt-2 break-words text-[11px] text-signal-wait">{plugin.why}</p> : null}
      {problem && !expansion ? <p className="mt-2 break-words text-[11px] text-signal-bad">{problem}</p> : null}

      {plugin.hosts.length > 0 ? (
        <p className="mt-2 break-words text-[11px] text-bone-faint">
          Reaches {plugin.hosts.join(', ')}
          {plugin.quotaPerHour
            ? ` · up to ${plugin.quotaPerHour} calls an hour, ${plugin.callsThisHour ?? 0} used this hour`
            : ''}
        </p>
      ) : null}

      <button
        type="button"
        onClick={() => setOpen((was) => !was)}
        className="mt-3 text-[11px] text-bone-faint underline underline-offset-2"
      >
        {open ? 'Hide' : `${plugin.capabilities.length} capabilit${plugin.capabilities.length === 1 ? 'y' : 'ies'}`}
      </button>

      {open ? (
        <>
          <div className="mt-2 divide-y divide-ink-line border-t border-ink-line">
            {plugin.capabilities.map((capability) =>
              agentId ? (
                <CapabilityRow
                  key={capability.id}
                  capability={capability}
                  agentId={agentId}
                  onChanged={onChanged}
                />
              ) : null,
            )}
          </div>
          {agentId ? <ConfigForm plugin={plugin} agentId={agentId} onChanged={onChanged} /> : null}
          {panel ? <OwnerPanel view={panel} /> : null}
          <div className="mt-3 rounded border border-ink-line p-3">
            <h4 className="text-xs font-medium text-bone">Recent runs</h4>
            {mine.length === 0 ? (
              <p className="mt-1 text-[11px] text-bone-faint">
                Nothing yet. Registered is not offered, and offered is not used.
              </p>
            ) : (
              <ul className="mt-1 space-y-1">
                {mine.slice(0, 8).map((run) => (
                  <li key={run.id} className="break-words text-[11px] text-bone-faint">
                    {when(run.createdAt)} · {run.capabilityId} · {run.outcome} · {run.detail}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}

export function PluginsPage() {
  const [tab, setTab] = useState<Tab>('installed');
  /*
    `items`, which is what the route answers with.

    This read `agents` when the page was written, so the list was always
    undefined, no agent was ever chosen, and the Installed tab said "No agents
    yet" on an installation with agents. Nothing typed it, because the shape
    was written out by hand here rather than taken from the route.
  */
  const agents = useResource<{ items: Agent[] }>('/api/agents');
  const [agentId, setAgentId] = useState<string | null>(null);
  const list = agents.data?.items ?? [];
  const chosen = agentId ?? list[0]?.id ?? null;

  /** Updates are a separate ask, so the page does not wait on a registry. */
  const [checkUpdates, setCheckUpdates] = useState(false);
  const plugins = useResource<{ plugins: PluginView[]; core: PluginCapability[]; checkedForUpdates: boolean }>(
    chosen ? `/api/agents/${chosen}/plugins${checkUpdates ? '?updates=1' : ''}` : null,
    [chosen, checkUpdates],
  );
  const panels = useResource<{ panels: PanelView[] }>(chosen ? `/api/agents/${chosen}/plugins/panels` : null, [chosen]);
  const history = useResource<{ items: Invocation[] }>(
    chosen ? `/api/agents/${chosen}/toolspace/invocations` : null,
    [chosen],
  );
  const registry = useResource<RegistryState>('/api/plugins/registry');

  const reload = () => {
    plugins.reload();
    panels.reload();
    history.reload();
  };

  // What the eyebrow says, from the same answer every other surface reads.
  const core = plugins.data?.core ?? [];
  const total = (plugins.data?.plugins ?? []).reduce((n, plugin) => n + plugin.capabilities.length, 0) + core.length;

  return (
    /*
      The shell and the header every other top-level page uses.

      This page had invented both: `max-w-4xl px-4 py-8` and a plain small
      `h1`, against the `pt-24 sm:pt-28` shell and the eyebrow / monument
      heading / `Explain` that Home, Activity and Settings share. The header
      is `fixed` -- 67px on a desktop and 117px where it wraps to two rows --
      so a page opening with 32px of padding put its own title behind it.

      Taking the convention rather than patching a margin is what makes this
      clear the navigation at every width, and it is why the page now looks
      like the rest of the application instead of like a screen somebody
      added afterwards.

      `pt-32` below 640px rather than `pt-24`: that is where the navigation
      wraps to two rows and becomes 117px tall, which 96px of padding does not
      clear. Every page sharing this shell had the same overlap and it was
      only visible on a narrow window. `sm:pt-28` is unchanged, because from
      640px the navigation is one 67px row again.
    */
    <main className="mx-auto max-w-page px-6 pb-24 pt-32 sm:px-10 sm:pt-28">
      <header className="mb-8">
        <FadeIn>
          <p className="eyebrow mb-2">
            {total > 0 ? `${total} capabilit${total === 1 ? 'y' : 'ies'}` : 'Reading what is installed'}
            {core.length > 0 ? ` · ${core.length} in no Plugin` : ''}
          </p>
        </FadeIn>
        <AnimatedText
          as="h1"
          text="Plugins"
          className="monument text-[12vw] leading-[0.95] sm:text-[4.4vw] lg:text-[3.2rem]"
        />
        <Explain label="this page" className="mt-3">
          <p>
            <strong>What your agents can reach for.</strong> A Plugin is a group of capabilities: turning one on
            decides what may be offered, and each capability still answers for itself about whether it is ready.
          </p>
          <p>
            Installed shows the groups. All capabilities shows every one of them individually, including the few that
            belong to no group at all, with search and filters for finding one by name.
          </p>
        </Explain>
      </header>

      <div className="mb-5 flex flex-wrap items-center gap-2">
        {(['installed', 'capabilities', 'discover', 'settings'] as Tab[]).map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => setTab(name)}
            className={`rounded px-3 py-1.5 text-xs capitalize ${
              tab === name ? 'bg-ink-panel text-bone' : 'text-bone-faint hover:text-bone'
            }`}
          >
            {name}
          </button>
        ))}
        {list.length > 0 && (tab === 'installed' || tab === 'capabilities') ? (
          <label className="ml-auto flex items-center gap-2 text-[11px] text-bone-faint">
            Deciding for
            <select
              value={chosen ?? ''}
              onChange={(event) => setAgentId(event.target.value)}
              className="rounded border border-ink-line bg-ink-deep px-2 py-1 text-xs text-bone"
            >
              {list.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      {tab === 'installed' ? (
        <>
          {registry.data?.url ? (
            <div className="mb-3 flex flex-wrap items-center gap-2 text-[11px] text-bone-faint">
              <button
                type="button"
                onClick={() => setCheckUpdates(true)}
                disabled={checkUpdates}
                className="rounded border border-ink-line px-2 py-1 text-bone hover:bg-ink-deep disabled:opacity-50"
              >
                Check for updates
              </button>
              {checkUpdates && plugins.data ? (
                <span>
                  {plugins.data.checkedForUpdates
                    ? 'Checked against the registry.'
                    : 'The registry could not be reached, so nothing here says anything about updates.'}
                </span>
              ) : null}
            </div>
          ) : null}
          <InstalledTab
            resource={plugins}
            agentId={chosen}
            panels={panels.data?.panels ?? []}
            history={history.data?.items ?? []}
            onChanged={reload}
          />
        </>
      ) : tab === 'capabilities' ? (
        <AllCapabilities
          resource={plugins}
          agentId={chosen}
          history={history.data?.items ?? []}
          onChanged={reload}
        />
      ) : tab === 'discover' ? (
        <DiscoverTab registry={registry.data ?? null} onInstalled={reload} />
      ) : (
        <SettingsTab resource={registry} />
      )}
    </main>
  );
}

function InstalledTab({
  resource,
  agentId,
  panels,
  history,
  onChanged,
}: {
  resource: ReturnType<typeof useResource<{ plugins: PluginView[]; checkedForUpdates: boolean }>>;
  agentId: string | null;
  panels: PanelView[];
  history: Invocation[];
  onChanged: () => void;
}) {
  if (resource.loading && !resource.data) return <Working label="Reading what is installed" seconds={0} />;
  if (resource.error) return <RetryablePanel title="That did not load" detail={resource.error} onRetry={resource.reload} />;
  if (!agentId) {
    return <EmptyState title="No agents yet" detail="Plugins are decided per agent, so make an agent first." />;
  }
  const plugins = resource.data?.plugins ?? [];
  if (plugins.length === 0) {
    return <EmptyState title="Nothing installed" detail="The built-in Plugins should be here. Try reloading." />;
  }
  return (
    <div className="space-y-3">
      {plugins.map((plugin) => (
        <PluginCard
          key={plugin.id}
          plugin={plugin}
          agentId={agentId}
          panel={panels.find((entry) => entry.pluginId === plugin.id) ?? null}
          history={history}
          onChanged={onChanged}
        />
      ))}
    </div>
  );
}

function DiscoverTab({ registry, onInstalled }: { registry: RegistryState | null; onInstalled: () => void }) {
  const [search, setSearch] = useState('');
  const [listings, setListings] = useState<CatalogListing[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [manifest, setManifest] = useState('');
  /** The manifest about to be approved, shown before anything is installed. */
  const [preview, setPreview] = useState<{ id: string; manifest: string; sha: string } | null>(null);
  const [expansion, setExpansion] = useState<{ id: string; lines: string[] } | null>(null);

  const browse = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const answer = await get<{ ok: boolean; plugins?: CatalogListing[]; why?: string }>(
        `/api/plugins/catalog${search.trim() ? `?q=${encodeURIComponent(search.trim())}` : ''}`,
      );
      if (answer.ok) setListings(answer.plugins ?? []);
      else {
        setListings(null);
        setProblem(answer.why ?? 'The catalogue could not be read.');
      }
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const look = async (id: string) => {
    setBusy(true);
    setProblem(null);
    try {
      const answer = await get<{ ok: boolean; manifest?: string; manifestSha256?: string; why?: string }>(
        `/api/plugins/catalog/${encodeURIComponent(id)}`,
      );
      if (answer.ok && answer.manifest) {
        setPreview({ id, manifest: answer.manifest, sha: answer.manifestSha256 ?? '' });
      } else setProblem(answer.why ?? 'That could not be read.');
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const installFromRegistry = async (id: string, acknowledgeExpansion: boolean) => {
    setBusy(true);
    setProblem(null);
    try {
      const answer = await post<{ ok: boolean; why?: string; needsAcknowledgement?: string[] }>(
        '/api/plugins/registry/install',
        { id, acknowledgeExpansion },
      );
      if (answer.ok) {
        setPreview(null);
        setExpansion(null);
        onInstalled();
      } else if (answer.needsAcknowledgement?.length) {
        setExpansion({ id, lines: answer.needsAcknowledgement });
        setProblem(answer.why ?? null);
      } else setProblem(answer.why ?? 'It could not be installed.');
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const installFromFile = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const answer = await post<{ ok: boolean; why?: string; needsAcknowledgement?: string[] }>(
        '/api/plugins/install',
        { manifest },
      );
      if (answer.ok) {
        setManifest('');
        onInstalled();
      } else if (answer.needsAcknowledgement?.length) {
        setProblem(
          `${answer.why ?? ''} ${answer.needsAcknowledgement.join(' ')} Install it again to accept that.`.trim(),
        );
      } else setProblem(answer.why ?? 'It could not be installed.');
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <section className="rounded-lg border border-ink-line bg-ink-panel p-4">
        <h2 className="text-sm font-medium text-bone">The AI17Z registry</h2>
        {registry?.url ? (
          <>
            <p className="mt-1 break-words text-xs text-bone-faint">Reading from {registry.url}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search the catalogue"
                className="min-w-0 flex-1 rounded border border-ink-line bg-ink-deep px-2 py-1 text-xs text-bone"
              />
              <button
                type="button"
                disabled={busy}
                onClick={() => void browse()}
                className="rounded border border-ink-line px-3 py-1 text-xs text-bone hover:bg-ink-deep disabled:opacity-50"
              >
                Browse
              </button>
            </div>
          </>
        ) : (
          <p className="mt-1 text-xs text-bone-faint">
            No registry is configured, so there is nothing to browse yet. A Plugin file can still be installed below.
            Set an address under Settings.
          </p>
        )}
        {problem ? <p className="mt-2 break-words text-[11px] text-signal-wait">{problem}</p> : null}
        {listings?.length === 0 ? <p className="mt-2 text-xs text-bone-faint">Nothing matched.</p> : null}
        {listings && listings.length > 0 ? (
          <ul className="mt-3 space-y-2">
            {listings.map((listing) => (
              <li key={listing.id} className="rounded border border-ink-line p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-xs text-bone">
                      {listing.name}{' '}
                      <span className="text-bone-faint">
                        {listing.publisher} · {listing.version}
                        {listing.entitled ? ' · needs a key' : ''}
                      </span>
                    </p>
                    <p className="mt-0.5 break-words text-[11px] text-bone-faint">{listing.summary}</p>
                  </div>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void look(listing.id)}
                    className="flex shrink-0 items-center gap-1 rounded border border-ink-line px-2 py-1 text-xs text-bone hover:bg-ink-deep disabled:opacity-50"
                  >
                    <Download aria-hidden className="h-3 w-3" /> Look at it
                  </button>
                </div>

                {preview?.id === listing.id ? (
                  <div className="mt-3 border-t border-ink-line pt-3">
                    <p className="text-[11px] text-bone-faint">
                      This is exactly what would be approved, and its checksum was checked against what the registry
                      published.
                    </p>
                    <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border border-ink-line bg-ink-deep p-2 font-mono text-[10px] text-bone-faint">
                      {preview.manifest}
                    </pre>
                    {expansion?.id === listing.id ? (
                      <>
                        <p className="mt-2 text-[11px] text-signal-wait">
                          It asks for more than the version you approved:
                        </p>
                        <ul className="mt-1 list-disc space-y-0.5 pl-4">
                          {expansion.lines.map((line) => (
                            <li key={line} className="break-words text-[11px] text-signal-wait">
                              {line}
                            </li>
                          ))}
                        </ul>
                      </>
                    ) : null}
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void installFromRegistry(listing.id, expansion?.id === listing.id)}
                        className="rounded border border-ink-line px-3 py-1 text-xs text-bone hover:bg-ink-deep disabled:opacity-50"
                      >
                        {expansion?.id === listing.id ? 'Allow that and install' : 'Install'}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          setPreview(null);
                          setExpansion(null);
                        }}
                        className="rounded border border-ink-line px-3 py-1 text-xs text-bone-faint hover:bg-ink-deep disabled:opacity-50"
                      >
                        Not now
                      </button>
                    </div>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="rounded-lg border border-ink-line bg-ink-panel p-4">
        <h2 className="text-sm font-medium text-bone">Install from a file</h2>
        <p className="mt-1 text-xs text-bone-faint">
          Paste a Plugin manifest. It is checked against what this version understands before anything is registered,
          and refused outright if it is not.
        </p>
        <textarea
          value={manifest}
          onChange={(event) => setManifest(event.target.value)}
          rows={6}
          placeholder='{ "schemaVersion": 1, "id": "example", ... }'
          className="mt-2 w-full rounded border border-ink-line bg-ink-deep p-2 font-mono text-[11px] text-bone"
        />
        <button
          type="button"
          disabled={busy || manifest.trim().length < 2}
          onClick={() => void installFromFile()}
          className="mt-2 rounded border border-ink-line px-3 py-1 text-xs text-bone hover:bg-ink-deep disabled:opacity-50"
        >
          Install
        </button>
      </section>
    </div>
  );
}

function SettingsTab({ resource }: { resource: ReturnType<typeof useResource<RegistryState>> }) {
  const [url, setUrl] = useState<string | null>(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  if (resource.loading && !resource.data) return <Working label="Reading registry settings" seconds={0} />;
  if (resource.error) return <RetryablePanel title="That did not load" detail={resource.error} onRetry={resource.reload} />;
  const current = resource.data;

  const save = async (body: { url?: string | null; key?: string | null }) => {
    setBusy(true);
    setProblem(null);
    setSaved(false);
    try {
      const answer = await put<{ ok?: boolean; why?: string }>('/api/plugins/registry', body);
      if (answer.ok === false) {
        setProblem(answer.why ?? 'That was not accepted.');
        return;
      }
      setKey('');
      setSaved(true);
      resource.reload();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <section className="rounded-lg border border-ink-line bg-ink-panel p-4">
        <h2 className="text-sm font-medium text-bone">Registry address</h2>
        <p className="mt-1 text-xs text-bone-faint">
          Where to look for Plugins. It has to be https, because a catalogue fetched over http is one somebody on the
          path chooses. AI17Z ships no default address, so until you set one there is nothing to browse and installing
          from a file still works.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <input
            value={url ?? current?.url ?? ''}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://..."
            className="min-w-0 flex-1 rounded border border-ink-line bg-ink-deep px-2 py-1 text-xs text-bone"
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => void save({ url: (url ?? current?.url ?? '').trim() || null })}
            className="rounded border border-ink-line px-3 py-1 text-xs text-bone hover:bg-ink-deep disabled:opacity-50"
          >
            Save
          </button>
        </div>
        {saved ? <p className="mt-2 text-[11px] text-signal-ok">Saved.</p> : null}
      </section>

      <section className="rounded-lg border border-ink-line bg-ink-panel p-4">
        <h2 className="text-sm font-medium text-bone">Registry key</h2>
        <p className="mt-1 text-xs text-bone-faint">
          Optional. Public Plugins need no key. One is only for private or entitled Plugins, and it is kept sealed on
          this machine the same way a provider key is. It is never shown again after it is saved.
        </p>
        <p className="mt-2 text-xs text-bone">
          {current?.key.present
            ? `A key is stored${current.key.hint ? `, ending ${current.key.hint}` : ''}.`
            : 'No key stored.'}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <input
            value={key}
            onChange={(event) => setKey(event.target.value)}
            type="password"
            autoComplete="off"
            placeholder="Paste a key"
            className="min-w-0 flex-1 rounded border border-ink-line bg-ink-deep px-2 py-1 text-xs text-bone"
          />
          <button
            type="button"
            disabled={busy || key.trim().length === 0}
            onClick={() => void save({ key: key.trim() })}
            className="rounded border border-ink-line px-3 py-1 text-xs text-bone hover:bg-ink-deep disabled:opacity-50"
          >
            Save key
          </button>
          {current?.key.present ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void save({ key: null })}
              className="rounded border border-ink-line px-3 py-1 text-xs text-bone-faint hover:bg-ink-deep disabled:opacity-50"
            >
              Remove
            </button>
          ) : null}
        </div>
        {problem ? <p className="mt-2 break-words text-[11px] text-signal-bad">{problem}</p> : null}
      </section>

      <p className="text-[11px] text-bone-faint">
        Looking for one capability rather than a Plugin? Open a Plugin above and each capability has its own switch.{' '}
        <Link to="/" className="underline underline-offset-2">
          Agents
        </Link>
      </p>
    </div>
  );
}

/**
 * Every capability the agent has, in one list.
 *
 * Grouping seventy capabilities into six Plugins is the right product answer
 * and it is not a complete one: an owner also has to be able to find one
 * capability by name, see which Plugin holds it, and change it. Three of them
 * belong to no Plugin at all -- the clock, the agent's own memory, and its own
 * health -- and grouping is exactly what made those disappear from the only
 * screen that manages any of this.
 *
 * Nothing here is a second source of truth. Every row is a capability from the
 * same answer the cards are drawn from, and the switch writes the same
 * permission row, through the same route the agent's own page has always used.
 */
function AllCapabilities({
  resource,
  agentId,
  history,
  onChanged,
}: {
  resource: ReturnType<typeof useResource<{ plugins: PluginView[]; core: PluginCapability[]; checkedForUpdates: boolean }>>;
  agentId: string | null;
  history: Invocation[];
  onChanged: () => void;
}) {
  const [search, setSearch] = useState('');
  const [owner, setOwner] = useState('all');
  const [effect, setEffect] = useState<'all' | 'READ' | 'WRITE'>('all');
  const [state, setState] = useState<'all' | 'on' | 'off'>('all');
  const [ready, setReady] = useState<'all' | 'ready' | 'not'>('all');

  if (resource.loading && !resource.data) return <Working label="Reading every capability" seconds={0} />;
  if (resource.error) {
    return <RetryablePanel title="That did not load" detail={resource.error} onRetry={resource.reload} />;
  }
  if (!agentId) {
    return <EmptyState title="No agents yet" detail="Capabilities are decided per agent, so make an agent first." />;
  }

  const plugins = resource.data?.plugins ?? [];
  const core = resource.data?.core ?? [];

  /*
    Every capability, each labelled with what holds it.

    `Core` is not a Plugin and is not presented as one: it is the word for the
    ones that belong to none, so that a complete list can stay complete
    without inventing a seventh group to hide the mismatch in.
  */
  const rows: { capability: PluginCapability; ownerId: string; ownerName: string }[] = [
    ...plugins.flatMap((plugin) =>
      plugin.capabilities.map((capability) => ({ capability, ownerId: plugin.id, ownerName: plugin.name })),
    ),
    ...core.map((capability) => ({ capability, ownerId: 'core', ownerName: 'Core' })),
  ];

  const owners = [
    ...plugins.map((plugin) => ({ id: plugin.id, name: plugin.name })),
    ...(core.length > 0 ? [{ id: 'core', name: 'Core' }] : []),
  ];

  const needle = search.trim().toLowerCase();
  const shown = rows.filter(({ capability, ownerId }) => {
    if (needle && !`${capability.id} ${capability.name} ${capability.description}`.toLowerCase().includes(needle)) {
      return false;
    }
    if (owner !== 'all' && ownerId !== owner) return false;
    if (effect !== 'all' && capability.effect !== effect) return false;
    // "On" is anything the agent may actually reach for, which includes the
    // ones that ask first. Off is off.
    if (state === 'on' && capability.permission === 'DISABLED') return false;
    if (state === 'off' && capability.permission !== 'DISABLED') return false;
    if (ready === 'ready' && capability.status !== 'AVAILABLE') return false;
    if (ready === 'not' && capability.status === 'AVAILABLE') return false;
    return true;
  });

  const select = 'rounded border border-ink-line bg-ink-deep px-2 py-1 text-xs text-bone';

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-ink-line bg-ink-panel p-4">
        <p className="text-xs text-bone-faint">
          Every capability this agent has, whichever Plugin holds it. {rows.length} in total, {core.length} of them in
          no Plugin.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search name, id or description"
            aria-label="Search capabilities"
            className="min-w-0 flex-1 rounded border border-ink-line bg-ink-deep px-2 py-1 text-xs text-bone"
          />
          <select aria-label="Plugin" value={owner} onChange={(e) => setOwner(e.target.value)} className={select}>
            <option value="all">Every Plugin</option>
            {owners.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
          <select
            aria-label="Reads or writes"
            value={effect}
            onChange={(e) => setEffect(e.target.value as 'all' | 'READ' | 'WRITE')}
            className={select}
          >
            <option value="all">Reads and writes</option>
            <option value="READ">Reads only</option>
            <option value="WRITE">Writes only</option>
          </select>
          <select
            aria-label="Whether it may"
            value={state}
            onChange={(e) => setState(e.target.value as 'all' | 'on' | 'off')}
            className={select}
          >
            <option value="all">On and off</option>
            <option value="on">On or asking</option>
            <option value="off">Off</option>
          </select>
          <select
            aria-label="Whether it can run"
            value={ready}
            onChange={(e) => setReady(e.target.value as 'all' | 'ready' | 'not')}
            className={select}
          >
            <option value="all">Ready or not</option>
            <option value="ready">Ready</option>
            <option value="not">Cannot run yet</option>
          </select>
        </div>
        <p className="mt-2 text-[11px] text-bone-faint">
          Showing {shown.length} of {rows.length}.
        </p>
      </div>

      {shown.length === 0 ? (
        <EmptyState title="Nothing matched" detail="No capability matches those filters. Try widening one." />
      ) : (
        <div className="divide-y divide-ink-line rounded-lg border border-ink-line bg-ink-panel">
          {shown.map(({ capability, ownerId, ownerName }) => (
            <div key={capability.id} className="px-4">
              <p className="pt-3 text-[11px] text-bone-faint">
                {ownerName}
                {ownerId === 'core' ? ' · in no Plugin' : ''} · <span className="font-mono">{capability.id}</span>
                {history.some((run) => run.capabilityId === capability.id)
                  ? ` · used ${history.filter((run) => run.capabilityId === capability.id).length} time(s) recently`
                  : ''}
              </p>
              <CapabilityRow capability={capability} agentId={agentId} onChanged={onChanged} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
