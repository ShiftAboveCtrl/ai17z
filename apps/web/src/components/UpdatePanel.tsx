import { useEffect, useState } from 'react';
import { Download, ExternalLink, RefreshCw } from 'lucide-react';
import { ApiError, get, post, put } from '@app/lib/api';
import { timeAgo } from '@app/lib/format';
import { ErrorPanel, Spinner, StatusDot, Toggle } from '@app/components/ui';
import { ReleaseNotes } from '@app/components/ReleaseNotes';

interface ReleaseInfo {
  version: string;
  tag: string;
  name: string;
  channel: string | null;
  notes: string;
  url: string;
  installerUrl: string | null;
  setupUrl: string | null;
  publishedAt: string;
  prerelease: boolean;
}

export interface UpdateState {
  current: string;
  currentName: string;
  latest: ReleaseInfo | null;
  updateAvailable: boolean;
  skipped: string | null;
  enabled: boolean;
  checkedAt: string | null;
  error: string | null;
  method: 'INSTALLER' | 'BOOTSTRAP' | 'CHECKOUT';
  installation: {
    name: string | null;
    programDir: string | null;
    channel: 'INSTALLER' | 'BOOTSTRAP' | 'CHECKOUT';
  };
}

/**
 * What taking this update actually involves, for the way this copy was
 * installed.
 *
 * Three layouts, three different true answers, and the screen says the one that
 * applies rather than the one that applies most often. Offering "download the
 * installer" to a checkout is how somebody ends up with two AI17Zs.
 */
const HOW_TO_UPDATE: Record<UpdateState['method'], { action: string; detail: string }> = {
  BOOTSTRAP: {
    action: 'Update AI17Z',
    detail:
      'Open "Update AI17Z" in the Start Menu group for this installation. It stops this copy, fetches the new version, checks it against its published hash, applies any database migrations and starts it again. Your agents, memories, provider keys and browser session are in your data folder and are not touched.',
  },
  INSTALLER: {
    action: 'Download the installer',
    detail:
      'Run the installer over this copy. Your agents, memories, provider keys and settings are in your data folder and are not touched.',
  },
  CHECKOUT: {
    action: 'Read the release',
    detail:
      'This is a checkout, so the update is a pull. Run .\\update-ai17z.ps1, which stops the stack, fetches, migrates and starts it again.',
  },
};

/**
 * Updates, and the fact that nobody is being made to take one.
 *
 * AI17Z does not replace itself. This asks GitHub what has been released,
 * shows the notes, and offers a link -- which means an owner can read what
 * changed before deciding, can say "not now" by doing nothing, can say "never
 * this one", and can turn the whole thing off. An installation that updates
 * itself while somebody's agent is mid-conversation is worse than one that is
 * a version behind.
 */
