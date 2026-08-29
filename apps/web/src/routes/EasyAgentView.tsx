import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Pencil, Sparkles } from 'lucide-react';
import type { EasySetup, EasyView } from '@xbam/shared/contracts';
import { ApiError, put } from '@app/lib/api';
import { usePolling, useResource } from '@app/lib/hooks';
import type { AgentDetail, JobSummary } from '@app/lib/types';
import { timeAgo } from '@app/lib/format';
import { ErrorPanel, Field, Loading, Modal, Spinner, Toggle } from '@app/components/ui';
import { BrowserTabsPanel } from '@app/components/BrowserTabsPanel';

/**
 * The agent page for somebody who does not want to configure anything.
 *
 * Four things about the agent, what it has been doing, and whether it is well.
 * Everything else is still there behind Advanced — this is a smaller view of
 * the same agent, not a smaller agent.
 */

const AUDIENCE_WORDS: Record<EasySetup['replies']['audience'], string> = {
  EVERYONE: 'Everyone who mentions or replies',
  EXCEPT_SPAM: 'Everyone except spam and noise',
  VERIFIED_ONLY: 'Verified accounts only',
  ALLOWLIST: 'Only the people you chose',
};

const SELECTIVITY_WORDS: Record<EasySetup['replies']['selectivity'], string> = {
  ALMOST_EVERYTHING: 'Answers almost everything',
  BALANCED: 'Weighs it up',
  ONLY_WHEN_USEFUL: 'Only when it has something useful to say',
};

const FREQUENCY_WORDS: Record<EasySetup['posting']['frequency'], string> = {
  OCCASIONALLY: 'Occasionally',
  FEW_PER_DAY: 'A few times a day',
  DAILY: 'About daily',
};

interface EasyPayload {
  ready: boolean;
  view: EasyView | null;
  accountId: string | null;
  posting: { nextPostAt: string | null; lastPostAt: string | null; lastReason: string } | null;
  detail?: string;
}

