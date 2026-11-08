import { useState } from 'react';
import { KeyRound, ShieldOff } from 'lucide-react';
import { del, post } from '@app/lib/api';
import { timeAgo } from '@app/lib/format';
import { transportBase } from '@app/lib/transport';
import { Modal } from '@app/components/ui';
import { apiUrlFrom, mcpAddCommand, type DevUpdateConnection, type DevUpdateProject } from '@app/lib/devUpdates';
import { CopyButton, ProblemList, problemOf } from './parts';

/**
 * The sender token, and the one command that hands it to Claude Code.
 *
 * The token exists in the browser only in component state, for as long as this
 * screen is open and the owner has not said they are done with it: never in
 * localStorage, never in a URL, never in a log. The server keeps only its hash,
 * so once it is hidden it is gone, and the answer to a lost token is a new one.
 */
export function Connect({
  project,
  connection,
  connectionError,
  freshToken,
  onIssued,
  onForget,
  onChanged,
}: {
  project: DevUpdateProject;
  connection: DevUpdateConnection | null;
  connectionError: string | null;
  freshToken: string | null;
  onIssued: (token: string) => void;
  onForget: () => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<'issue' | 'revoke' | null>(null);
  const [problem, setProblem] = useState<string[] | null>(null);
  const [confirm, setConfirm] = useState<'replace' | 'revoke' | null>(null);
  const active = project.senderToken.active;

  const issue = async () => {
    setConfirm(null);
    setBusy('issue');
    setProblem(null);
    try {
      const result = await post<{ senderToken: string }>(`/api/dev-updates/projects/${project.id}/sender-token`);
      onIssued(result.senderToken);
      onChanged();
    } catch (error) {
      setProblem(problemOf(error, 'A new token could not be issued.'));
    } finally {
      setBusy(null);
    }
  };

  const revoke = async () => {
    setConfirm(null);
    setBusy('revoke');
    setProblem(null);
    try {
      await del(`/api/dev-updates/projects/${project.id}/sender-token`);
      onForget();
      onChanged();
    } catch (error) {
      setProblem(problemOf(error, 'The token could not be revoked.'));
    } finally {
      setBusy(null);
    }
  };

  const apiUrl = apiUrlFrom(transportBase(), window.location.origin);
  const serverPath = connection?.mcpServerPath ?? null;
  const command =
    freshToken && connection
      ? mcpAddCommand({
          serverName: connection.serverName,
          apiUrl,
          token: freshToken,
          projectKey: project.projectKey,
          serverPath: serverPath ?? '<path to tools/dev-updates-mcp.mjs>',
        })
      : null;

  return (
    <div className="space-y-6">
      {freshToken ? (
        <section
          aria-labelledby="token-reveal"
          className="space-y-5 rounded-xl border border-signal-calm/40 bg-signal-calm/[0.05] p-4 sm:p-5"
        >
          <div className="space-y-1.5">
            <h3 id="token-reveal" className="flex items-center gap-2 text-[15px] font-medium text-bone">
              <KeyRound className="h-4 w-4 text-signal-calm" aria-hidden /> Copy this now. It is shown once.
            </h3>
            <p className="text-[13px] leading-relaxed text-bone-dim">
              AI17Z keeps only a fingerprint of it, so if you lose it you issue a new one. Anyone holding it can send
              updates for {project.displayName}, but cannot approve or post anything.
            </p>
          </div>

          <div className="space-y-2">
            <p className="eyebrow text-bone-dim">Run this where you use Claude Code</p>
            {command ? (
              <pre className="whitespace-pre-wrap break-all rounded-lg border border-ink-line bg-ink px-3.5 py-3 font-mono text-[12px] leading-relaxed text-bone [font-variant-ligatures:none]">
                {command}
              </pre>
            ) : (
              <p className="break-words text-sm text-signal-fail" role="alert">
                The command could not be prepared: {connectionError ?? 'this installation did not answer.'}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-3">
              {command && <CopyButton value={command} label="Copy command" />}
            </div>
            {connection?.reason && <p className="break-words text-xs leading-relaxed text-signal-wait">{connection.reason}</p>}
            <p className="text-xs leading-relaxed text-bone-dim">
              Run it inside the project folder. Local scope keeps the token in your own Claude Code settings, out of the
              repository. Then ask Claude Code to share an update when something is finished.
            </p>
          </div>

          <div className="space-y-2">
            <p className="eyebrow text-bone-dim">The token on its own</p>
            <code className="block break-all rounded-lg border border-ink-line bg-ink px-3.5 py-3 font-mono text-[12px] text-bone [font-variant-ligatures:none]">
              {freshToken}
            </code>
            <CopyButton value={freshToken} label="Copy token" />
          </div>

          <div className="flex justify-end">
            <button type="button" className="btn-ghost" onClick={onForget}>
              I have copied it, hide it
            </button>
          </div>
        </section>
      ) : null}

      <section aria-labelledby="token-state" className="panel space-y-4 p-4 sm:p-5">
        <div className="space-y-1.5">
          <h3 id="token-state" className="text-[15px] font-medium text-bone">
            Sender token
          </h3>
          {active ? (
            <p className="break-words text-[13px] leading-relaxed text-bone-dim">
              A token ending in <span className="font-mono text-bone">{project.senderToken.hint}</span> is active, issued{' '}
              {timeAgo(project.senderToken.issuedAt)}. Your coding assistant can send updates with it. Lost it, or
              connecting another machine? Replace it to get a fresh command to paste.
            </p>
          ) : (
            <p className="text-[13px] leading-relaxed text-bone-dim">
              No token is active, so your coding assistant cannot send anything for this project. Issue one to connect it.
            </p>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={active ? 'btn-ghost' : 'btn-primary'}
            disabled={busy !== null}
            onClick={() => (active ? setConfirm('replace') : void issue())}
          >
            <KeyRound className="h-4 w-4" aria-hidden />
            {busy === 'issue' ? 'Issuing…' : active ? 'Replace the token' : 'Issue a token'}
          </button>
          {active && (
            <button type="button" className="btn-danger" disabled={busy !== null} onClick={() => setConfirm('revoke')}>
              <ShieldOff className="h-4 w-4" aria-hidden />
              {busy === 'revoke' ? 'Revoking…' : 'Revoke'}
            </button>
          )}
        </div>
        <ProblemList lines={problem} />
      </section>

      <Modal
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirm === 'revoke' ? 'Revoke the token?' : 'Replace the token?'}
      >
        <div className="space-y-5">
          <p className="text-sm leading-relaxed text-bone-dim">
            {confirm === 'revoke'
              ? 'The token stops working at once. Your coding assistant will not be able to send updates until you issue a new one. Updates already sent stay where they are.'
              : 'The current token stops working at once, and you will need to give Claude Code the new one. Updates already sent stay where they are.'}
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" className="btn-quiet" onClick={() => setConfirm(null)}>
              Keep it
            </button>
            {confirm === 'revoke' ? (
              <button type="button" className="btn-danger" onClick={() => void revoke()}>
                Revoke it
              </button>
            ) : (
              <button type="button" className="btn-primary" onClick={() => void issue()}>
                Replace it
              </button>
            )}
          </div>
        </div>
      </Modal>
    </div>
  );
}
