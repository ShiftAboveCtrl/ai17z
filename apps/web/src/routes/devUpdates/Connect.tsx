import { useState } from 'react';
import { KeyRound, ShieldOff } from 'lucide-react';
import { del, post } from '@app/lib/api';
import { timeAgo } from '@app/lib/format';
import { Modal } from '@app/components/ui';
import type { DevUpdateConnection, DevUpdateProject } from '@app/lib/devUpdates';
import { ProblemList, problemOf } from './parts';
import { TokenReveal } from './TokenReveal';

/**
 * The sender token: issue, replace, revoke, and show a new one once.
 *
 * A token issued here lives in this component's state and nowhere else, and
 * only until it is hidden. Leaving this tab or switching project unmounts the
 * component, and the token goes with it: it does not come back when the owner
 * returns. Nothing above this component ever holds it.
 */
export function Connect({
  project,
  connection,
  connectionError,
  onChanged,
}: {
  project: DevUpdateProject;
  connection: DevUpdateConnection | null;
  connectionError: string | null;
  onChanged: () => void;
}) {
  const [fresh, setFresh] = useState<string | null>(null);
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
      setFresh(result.senderToken);
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
      setFresh(null);
      onChanged();
    } catch (error) {
      setProblem(problemOf(error, 'The token could not be revoked.'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-6">
      {fresh ? (
        <TokenReveal
          token={fresh}
          projectKey={project.projectKey}
          projectName={project.displayName}
          connection={connection}
          connectionError={connectionError}
          onDone={() => setFresh(null)}
        />
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
              : 'The current token stops working at once, and you will need to give your coding assistant the new one. Updates already sent stay where they are.'}
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
