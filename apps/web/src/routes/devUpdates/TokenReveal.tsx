import { useId, useState } from 'react';
import { KeyRound } from 'lucide-react';
import { transportBase } from '@app/lib/transport';
import { MCP_SERVER_FILE, apiUrlFrom, commandState, type DevUpdateConnection } from '@app/lib/devUpdates';
import { CopyButton } from './parts';

/**
 * A sender token, shown once, and the command that hands it over.
 *
 * The token lives in the state of whoever rendered this, and only for as long
 * as this is on screen: closing it, leaving the tab, switching project or
 * leaving the page unmounts that state and the token with it. It is never put
 * in local storage, a URL or a log. The server keeps only its hash, so a lost
 * token is answered with a new one.
 *
 * A command is offered only when it will work. If the installation cannot say
 * where its MCP server is (it runs in a container, or the file is missing), the
 * owner is asked for the path on their own machine first.
 */
export function TokenReveal({
  token,
  projectKey,
  projectName,
  connection,
  connectionError,
  onDone,
  doneLabel = 'I have copied it, hide it',
}: {
  token: string;
  projectKey: string;
  projectName: string;
  connection: DevUpdateConnection | null;
  connectionError: string | null;
  onDone: () => void;
  doneLabel?: string;
}) {
  const [localPath, setLocalPath] = useState('');
  const pathId = useId();
  const hintId = useId();
  const state = commandState({
    connection,
    localPath,
    apiUrl: apiUrlFrom(transportBase(), window.location.origin),
    token,
    projectKey,
  });

  return (
    <section aria-labelledby={`${pathId}-title`} className="space-y-5 rounded-xl border border-signal-calm/40 bg-signal-calm/[0.05] p-4 sm:p-5">
      <div className="space-y-1.5">
        <h3 id={`${pathId}-title`} className="flex items-center gap-2 text-[15px] font-medium text-bone">
          <KeyRound className="h-4 w-4 text-signal-calm" aria-hidden /> Copy this now. It is shown once.
        </h3>
        <p className="text-[13px] leading-relaxed text-bone-dim">
          AI17Z keeps only a fingerprint of it, so if you lose it you issue a new one. Anyone holding it can send updates
          for {projectName}, but cannot approve or post anything.
        </p>
      </div>

      <div className="space-y-2">
        <p className="eyebrow text-bone-dim">Connect your coding assistant</p>
        {!connection ? (
          <p className="break-words text-sm text-signal-fail" role="alert">
            The command could not be prepared: {connectionError ?? 'this installation did not answer.'}
          </p>
        ) : state.problem ? (
          <p className="break-words text-sm text-signal-fail" role="alert">
            {state.problem}
          </p>
        ) : (
          <>
            {state.needsLocalPath && (
              <div className="space-y-2 rounded-lg border border-signal-wait/30 bg-signal-wait/[0.04] px-3.5 py-3">
                <p className="break-words text-[13px] leading-relaxed text-bone-dim">
                  {state.installPathUnsafe
                    ? 'This installation keeps its MCP server at a path with characters a terminal could treat as part of a command, so it is not put into one.'
                    : connection.reason}
                </p>
                <label htmlFor={pathId} className="block text-[13px] text-bone">
                  Where is {MCP_SERVER_FILE} on the machine you code on?
                </label>
                <input
                  id={pathId}
                  className="field font-mono text-sm [font-variant-ligatures:none]"
                  value={localPath}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="C:\AI17Z\tools\dev-updates-mcp.mjs"
                  aria-describedby={hintId}
                  aria-invalid={state.pathProblem ? true : undefined}
                  onChange={(e) => setLocalPath(e.target.value)}
                />
                <p id={hintId} className={`break-words text-xs leading-relaxed ${state.pathProblem ? 'text-signal-fail' : 'text-bone-dim'}`}>
                  {state.pathProblem ??
                    'It is in the tools folder of any copy of AI17Z. The command appears once the path is complete.'}
                </p>
              </div>
            )}
            {state.command ? (
              <>
                <p className="text-[13px] text-bone-dim">Run this in a terminal, in the folder of the project. It is the command for Claude Code.</p>
                <pre className="whitespace-pre-wrap break-all rounded-lg border border-ink-line bg-ink px-3.5 py-3 font-mono text-[12px] leading-relaxed text-bone [font-variant-ligatures:none]">
                  {state.command}
                </pre>
                <CopyButton value={state.command} label="Copy command" />
                <p className="text-xs leading-relaxed text-bone-dim">
                  Local scope keeps the token in your own settings, out of the repository. Then ask your coding assistant to
                  share an update when something is finished.
                </p>
              </>
            ) : null}
          </>
        )}
      </div>

      <div className="space-y-2">
        <p className="eyebrow text-bone-dim">The token on its own</p>
        <code className="block break-all rounded-lg border border-ink-line bg-ink px-3.5 py-3 font-mono text-[12px] text-bone [font-variant-ligatures:none]">
          {token}
        </code>
        <CopyButton value={token} label="Copy token" />
      </div>

      <div className="flex justify-end">
        <button type="button" className="btn-ghost" onClick={onDone}>
          {doneLabel}
        </button>
      </div>
    </section>
  );
}
