import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Send } from 'lucide-react';
import { ApiError, post } from '@app/lib/api';
import { usePolling, useResource } from '@app/lib/hooks';
import type { JobSummary } from '@app/lib/types';
import { EmptyState, Field, Modal, Spinner, Toggle } from '@app/components/ui';
import { StickyStackItem } from '@app/components/motion';
import { JobCard } from '@app/components/JobCard';
import { Section } from './Section';

/**
 * Recent work as stacking cards. Injecting a mock event lives here because this
 * is where you would look to find out whether the agent is doing anything.
 */
export function ActivitySection({ index, agentId }: { index: number; agentId: string }) {
  const jobs = useResource<{ items: JobSummary[]; total: number }>(`/api/jobs?agentId=${agentId}&limit=8`);
  const [injecting, setInjecting] = useState(false);
  const [text, setText] = useState('');
  const [handle, setHandle] = useState('test_user');
  const [thread, setThread] = useState('');
  const [dryRun, setDryRun] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Jobs move through the pipeline in seconds, so this view follows along.
  const live = (jobs.data?.items ?? []).some(
    (j) => !['EXECUTED', 'DRY_RUN_COMPLETED', 'PERMANENT_FAILURE', 'CANCELLED'].includes(j.status),
  );
  usePolling(() => jobs.reload(), 2500, live);

  const inject = async () => {
    setBusy(true);
    setError(null);
    try {
      await post('/api/mock/inject', {
        agentId,
        authorHandle: handle.trim() || 'test_user',
        text: text.trim(),
        conversationRef: thread.trim(),
        dryRun,
      });
      setInjecting(false);
      setText('');
      setTimeout(() => jobs.reload(), 600);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The event could not be injected.');
    } finally {
      setBusy(false);
    }
  };

  const items = jobs.data?.items ?? [];

  return (
    <Section
      id="activity"
      index={index}
      eyebrow="Activity"
      heading="What it has done."
      lede="Every inbound event becomes a durable job with a complete trace. Open one to see exactly why it produced what it produced."
    >
      <div className="mb-8 flex flex-wrap gap-3">
        <button type="button" className="btn-ghost" onClick={() => setInjecting(true)}>
          <Send className="h-3.5 w-3.5" aria-hidden />
          Inject a test event
        </button>
        <Link to={`/activity?agentId=${agentId}`} className="btn-quiet">
          See all activity
        </Link>
      </div>

      {jobs.loading && !jobs.data ? (
        <Spinner />
      ) : items.length === 0 ? (
        <EmptyState
          title="Nothing has happened yet."
          detail="Inject a test event to run the whole pipeline locally, without touching any real account."
          action={
            <button type="button" className="btn-ghost" onClick={() => setInjecting(true)}>
              Inject a test event
            </button>
          }
        />
      ) : (
        <div className="pb-24">
          {items.map((job, i) => (
            <StickyStackItem key={job.id} index={i} total={items.length}>
              <JobCard job={job} />
            </StickyStackItem>
          ))}
        </div>
      )}

      <Modal open={injecting} onClose={() => setInjecting(false)} title="Inject a mock event">
        <div className="space-y-5">
          <p className="text-sm leading-relaxed text-bone-dim">
            This runs the real pipeline: context, memory, prompt, model, validation, and target verification. Only the
            final remote action is simulated.
          </p>
          <Field label="From" htmlFor="ihandle">
            <input id="ihandle" className="field" value={handle} onChange={(e) => setHandle(e.target.value)} />
          </Field>
          <Field label="Message" htmlFor="itext">
            <textarea id="itext" rows={4} className="field resize-y" value={text} onChange={(e) => setText(e.target.value)} placeholder="What do you think about..." />
          </Field>
          <Field label="Conversation" htmlFor="ithread" hint="Reuse the same value to continue a thread. Leave blank to start a new one.">
            <input id="ithread" className="field" value={thread} onChange={(e) => setThread(e.target.value)} placeholder="thread-1" />
          </Field>
          <Toggle checked={dryRun} onChange={setDryRun} label="Dry run" description="Stop before performing the action." />
          {error && <p className="text-sm text-signal-fail">{error}</p>}
          <button type="button" className="btn-primary w-full" onClick={() => void inject()} disabled={busy || !text.trim()}>
            {busy && <Spinner />}
            Inject
          </button>
        </div>
      </Modal>
    </Section>
  );
}
