import { useEffect, useState } from 'react';
import { ApiError, put } from '@app/lib/api';
import { useResource } from '@app/lib/hooks';
import { timeAgo } from '@app/lib/format';
import { ErrorPanel, Field, SavedTick, Spinner, Toggle } from './ui';

interface CadenceConfig {
  polling: {
    enabled: boolean;
    intervalSeconds: number;
    jitterPercent: number;
    batchLimit: number;
    backoffWhenIdle: boolean;
    maxIntervalSeconds: number;
  };
  acting: { maxActionsPerHour: number; maxActionsPerDay: number; minSecondsBetweenActions: number };
  quietHours: { enabled: boolean; timezone: string; startHour: number; endHour: number };
}

interface CadenceData {
  config: CadenceConfig;
  customised: boolean;
  versions: { id: string; version: number; changeNote: string; createdAt: string }[];
  state: { lastPolledAt: string | null; nextPollAt: string | null; emptyPollStreak: number } | null;
}

/** "in 4 min", or "now" for anything already due. */
function until(iso: string | null): string {
  if (!iso) return 'not scheduled';
  const seconds = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  if (seconds <= 0) return 'now';
  if (seconds < 90) return `in ${seconds}s`;
  if (seconds < 5_400) return `in ${Math.round(seconds / 60)} min`;
  return `in ${Math.round(seconds / 3_600)} h`;
}

/**
 * Cadence: how often this account is read from, and what ceilings it puts on
 * every agent using it. Timing used to be one environment variable shared by
 * every account, which meant it could not be seen or changed from here at all.
 */
