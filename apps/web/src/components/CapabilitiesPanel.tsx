import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { ApiError, put } from '@app/lib/api';
import { useResource } from '@app/lib/hooks';
import { SavedTick, Spinner } from './ui';

type Capability = string;

interface ProfileChoice {
  name: string;
  label: string;
  summary: string;
  grants: string[];
  leaves: string[];
}

interface CapabilityData {
  vocabulary: Capability[];
  grants: Record<string, Capability[]>;
  /** What the grants on each account currently amount to, in one word. */
  profiles: Record<string, string>;
  catalogue: ProfileChoice[];
}

/** What each capability actually permits, in the second person. */
const EXPLAIN: Record<string, string> = {
  READ: 'See events arriving on this account.',
  GENERATE: 'Draft a response. Needed even for a dry run.',
  REPLY: 'Reply to someone.',
  POST: 'Publish a post of its own.',
  DIRECT_MESSAGE: 'Send a direct message.',
  LIKE: 'Like a post.',
  REACT: 'React to a message.',
  CALL_TOOL: 'Run one of its tools.',
  CALL_API: 'Call an external API.',
};

/**
 * Per-account permissions for one agent.
 *
 * These are grants, not preferences: the same set is checked when an event
 * arrives and again immediately before the action is executed, so revoking one
 * here stops a job that is already queued.
 */
export function CapabilitiesPanel({
  agentId,
  accountId,
  handle,
  actionType,
}: {
  agentId: string;
  accountId: string;
  handle: string;
  actionType: string;
}) {
  const { data, error, loading, reload } = useResource<CapabilityData>(`/api/agents/${agentId}/capabilities`);
  const [draft, setDraft] = useState<Capability[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (data) setDraft([...(data.grants[accountId] ?? [])]);
  }, [data, accountId]);

  if (loading && !data) return <Spinner />;
  if (error || !data || !draft) return null;

  const current = data.grants[accountId] ?? [];
  const dirty = [...draft].sort().join() !== [...current].sort().join();

  const toggle = (capability: Capability) =>
    setDraft(draft.includes(capability) ? draft.filter((c) => c !== capability) : [...draft, capability]);

  const save = async () => {
    setBusy(true);
    setSaveError(null);
    try {
      await put(`/api/agents/${agentId}/accounts/${accountId}/capabilities`, { capabilities: draft });
      setSaved(true);
      setTimeout(() => setSaved(false), 2400);
      reload();
    } catch (e) {
      setSaveError(e instanceof ApiError ? e.message : 'Those permissions could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  // The link says what the agent will attempt; the grants say what it may do.
  // When they disagree the agent is silently mute, which is worth saying out loud.
  const muted = !draft.includes(actionType) && actionType !== 'NONE';
  const cannotRead = !draft.includes('READ');

  const profile = data.profiles?.[accountId] ?? 'CUSTOM';
  const chosen = data.catalogue?.find((entry) => entry.name === profile) ?? null;

  const setProfile = async (name: string) => {
    setBusy(true);
    setSaveError(null);
    try {
      await put(`/api/agents/${agentId}/accounts/${accountId}/profile`, { profile: name });
      setSaved(true);
      setTimeout(() => setSaved(false), 2400);
      reload();
    } catch (e) {
      setSaveError(e instanceof ApiError ? e.message : 'That could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4 rounded-lg border border-ink-line bg-ink-panel/60 p-4">
      <div className="flex items-baseline justify-between gap-3">
        <p className="eyebrow">Permissions</p>
        <span className="font-mono text-[10px] text-bone-faint">@{handle}</span>
      </div>

      <p className="text-xs leading-relaxed text-bone-faint">
        Checked when an event arrives and again before the action runs, so removing one here stops work that is
        already queued.
      </p>

      {/*
        Four answers before nine boxes. Choosing one writes permissions and
        nothing else: it never re-enables a tool, widens what triggers the
        agent, or changes whether replies are held for review.
      */}
      {data.catalogue && (
        <div className="space-y-2">
          {data.catalogue.map((entry) => {
            const on = entry.name === profile;
            return (
              <button
                key={entry.name}
                type="button"
                role="radio"
                aria-checked={on}
                disabled={busy}
                onClick={() => void setProfile(entry.name)}
                className={`flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                  on ? 'border-signal-calm/50 bg-signal-calm/[0.07]' : 'border-ink-line hover:border-bone-faint'
                } disabled:opacity-50`}
              >
                <span
                  className={`mt-1 h-2 w-2 shrink-0 rounded-full ${on ? 'bg-signal-calm' : 'bg-ink-line'}`}
                  aria-hidden
                />
                <span className="min-w-0">
                  <span className="block text-[13px] text-bone">{entry.label}</span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-bone-faint">{entry.summary}</span>
                </span>
              </button>
            );
          })}

          {profile === 'CUSTOM' && (
            <p className="text-xs leading-relaxed text-bone-faint">
              These permissions do not match any of the above. That is fine, and choosing one will replace them.
            </p>
          )}

          {/* What it will not touch, said before the button is pressed rather
              than discovered afterwards. */}
          {chosen && (
            <p className="text-xs leading-relaxed text-bone-faint">
              Leaves alone: {chosen.leaves.join('. ')}.
            </p>
          )}
        </div>
      )}

      <button
        type="button"
        className="btn-quiet px-2 py-1 text-[11px]"
        onClick={() => setExpanded((was) => !was)}
        aria-expanded={expanded}
      >
        {expanded ? 'Hide individual permissions' : 'Set individual permissions'}
      </button>

      <ul className={expanded ? 'space-y-1' : 'hidden'}>
        {data.vocabulary.map((capability) => {
          const on = draft.includes(capability);
          return (
            <li key={capability}>
              <button
                type="button"
                role="switch"
                aria-checked={on}
                aria-label={capability}
                onClick={() => toggle(capability)}
                className="flex w-full items-start gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-white/[0.02]"
              >
                <span
                  className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] transition-colors ${
                    on ? 'border-signal-calm/60 bg-signal-calm/25 text-signal-calm' : 'border-ink-line'
                  }`}
                  aria-hidden
                >
                  {on ? '✓' : ''}
                </span>
                <span className="min-w-0">
                  <span className="block font-mono text-[11px] uppercase tracking-[0.14em] text-bone">
                    {capability.replace(/_/g, ' ')}
                    {capability === actionType && (
                      <span className="ml-2 rounded bg-white/[0.06] px-1.5 py-0.5 text-[9px] tracking-normal text-bone-faint">
                        what it does here
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-bone-faint">
                    {EXPLAIN[capability] ?? capability}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {expanded && (muted || cannotRead) && (
        <p className="flex items-start gap-2 rounded-lg border border-signal-wait/40 bg-signal-wait/[0.06] px-3 py-2.5 text-xs leading-relaxed text-bone-dim">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-signal-wait" aria-hidden />
          <span>
            {cannotRead
              ? `Without READ this agent will not see anything arriving on @${handle}.`
              : `This link responds with ${actionType}, which is not granted. The agent will read @${handle} and stay silent.`}
          </span>
        </p>
      )}

      {saveError && <p className="text-sm text-signal-fail">{saveError}</p>}

      <div className={expanded ? 'flex items-center gap-3' : 'hidden'}>
        <button type="button" className="btn-ghost" onClick={() => void save()} disabled={busy || !dirty}>
          {busy && <Spinner className="h-3.5 w-3.5" />}
          Save permissions
        </button>
        {dirty && !busy && <span className="text-xs text-bone-faint">unsaved</span>}
      </div>

      <SavedTick visible={saved} />
    </div>
  );
}
