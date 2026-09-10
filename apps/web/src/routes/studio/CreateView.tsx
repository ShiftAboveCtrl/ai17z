import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, post } from '@app/lib/api';
import { useResource } from '@app/lib/hooks';
import { timeAgo } from '@app/lib/format';
import { EmptyState, Field, Spinner } from '@app/components/ui';
import { Card, Panel } from './shared';

/**
 * What the agent has to say, before it says it.
 *
 * This is the same backlog the Behaviour screen edits and the same one the
 * posting engine reads. It is here because Studio is where somebody notices
 * something worth saying -- a narrative on the Radar, a post they saw -- and
 * making them navigate to a settings screen to write it down is how the thought
 * gets lost.
 *
 * There is no publish button and there is not going to be one. An agent coming
 * due looks at this backlog and may still decide there is nothing worth saying;
 * `docs/ENGINEERING.md` is explicit that a timer firing is not a reason to
 * speak, and a screen that could push a post out of the queue would be a second
 * way to publish beside the one that has the cadence, the policy gates and the
 * validator behind it.
 */

interface Idea {
  id: string;
  summary: string;
  detail: string;
  source: string;
  sourceHandle: string | null;
  effectiveScore: number;
  status: 'unused' | 'drafting' | 'used' | 'discarded';
  createdAt: string;
}

interface Schedule {
  enabled: boolean;
  intervalSeconds: number;
  nextPostAt: string | null;
  lastReason: string;
}

interface ContentView {
  ideas: Idea[];
  schedule: Schedule | null;
}

export function CreateView({ agentId }: { agentId: string }) {
  const view = useResource<ContentView>(`/api/agents/${agentId}/content`);
  const [summary, setSummary] = useState('');
  const [detail, setDetail] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = async () => {
    if (!summary.trim()) {
      setError('An idea needs a sentence.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await post(`/api/agents/${agentId}/ideas`, { summary: summary.trim(), detail: detail.trim() });
      setSummary('');
      setDetail('');
      view.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  const waiting = (view.data?.ideas ?? []).filter((idea) => idea.status === 'unused');
  const schedule = view.data?.schedule;

  return (
    <>
      <Panel
        title="Something to say"
        lede="Written down here, said when the agent is next due and decides it is worth saying."
      >
        <div className="space-y-4 rounded-xl border border-ink-line px-4 py-4">
          <Field label="The idea" hint="One sentence. What it should have a view about.">
            <input
              className="field"
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
              placeholder="Sequencer downtime is becoming a pattern"
            />
          </Field>
          <Field label="Anything else" hint="Optional. Context, a link, what angle you had in mind.">
            <textarea
              className="field min-h-[5rem]"
              value={detail}
              onChange={(event) => setDetail(event.target.value)}
            />
          </Field>
          {error && <p className="text-[12px] text-signal-fail">{error}</p>}
          <button type="button" className="btn-ghost" disabled={saving} onClick={add}>
            {saving ? 'Saving' : 'Add to the backlog'}
          </button>
        </div>
      </Panel>

      <Panel
        title="Waiting to be said"
        lede={
          schedule?.enabled
            ? schedule.nextPostAt
              ? `Next due ${timeAgo(schedule.nextPostAt)}.`
              : 'Posting is on.'
            : 'Posting on its own is off, so these wait until you turn it on.'
        }
        action={
          <Link className="btn-ghost text-[12px]" to={`/agents/${agentId}#content`}>
            Posting settings
          </Link>
        }
      >
        {view.loading && <Spinner />}

        {!view.loading && waiting.length === 0 && (
          <EmptyState
            title="The backlog is empty"
            detail="An empty backlog means silence, which is the intended behaviour rather than a fault: a timer firing is not a reason to speak."
          />
        )}

        <div className="space-y-3">
          {waiting.map((idea) => (
            <Card
              key={idea.id}
              title={idea.summary}
              score={idea.effectiveScore ? `${Math.round(idea.effectiveScore)}` : undefined}
              meta={[idea.detail, idea.sourceHandle ? `from @${idea.sourceHandle}` : null, timeAgo(idea.createdAt)]
                .filter(Boolean)
                .join(' · ')}
            />
          ))}
        </div>

        {schedule && !schedule.enabled && schedule.lastReason && (
          <p className="mt-4 text-[12px] leading-relaxed text-bone-faint">{schedule.lastReason}</p>
        )}
      </Panel>
    </>
  );
}
