import { useState } from 'react';
import { ApiError, post } from '@app/lib/api';
import { useResource } from '@app/lib/hooks';
import { EmptyState, Field, Spinner } from '@app/components/ui';
import { Card, Panel } from './shared';

/**
 * One question at a time, answered slowly or not at all.
 *
 * The verdict most of this screen shows is "not yet", and it says how many more
 * posts are needed rather than showing a number that is technically true. An
 * agent posts twice a day; a difference between two ways of writing takes weeks,
 * and a screen that announces a winner on Thursday is how somebody rewrites
 * their agent's voice on the strength of eleven posts.
 *
 * One running experiment per agent, enforced by the database. Two at once are
 * one experiment with four arms and no way to attribute anything: a post
 * written short *and* with a picture belongs to both.
 */

interface Arm {
  key: string;
  label: string;
  posts: number;
  median: number;
}

interface Reading {
  verdict: 'TOO_EARLY' | 'NO_DIFFERENCE' | 'DIFFERENCE';
  winner?: string;
  detail: string;
  perArm: Arm[];
  needed?: number;
}

interface ExperimentView {
  id: string;
  hypothesis: string;
  status: 'RUNNING' | 'STOPPED';
  createdAt: string;
  endedAt: string | null;
  variants: { key: string; label: string; instruction: string }[];
  reading: Reading;
  unmeasured: number;
}

const VERDICT_WORDS: Record<Reading['verdict'], string> = {
  TOO_EARLY: 'Not yet',
  NO_DIFFERENCE: 'No difference',
  DIFFERENCE: 'A difference',
};

export function ExperimentsView({ agentId }: { agentId: string }) {
  const view = useResource<{ items: ExperimentView[] }>(`/api/agents/${agentId}/growth/experiments`);
  const [hypothesis, setHypothesis] = useState('');
  const [labelA, setLabelA] = useState('As usual');
  const [labelB, setLabelB] = useState('Shorter');
  const [instructionB, setInstructionB] = useState('Keep this post under 120 characters.');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const items = view.data?.items ?? [];
  const running = items.find((item) => item.status === 'RUNNING');

  const start = async () => {
    if (!hypothesis.trim()) {
      setError('An experiment needs a question somebody can read.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await post(`/api/agents/${agentId}/growth/experiments`, {
        hypothesis: hypothesis.trim(),
        variantA: { key: 'a', label: labelA.trim() || 'As usual', instruction: '' },
        variantB: { key: 'b', label: labelB.trim() || 'The other way', instruction: instructionB.trim() },
      });
      setHypothesis('');
      view.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That could not be started.');
    } finally {
      setBusy(false);
    }
  };

  const stop = async (id: string) => {
    setBusy(true);
    try {
      await post(`/api/agents/${agentId}/growth/experiments/${id}/stop`, {});
      view.reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Panel
        title={running ? 'Running now' : 'Try one thing against another'}
        lede={
          running
            ? 'One at a time. Two at once are one experiment with four arms and no way to tell which did anything.'
            : 'Half the posts this agent writes will follow the second instruction. Nothing else changes, and replies are never varied.'
        }
      >
        {view.loading && <Spinner />}

        {!view.loading && !running && (
          <div className="space-y-4 rounded-xl border border-ink-line px-4 py-4">
            <Field label="What you want to know" hint="A sentence. It is shown with the answer, whatever the answer is.">
              <input
                className="field"
                value={hypothesis}
                onChange={(event) => setHypothesis(event.target.value)}
                placeholder="Do shorter posts get more replies?"
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Leave alone" hint="The control arm. Written exactly as it is now.">
                <input className="field" value={labelA} onChange={(event) => setLabelA(event.target.value)} />
              </Field>
              <Field label="Change" hint="What to call the other half.">
                <input className="field" value={labelB} onChange={(event) => setLabelB(event.target.value)} />
              </Field>
            </div>
            <Field
              label="The instruction"
              hint="Added to the output rules for that half only. Keep it to one thing, or you will not know which thing did it."
            >
              <input
                className="field"
                value={instructionB}
                onChange={(event) => setInstructionB(event.target.value)}
              />
            </Field>
            {error && <p className="text-[12px] text-signal-fail">{error}</p>}
            <button type="button" className="btn-ghost" disabled={busy} onClick={start}>
              {busy ? 'Starting' : 'Start'}
            </button>
          </div>
        )}

        {running && <Experiment experiment={running} onStop={() => stop(running.id)} busy={busy} />}
      </Panel>

      <Panel
        title="What it has tried"
        lede="Kept after they end. A null result is most of what this teaches, and an experiment that disappears when it stops cannot be quoted back."
      >
        {items.filter((item) => item.status === 'STOPPED').length === 0 && (
          <EmptyState
            title="Nothing finished yet"
            detail="An experiment stays here after it ends, with whatever it found. Even a null result is worth not repeating."
          />
        )}
        <div className="space-y-3">
          {items
            .filter((item) => item.status === 'STOPPED')
            .map((item) => (
              <Experiment key={item.id} experiment={item} />
            ))}
        </div>
      </Panel>
    </>
  );
}

function Experiment({
  experiment,
  onStop,
  busy,
}: {
  experiment: ExperimentView;
  onStop?: () => void;
  busy?: boolean;
}) {
  const { reading } = experiment;
  return (
    <Card
      title={experiment.hypothesis}
      score={VERDICT_WORDS[reading.verdict]}
      meta={reading.detail}
      action={
        onStop && (
          <button type="button" className="btn-ghost text-[12px]" disabled={busy} onClick={onStop}>
            Stop
          </button>
        )
      }
    >
      <div className="grid gap-2 sm:grid-cols-2">
        {reading.perArm.map((arm) => (
          <div
            key={arm.key}
            className={`rounded-lg border px-3.5 py-2.5 ${
              reading.winner === arm.key ? 'border-signal-live/40' : 'border-ink-line'
            }`}
          >
            <p className="text-[13px] text-bone-dim">{arm.label}</p>
            <p className="mt-1 font-mono text-[12px] text-bone-faint">
              {arm.posts} post{arm.posts === 1 ? '' : 's'} · {arm.median} per thousand
            </p>
          </div>
        ))}
      </div>
      {experiment.unmeasured > 0 && (
        <p className="mt-3 text-[12px] leading-relaxed text-bone-faint">
          {experiment.unmeasured} published post{experiment.unmeasured === 1 ? ' has' : 's have'} not been measured yet,
          so {experiment.unmeasured === 1 ? 'it is' : 'they are'} not in these figures.
        </p>
      )}
    </Card>
  );
}