export function EasyAgentView({ agent }: { agent: AgentDetail }) {
  const easy = useResource<EasyPayload>(`/api/agents/${agent.agent.id}/easy`);
  const preflight = useResource<{ ready: boolean; blockers: { what: string; fix: string }[] }>(
    `/api/agents/${agent.agent.id}/preflight`,
  );
  const [editing, setEditing] = useState(false);

  if (easy.loading && !easy.data) return <Loading label="Loading" />;
  if (easy.error) return <ErrorPanel title="This could not be loaded." detail={easy.error} />;

  const view = easy.data?.view ?? null;
  const account = agent.accounts[0];
  const model = agent.models.find((m) => m.role === 'primary');
  const blockers = preflight.data?.blockers ?? [];

  return (
    <div className="space-y-6">
      {blockers.length > 0 && (
        <div className="space-y-2 rounded-xl border border-signal-wait/40 bg-signal-wait/[0.06] p-5">
          <p className="flex items-center gap-2 text-sm text-bone">
            <AlertTriangle className="h-4 w-4 shrink-0 text-signal-wait" aria-hidden />
            {blockers.length === 1 ? 'One thing needs sorting.' : `${blockers.length} things need sorting.`}
          </p>
          <ul className="space-y-1.5 pl-6">
            {blockers.map((blocker) => (
              <li key={blocker.what} className="text-[13px] leading-relaxed text-bone-dim">
                {blocker.what} <span className="text-bone-faint">{blocker.fix}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {view && !view.exact && (
        <div className="space-y-2 rounded-xl border border-ink-line bg-ink-panel/50 p-5">
          <p className="text-sm text-bone-dim">This agent has settings this view does not show.</p>
          <ul className="space-y-1.5">
            {view.beyondEasyMode.map((note) => (
              <li key={note} className="text-[12px] leading-relaxed text-bone-faint">
                {note}
              </li>
            ))}
          </ul>
          <p className="pt-1 text-[12px] text-bone-faint">
            Editing here leaves them alone. Open Advanced to see all of it.
          </p>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Panel
          title="Character"
          action={
            view ? (
              <button type="button" className="btn-quiet" onClick={() => setEditing(true)}>
                <Pencil className="h-3.5 w-3.5" aria-hidden />
                Edit
              </button>
            ) : null
          }
        >
          {view ? (
            <>
              <Line label="Style" value={view.setup.character.preset.toLowerCase()} />
              {view.setup.character.tone && <Line label="Tone" value={view.setup.character.tone} />}
              {view.setup.character.caresAbout.length > 0 && (
                <Line label="Cares about" value={view.setup.character.caresAbout.join(', ')} />
              )}
              <Line
                label="Examples"
                value={
                  view.setup.character.examples.length === 0
                    ? 'None yet — adding a few is the single most useful thing you can do'
                    : `${view.setup.character.examples.length} things it would say`
                }
              />
            </>
          ) : (
            <p className="text-[13px] text-bone-faint">Not set up yet.</p>
          )}
        </Panel>

        <Panel title="AI">
          {model ? (
            <>
              <Line label="Model" value={model.model} />
              <Line label="Through" value={model.providerLabel ?? 'a saved provider'} />
            </>
          ) : (
            <p className="text-[13px] text-bone-faint">No model connected yet.</p>
          )}
        </Panel>

        <Panel title="Replies">
          {view ? (
            <>
              <Line label="Answers" value={AUDIENCE_WORDS[view.setup.replies.audience]} />
              <Line label="Selectivity" value={SELECTIVITY_WORDS[view.setup.replies.selectivity]} />
              <Line
                label="Operation"
                value={view.setup.operation === 'AUTOMATIC' ? 'Automatic' : 'Prepares, then waits for you'}
              />
            </>
          ) : (
            <p className="text-[13px] text-bone-faint">Not set up yet.</p>
          )}
        </Panel>

        <Panel title="Posts">
          {view?.setup.posting.enabled ? (
            <>
              <Line label="How often" value={FREQUENCY_WORDS[view.setup.posting.frequency]} />
              {easy.data?.posting?.nextPostAt && (
                <Line label="Next chance" value={timeAgo(easy.data.posting.nextPostAt)} />
              )}
              {easy.data?.posting?.lastReason && <Line label="Last time" value={easy.data.posting.lastReason} />}
            </>
          ) : (
            <p className="text-[13px] text-bone-faint">
              Off. It only replies, and never posts anything of its own.
            </p>
          )}
        </Panel>
      </div>

      {account?.channel === 'x' && <BrowserTabsPanel accountId={account.accountId} />}

      <RecentActivity agentId={agent.agent.id} handle={account?.handle ?? null} />

      {view && (
        <EasyEditor
          open={editing}
          onClose={() => setEditing(false)}
          agentId={agent.agent.id}
          initial={view.setup}
          onSaved={() => {
            easy.reload();
            preflight.reload();
            setEditing(false);
          }}
        />
      )}
    </div>
  );
}

function Panel({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-ink-line bg-ink-raised/30 p-5">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <p className="eyebrow">{title}</p>
        {action}
      </div>
      <dl className="space-y-2">{children}</dl>
    </div>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-0.5 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-3">
      <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-bone-faint">{label}</dt>
      <dd className="text-[13px] leading-relaxed text-bone-dim first-letter:uppercase">{value}</dd>
    </div>
  );
}

/**
 * What it has been doing, in sentences.
 *
 * The full trace — every source, score, and prompt layer — is one click away in
 * Advanced. This answers the only question most people have, which is whether
 * anything is happening.
 */
function RecentActivity({ agentId, handle }: { agentId: string; handle: string | null }) {
  const jobs = useResource<{ items: JobSummary[] }>(`/api/jobs?agentId=${agentId}&limit=6`);
  const live = (jobs.data?.items ?? []).some(
    (j) => !['EXECUTED', 'DRY_RUN_COMPLETED', 'PERMANENT_FAILURE', 'CANCELLED'].includes(j.status),
  );
  usePolling(() => jobs.reload(), 3_000, live);

  const items = jobs.data?.items ?? [];

  return (
    <div className="rounded-xl border border-ink-line bg-ink-raised/30 p-5">
      <div className="mb-4 flex items-baseline justify-between gap-3">
        <p className="eyebrow">Activity</p>
        <Link to="/activity" className="font-mono text-[10px] uppercase tracking-[0.16em] text-bone-faint hover:text-bone-dim">
          All of it
        </Link>
      </div>

      {items.length === 0 ? (
        <p className="text-[13px] leading-relaxed text-bone-faint">
          Nothing yet.{' '}
          {handle
            ? `When somebody mentions @${handle}, it appears here.`
            : 'Connect an account and it will have something to read.'}
        </p>
      ) : (
        <ul className="divide-y divide-ink-line">
          {items.map((job) => (
            <li key={job.id}>
              <Link to={`/jobs/${job.id}`} className="flex items-baseline justify-between gap-4 py-2.5 hover:text-bone">
                <span className="min-w-0 flex-1 truncate text-[13px] text-bone-dim">{describe(job)}</span>
                <span className="shrink-0 font-mono text-[10px] text-bone-faint">{timeAgo(job.createdAt)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One job in words rather than a status enum. */
function describe(job: JobSummary): string {
  const who = job.authorHandle ? `@${job.authorHandle}` : 'Someone';
  switch (job.status) {
    case 'EXECUTED':
      return job.actionType === 'POST' ? 'Posted something of its own' : `Replied to ${who}`;
    case 'DRY_RUN_COMPLETED':
      return `Wrote a reply to ${who}, but did not send it`;
    case 'REVIEW_REQUIRED':
      return `Waiting for you to approve a reply to ${who}`;
    case 'PERMANENT_FAILURE':
      return `Could not reply to ${who}${job.lastError ? `: ${job.lastError}` : ''}`;
    case 'CANCELLED':
      return `Skipped ${who}`;
    default:
      return job.actionType === 'POST' ? 'Writing a post' : `Replying to ${who}`;
  }
}

/**
 * Editing the same eleven answers the setup asked for.
 *
 * Writes through the same endpoint, which writes new persona and policy
 * versions, which the Advanced screens then show. There is nowhere else for
 * this to be saved.
 */
function EasyEditor({
  open,
  onClose,
  agentId,
  initial,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  agentId: string;
  initial: EasySetup;
  onSaved: () => void;
}) {
  const [setup, setSetup] = useState<EasySetup>(initial);
  const [examplesText, setExamplesText] = useState(initial.character.examples.join('\n'));
  const [caresText, setCaresText] = useState(initial.character.caresAbout.join(', '));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await put(`/api/agents/${agentId}/easy`, {
        ...setup,
        character: {
          ...setup.character,
          caresAbout: caresText.split(/[\n,]/).map((s) => s.trim()).filter(Boolean),
          examples: examplesText.split('\n').map((s) => s.trim()).filter(Boolean),
        },
      });
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Edit this agent">
      <div className="space-y-5">
        <Field label="Who is this?" htmlFor="ez-desc">
          <input
            id="ez-desc"
            className="field"
            value={setup.character.description}
            onChange={(e) => setSetup({ ...setup, character: { ...setup.character, description: e.target.value } })}
          />
        </Field>
        <Field label="Personality" htmlFor="ez-personality">
          <textarea
            id="ez-personality"
            rows={3}
            className="field resize-y"
            value={setup.character.personality}
            onChange={(e) => setSetup({ ...setup, character: { ...setup.character, personality: e.target.value } })}
          />
        </Field>
        <Field label="Tone" htmlFor="ez-tone" hint="How they sound. Leave blank to keep the preset's.">
          <input
            id="ez-tone"
            className="field"
            value={setup.character.tone}
            onChange={(e) => setSetup({ ...setup, character: { ...setup.character, tone: e.target.value } })}
          />
        </Field>
        <Field label="Cares about" htmlFor="ez-cares" hint="Comma separated.">
          <input id="ez-cares" className="field" value={caresText} onChange={(e) => setCaresText(e.target.value)} />
        </Field>
        <Field label="Things they would say" htmlFor="ez-examples" hint="One per line.">
          <textarea
            id="ez-examples"
            rows={4}
            className="field resize-y"
            value={examplesText}
            onChange={(e) => setExamplesText(e.target.value)}
          />
        </Field>

        <div className="space-y-3 border-t border-ink-line pt-5">
          <Toggle
            checked={setup.operation === 'AUTOMATIC'}
            onChange={(v) => setSetup({ ...setup, operation: v ? 'AUTOMATIC' : 'REVIEW_FIRST' })}
            label="Act automatically"
            description="Off means it writes replies and waits for you to approve them."
          />
          <Toggle
            checked={setup.posting.enabled}
            onChange={(v) => setSetup({ ...setup, posting: { ...setup.posting, enabled: v } })}
            label="Make posts of its own"
            description="It writes from ideas that came out of real conversations, and stays quiet when it has none."
          />
        </div>

        {error && <ErrorPanel title="That could not be saved." detail={error} />}

        <div className="flex gap-2">
          <button type="button" className="btn-primary flex-1" onClick={() => void save()} disabled={busy}>
            {busy ? <Spinner /> : <Sparkles className="h-4 w-4" aria-hidden />}
            Save
          </button>
          <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  );
}