export function UpdatePanel() {
  const [state, setState] = useState<UpdateState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async (fn: () => Promise<UpdateState>, label: string) => {
    setBusy(label);
    setError(null);
    try {
      setState(await fn());
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The update check could not be read.');
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    void load(() => get<UpdateState>('/api/updates'), 'load');
  }, []);

  if (!state) {
    return (
      <p className="flex items-center gap-2 text-sm text-bone-dim">
        {busy === 'load' && <Spinner />}
        {error ?? 'Looking up what version this is...'}
      </p>
    );
  }

  const latest = state.latest;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <StatusDot state={state.updateAvailable ? 'wait' : 'live'} />
        {/*
          The name first and the number after it, in a smaller face. Both are
          shown because they answer different questions: "AI17Z Beta 1.0.0" is
          what somebody downloaded, and `1.0.0-beta.1` is what they quote in a bug
          report.
        */}
        <span className="text-sm text-bone">{state.currentName}</span>
        <span className="font-mono text-xs text-bone-faint">v{state.current}</span>
        {/*
          The installation's own name, for a machine running more than one. It
          costs three words here and saves somebody updating the wrong copy.
        */}
        {state.installation?.name && (
          <span className="eyebrow text-bone-faint">{state.installation.name}</span>
        )}
        <span className="text-sm text-bone-dim">
          {!state.enabled
            ? 'Update checking is off. Nothing is sent anywhere.'
            : state.updateAvailable
              ? `${latest?.name} is available.`
              : state.error
                ? 'Could not reach GitHub.'
                : 'This is the newest version.'}
        </span>
        {state.enabled && (
          <button
            type="button"
            className="btn-quiet ml-auto text-xs"
            onClick={() => void load(() => post<UpdateState>('/api/updates/check', {}), 'check')}
            disabled={busy !== null}
          >
            {busy === 'check' ? <Spinner className="h-3 w-3" /> : <RefreshCw className="h-3 w-3" aria-hidden />}
            Check now
          </button>
        )}
      </div>

      {state.error && state.enabled && (
        // Not a fault of this installation, and not something to fix. A machine
        // that is offline is a machine that is offline.
        <p className="break-words text-xs text-bone-faint">
          {state.error}. AI17Z carries on working; this only means it cannot say whether a newer version exists.
        </p>
      )}

      {state.updateAvailable && latest && (
        <div className="space-y-4 border border-ink-line bg-ink-raise/40 p-4">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h3 className="text-base text-bone">{latest.name}</h3>
            {/*
              The channel it is actually on, not the word "release candidate"
              for everything with a dash in its version. A beta labelled as a
              candidate reads as more finished than it is.
            */}
            {latest.prerelease && (
              <span className="eyebrow text-signal-wait">{latest.channel ?? 'prerelease'}</span>
            )}
            <span className="font-mono text-xs text-bone-faint">v{latest.version}</span>
            <span className="text-xs text-bone-faint">published {timeAgo(latest.publishedAt)}</span>
          </div>

          <ReleaseNotes markdown={latest.notes} />

          <div className="flex flex-wrap items-center gap-3">
            {state.method === 'INSTALLER' && latest.installerUrl ? (
              <a className="btn-primary" href={latest.installerUrl} target="_blank" rel="noreferrer">
                <Download className="h-4 w-4" aria-hidden />
                {HOW_TO_UPDATE.INSTALLER.action}
              </a>
            ) : (
              <a className="btn-primary" href={latest.url} target="_blank" rel="noreferrer">
                <ExternalLink className="h-4 w-4" aria-hidden />
                Read the release
              </a>
            )}
            <button
              type="button"
              className="btn-quiet text-xs"
              onClick={() => void load(() => post<UpdateState>('/api/updates/skip', { version: latest.version }), 'skip')}
              disabled={busy !== null}
            >
              {busy === 'skip' && <Spinner className="h-3 w-3" />}
              Skip this version
            </button>
          </div>

          {/*
            Which installation this is.

            A machine can hold several, each serving its own copy of this
            screen, and each with its own agents and its own database. An update
            screen that cannot say which copy it belongs to is one that will
            eventually be used on the wrong one -- so it says, every time, and
            it says it next to the button rather than somewhere else.
          */}
          {state.installation?.name && (
            <p className="break-words text-xs text-bone-faint">
              This updates <span className="text-bone">{state.installation.name}</span>
              {state.installation.programDir ? (
                <>
                  {' '}
                  in <span className="font-mono">{state.installation.programDir}</span>
                </>
              ) : null}
              . Any other AI17Z on this machine is left exactly as it is.
            </p>
          )}

          {/*
            The phases an update goes through, named the same way the setup
            program names them, so somebody who has installed AI17Z once
            recognises what they are looking at. Not a progress bar: nothing
            here runs the update, and a bar that cannot move is worse than a
            sentence that tells the truth.
          */}
          {state.method === 'BOOTSTRAP' && (
            <p className="break-words text-xs text-bone-faint">
              Preparing, downloading, verifying, updating, starting, checking. AI17Z stays where it is
              until the download has been checked against its published hash; if it does not match,
              nothing is replaced.
            </p>
          )}

          <p className="break-words text-xs text-bone-faint">{HOW_TO_UPDATE[state.method].detail}</p>
        </div>
      )}

      {state.skipped && (
        <p className="text-xs text-bone-faint">
          v{state.skipped} was skipped and will not be mentioned again. A newer one still will.
        </p>
      )}

      <Toggle
        checked={state.enabled}
        onChange={(enabled) => void load(() => put<UpdateState>('/api/updates/enabled', { enabled }), 'enabled')}
        label="Check GitHub for new versions"
        description="Once every six hours at most, and only while this screen or the app is open. Off means no request is made at all. Nothing about you or your agents is ever sent."
      />

      {state.checkedAt && state.enabled && (
        <p className="text-xs text-bone-faint">Last checked {timeAgo(state.checkedAt)}.</p>
      )}

      {error && (
        <ErrorPanel
          title="The update check could not be read."
          detail={error}
          actions={
            <button
              type="button"
              className="btn-quiet text-xs"
              onClick={() => void load(() => get<UpdateState>('/api/updates'), 'load')}
            >
              Try again
            </button>
          }
        />
      )}
    </div>
  );
}
