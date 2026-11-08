import { useMemo, useReducer, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { post } from '@app/lib/api';
import { useResource } from '@app/lib/hooks';
import type { AgentListItem } from '@app/lib/types';
import { ChoiceGroup, ChoiceOption, Field, Modal } from '@app/components/ui';
import {
  INITIAL_CREATION,
  KEY_PATTERN,
  accountChoices,
  creationReducer,
  suggestKey,
  type DevUpdateConnection,
  type DevUpdateProject,
} from '@app/lib/devUpdates';
import { ProblemList, problemOf } from './parts';
import { TokenReveal } from './TokenReveal';

interface Capabilities {
  grants: Record<string, string[]>;
}

/**
 * Starting a project: a name, the agent that talks about it, and the account
 * it posts through.
 *
 * Only accounts the agent may post through are offered, because the server
 * refuses the others. They are still listed, greyed, with the reason and a link
 * to change it: an account that silently is not there is the one somebody
 * spends ten minutes looking for.
 */
export function NewProject({
  open,
  agents,
  connection,
  connectionError,
  onClose,
  onCreated,
  onOpenConnect,
}: {
  open: boolean;
  agents: AgentListItem[];
  connection: DevUpdateConnection | null;
  connectionError: string | null;
  onClose: () => void;
  /** `current` is false for a project whose response arrived after the dialog closed. */
  onCreated: (project: DevUpdateProject, current: boolean) => void;
  /** Opens a project on its Connect tab, where a lost token is replaced. */
  onOpenConnect: (projectId: string) => void;
}) {
  // See creationReducer: the token exists here only for the generation that
  // asked for it, and every close starts a new one. The ref moves in step with
  // the reducer's own generation so the response handler, which runs after an
  // await, can tell whether it is still current without reading stale state.
  const [creation, dispatch] = useReducer(creationReducer, INITIAL_CREATION);
  const generation = useRef(INITIAL_CREATION.generation);
  const close = () => {
    generation.current += 1;
    dispatch({ type: 'close' });
    onClose();
  };
  const created = creation.revealed;
  const busy = creation.pending !== null;
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [keyTouched, setKeyTouched] = useState(false);
  const [agentId, setAgentId] = useState<string>(agents[0]?.id ?? '');
  const [accountId, setAccountId] = useState<string | null>(null);
  const [problem, setProblem] = useState<string[] | null>(null);
  const [tried, setTried] = useState(false);

  const agent = agents.find((a) => a.id === agentId) ?? agents[0] ?? null;
  const caps = useResource<Capabilities>(open && agent ? `/api/agents/${agent.id}/capabilities` : null);
  const choices = useMemo(
    () => (agent && caps.data ? accountChoices(agent.accounts, caps.data.grants) : []),
    [agent, caps.data],
  );
  const usable = choices.filter((c) => c.unavailable === null);
  const withheld = choices.filter((c) => c.unavailable !== null);
  const chosen = usable.find((c) => c.accountId === accountId) ?? (usable.length === 1 ? usable[0] : null);

  const effectiveKey = keyTouched ? key : suggestKey(name);
  const nameError = tried && !name.trim() ? 'Give the project a name.' : null;
  const keyError =
    tried && !KEY_PATTERN.test(effectiveKey)
      ? 'Use 2 to 63 lower case letters, digits, dots, dashes or underscores, starting with a letter or digit.'
      : null;

  const submit = async () => {
    setTried(true);
    setProblem(null);
    if (busy || !name.trim() || !KEY_PATTERN.test(effectiveKey) || !agent || !chosen) return;
    const asked = generation.current;
    dispatch({ type: 'submit' });
    try {
      const result = await post<{ project: DevUpdateProject; senderToken: string }>('/api/dev-updates/projects', {
        projectKey: effectiveKey,
        displayName: name.trim(),
        agentId: agent.id,
        accountId: chosen.accountId,
      });
      const current = asked === generation.current;
      // The reducer decides whether the token is shown; a stale answer is
      // kept as an orphan without it.
      dispatch({ type: 'succeeded', generation: asked, project: result.project, token: result.senderToken });
      // Cleared only for the dialog that asked. A late answer belongs to a
      // dialog already closed, whose form was reset then, and clearing now
      // would erase what the owner is typing into the one open since.
      if (current) {
        setName('');
        setKey('');
        setKeyTouched(false);
        setTried(false);
      }
      onCreated(result.project, current);
    } catch (error) {
      dispatch({ type: 'failed', generation: asked });
      if (asked === generation.current) setProblem(problemOf(error, 'The project could not be created.'));
    }
  };

  return (
    <Modal open={open} onClose={close} title={created ? 'Project created' : 'New project'}>
      {created ? (
        <TokenReveal
          token={created.token}
          projectKey={created.project.projectKey}
          projectName={created.project.displayName}
          connection={connection}
          connectionError={connectionError}
          onDone={close}
          doneLabel="I have copied it, close"
        />
      ) : (
      <form
        className="space-y-6"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {creation.orphan && (
          <div role="status" className="space-y-3 rounded-lg border border-signal-wait/40 bg-signal-wait/[0.05] px-3.5 py-3">
            <p className="break-words text-[13px] leading-relaxed text-bone">
              {creation.orphan.displayName} was created after this dialog closed, so its token was never shown. AI17Z keeps
              only a fingerprint of it and cannot show it now. A token is active for it: replace it on the project's Connect
              tab to get a new one and the command to paste.
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="btn-ghost min-h-[40px] px-3 py-2 text-xs"
                onClick={() => {
                  const id = creation.orphan!.id;
                  dispatch({ type: 'dismissOrphan' });
                  close();
                  onOpenConnect(id);
                }}
              >
                Open its Connect tab
              </button>
              <button type="button" className="btn-quiet min-h-[40px] px-3 py-2 text-xs" onClick={() => dispatch({ type: 'dismissOrphan' })}>
                Dismiss
              </button>
            </div>
          </div>
        )}
        <Field label="Project name" hint="How you refer to it. Used in posts the agent writes for you." error={nameError}>
          <input
            className="field"
            value={name}
            maxLength={80}
            data-autofocus
            autoComplete="off"
            onChange={(e) => setName(e.target.value)}
            placeholder="My App"
          />
        </Field>

        <Field
          label="Project key"
          hint="What your coding assistant calls the project. It cannot be changed later."
          error={keyError}
        >
          <input
            className="field font-mono text-sm"
            value={effectiveKey}
            maxLength={63}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              setKeyTouched(true);
              setKey(e.target.value.toLowerCase());
            }}
            placeholder="my-app"
          />
        </Field>

        {agents.length === 0 ? (
          <p className="text-sm leading-relaxed text-bone-dim">
            You need an agent to post for you first.{' '}
            <Link to="/agents/new" className="text-bone underline underline-offset-4">
              Create an agent
            </Link>
            .
          </p>
        ) : (
          <Field label="Agent that posts">
            <select
              className="field"
              value={agent?.id ?? ''}
              onChange={(e) => {
                setAgentId(e.target.value);
                setAccountId(null);
              }}
            >
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </Field>
        )}

        {agent && (
          <div className="space-y-3">
            {caps.loading && !caps.data ? (
              <p className="text-sm text-bone-dim" role="status">
                Reading which accounts {agent.name} may post through…
              </p>
            ) : caps.error ? (
              <p className="break-words text-sm text-signal-fail" role="alert">
                {agent.name}'s permissions could not be read: {caps.error}
              </p>
            ) : choices.length === 0 ? (
              <p className="text-sm leading-relaxed text-bone-dim">
                {agent.name} is not connected to an account yet.{' '}
                <Link to={`/agents/${agent.id}#accounts`} className="text-bone underline underline-offset-4">
                  Connect one
                </Link>
                .
              </p>
            ) : (
              <>
                {usable.length > 0 && (
                  <Field label="Account it posts through">
                    <ChoiceGroup label="Account it posts through" className="grid gap-2 sm:grid-cols-2">
                      {usable.map((c) => (
                        <ChoiceOption
                          key={c.accountId}
                          selected={chosen?.accountId === c.accountId}
                          onSelect={() => setAccountId(c.accountId)}
                          className={`min-h-[44px] rounded-lg border px-3.5 py-2.5 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bone-dim ${
                            chosen?.accountId === c.accountId
                              ? 'border-signal-calm/60 bg-signal-calm/[0.07] text-bone'
                              : 'border-ink-line text-bone-dim hover:border-bone-faint'
                          }`}
                        >
                          <span className="block break-words font-mono text-sm">@{c.handle}</span>
                          <span className="block text-[11px] uppercase tracking-[0.14em] text-bone-dim">{c.channel}</span>
                        </ChoiceOption>
                      ))}
                    </ChoiceGroup>
                  </Field>
                )}
                {tried && !chosen && usable.length > 0 && (
                  <p className="text-xs text-signal-fail" role="alert">
                    Choose the account it posts through.
                  </p>
                )}
                {withheld.length > 0 && (
                  <div className="rounded-lg border border-dashed border-ink-line px-3.5 py-3">
                    <p className="text-[13px] leading-relaxed text-bone-dim">
                      {usable.length === 0 ? 'No account can be used yet. ' : 'Not shown above: '}
                      only accounts {agent.name} is allowed to post through can carry updates.{' '}
                      <Link to={`/agents/${agent.id}#capabilities`} className="text-bone underline underline-offset-4">
                        Change what {agent.name} may do
                      </Link>
                      .
                    </p>
                    <ul className="mt-2 space-y-1 text-xs text-bone-dim">
                      {withheld.map((c) => (
                        <li key={c.accountId} className="break-words">
                          {c.unavailable}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        <p className="rounded-lg bg-white/[0.02] px-3.5 py-3 text-[13px] leading-relaxed text-bone-dim">
          It starts safe: every update waits for you, nothing is really posted until you turn rehearsal off, and at most two
          go out a day, four hours apart. You can change all of that afterwards.
        </p>

        <ProblemList lines={problem} />

        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className="btn-quiet" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={busy || agents.length === 0}>
            {busy ? 'Creating…' : 'Create project'}
          </button>
        </div>
      </form>
      )}
    </Modal>
  );
}