export function CadencePanel({ accountId }: { accountId: string }) {
  const { data, error, loading, reload } = useResource<CadenceData>(`/api/accounts/${accountId}/cadence`);
  const [draft, setDraft] = useState<CadenceConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (data) setDraft(structuredClone(data.config));
  }, [data]);

  if (loading && !data) return <Spinner />;
  if (error) return <ErrorPanel title="Cadence could not be loaded." detail={error} />;
  if (!data || !draft) return null;

  const set = (patch: (next: CadenceConfig) => void) => {
    const next = structuredClone(draft);
    patch(next);
    setDraft(next);
  };
  const dirty = JSON.stringify(draft) !== JSON.stringify(data.config);

  const save = async () => {
    setBusy(true);
    setSaveError(null);
    try {
      await put(`/api/accounts/${accountId}/cadence`, { config: draft, changeNote: '' });
      setSaved(true);
      setTimeout(() => setSaved(false), 2400);
      reload();
    } catch (e) {
      setSaveError(e instanceof ApiError ? e.message : 'That cadence could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  const emptyStreak = data.state?.emptyPollStreak ?? 0;

  return (
    <div className="space-y-5 rounded-lg border border-ink-line bg-ink-panel/60 p-4">
      <div className="flex items-baseline justify-between gap-3">
        <p className="eyebrow">Cadence</p>
        <span className="font-mono text-[10px] text-bone-faint">
          {data.customised ? `v${data.versions[0]?.version ?? 1}` : 'defaults'}
        </span>
      </div>

      {/* The live schedule, so the numbers below have something to explain. */}
      <div className="grid grid-cols-3 gap-3 rounded-lg border border-ink-line px-3.5 py-3">
        <Stat label="Last read" value={timeAgo(data.state?.lastPolledAt ?? null)} />
        <Stat label="Next read" value={until(data.state?.nextPollAt ?? null)} />
        <Stat
          label="Quiet runs"
          value={String(emptyStreak)}
          hint={draft.polling.backoffWhenIdle && emptyStreak > 0 ? 'backing off' : undefined}
        />
      </div>

      <Toggle
        checked={draft.polling.enabled}
        onChange={(v) =>
          set((n) => {
            n.polling.enabled = v;
          })
        }
        label="Read this account for new events"
        description="Off leaves the connection intact but stops looking for anything to respond to."
      />

      {draft.polling.enabled && (
        <div className="grid gap-4 sm:grid-cols-2">
          <NumberField
            id="cadint"
            label="Check every"
            hint="Seconds between reads while there is activity."
            min={15}
            max={86_400}
            value={draft.polling.intervalSeconds}
            onChange={(v) =>
              set((n) => {
                n.polling.intervalSeconds = v;
              })
            }
          />
          <NumberField
            id="cadbatch"
            label="Events per check"
            hint="How many are pulled in one read."
            min={1}
            max={100}
            value={draft.polling.batchLimit}
            onChange={(v) =>
              set((n) => {
                n.polling.batchLimit = v;
              })
            }
          />
          <NumberField
            id="cadjit"
            label="Spread"
            hint="Percent of random variation on each gap. A metronome is a distinctive pattern; this is not."
            min={0}
            max={50}
            value={draft.polling.jitterPercent}
            onChange={(v) =>
              set((n) => {
                n.polling.jitterPercent = v;
              })
            }
          />
          <NumberField
            id="cadmax"
            label="Slowest gap"
            hint="Ceiling the idle backoff will not pass."
            min={15}
            max={86_400}
            value={draft.polling.maxIntervalSeconds}
            onChange={(v) =>
              set((n) => {
                n.polling.maxIntervalSeconds = v;
              })
            }
          />
          <div className="sm:col-span-2">
            <Toggle
              checked={draft.polling.backoffWhenIdle}
              onChange={(v) =>
                set((n) => {
                  n.polling.backoffWhenIdle = v;
                })
              }
              label="Slow down when nothing is happening"
              description="Doubles the gap after each empty read, up to the ceiling, and resets the moment something arrives."
            />
          </div>
        </div>
      )}

      <div className="border-t border-ink-line pt-4">
        <Toggle
          checked={draft.quietHours.enabled}
          onChange={(v) =>
            set((n) => {
              n.quietHours.enabled = v;
            })
          }
          label="Active hours only"
          description="Outside these hours the account is neither read from nor allowed to act."
        />
        {draft.quietHours.enabled && (
          <div className="mt-3 grid gap-4 sm:grid-cols-3">
            <NumberField
              id="cadstart"
              label="From"
              min={0}
              max={23}
              value={draft.quietHours.startHour}
              onChange={(v) =>
                set((n) => {
                  n.quietHours.startHour = v;
                })
              }
            />
            <NumberField
              id="cadend"
              label="To"
              hint="Overnight windows are allowed."
              min={0}
              max={23}
              value={draft.quietHours.endHour}
              onChange={(v) =>
                set((n) => {
                  n.quietHours.endHour = v;
                })
              }
            />
            <Field label="Timezone" htmlFor="cadtz">
              <input
                id="cadtz"
                className="field"
                value={draft.quietHours.timezone}
                onChange={(e) =>
                  set((n) => {
                    n.quietHours.timezone = e.target.value;
                  })
                }
                placeholder="UTC"
              />
            </Field>
          </div>
        )}
      </div>

      <div className="border-t border-ink-line pt-4">
        <p className="text-xs leading-relaxed text-bone-faint">
          Ceilings for this account, shared by every agent that posts through it. Zero means the account sets no limit
          of its own and only the agent policy applies. Whichever is tighter wins, and the job says which one stopped
          it.
        </p>
        <div className="mt-3 grid gap-4 sm:grid-cols-3">
          <NumberField
            id="cadhr"
            label="Max per hour"
            min={0}
            value={draft.acting.maxActionsPerHour}
            onChange={(v) =>
              set((n) => {
                n.acting.maxActionsPerHour = v;
              })
            }
          />
          <NumberField
            id="cadday"
            label="Max per day"
            min={0}
            value={draft.acting.maxActionsPerDay}
            onChange={(v) =>
              set((n) => {
                n.acting.maxActionsPerDay = v;
              })
            }
          />
          <NumberField
            id="cadgap"
            label="Seconds between"
            min={0}
            value={draft.acting.minSecondsBetweenActions}
            onChange={(v) =>
              set((n) => {
                n.acting.minSecondsBetweenActions = v;
              })
            }
          />
        </div>
      </div>

      {saveError && <p className="text-sm text-signal-fail">{saveError}</p>}

      <div className="flex items-center gap-3">
        <button type="button" className="btn-ghost" onClick={() => void save()} disabled={busy || !dirty}>
          {busy && <Spinner className="h-3.5 w-3.5" />}
          Save as version
        </button>
        <SavedTick visible={saved} />
        {dirty && !busy && <span className="text-xs text-bone-faint">unsaved</span>}
      </div>
    </div>
  );
}

function NumberField({
  id,
  label,
  hint,
  min,
  max,
  value,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  min: number;
  max?: number;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <Field label={label} htmlFor={id} hint={hint}>
      <input
        id={id}
        type="number"
        min={min}
        max={max}
        className="field"
        value={value}
        // An empty box is 0 rather than NaN, which would fail validation with a
        // message about the wrong field.
        onChange={(e) => onChange(Number(e.target.value) || 0)}
      />
    </Field>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-bone-faint">{label}</p>
      <p className="mt-1 text-sm text-bone">{value}</p>
      {hint && <p className="text-[10px] text-signal-wait">{hint}</p>}
    </div>
  );
}
