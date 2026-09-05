import { useState } from 'react';
import { ArrowDown } from 'lucide-react';
import type { PipelineVersionRecord } from '@app/lib/types';
import { EmptyState, Modal } from '@app/components/ui';
import { Section } from './Section';

const KIND_COPY: Record<string, string> = {
  FILTER: 'Drops events not worth a model call, before any model is called.',
  CONDITION: 'Routes on a fact about the job: output length, thread depth, dry run.',
  DELAY: 'Waits before continuing, without holding a worker.',
  MEMORY_WRITE: 'Records the turn and runs the memory write policy.',
  END: 'Ends the run. A run that ends without acting is cancelled, not failed.',
  TRIGGER: 'An inbound event becomes a durable job.',
  RESOLVE_CONTEXT: 'The channel adapter identifies the exact remote target and reads the surrounding conversation.',
  RETRIEVE_MEMORY: 'Each memory scope is queried under its own limit, and every selection records why it was chosen.',
  ASSEMBLE_PERSONA: 'Persona, policy, memory and context are rendered into ten prompt layers.',
  GENERATE: 'The model gateway walks the fallback chain, persisting every attempt.',
  VALIDATE: 'Output is checked against the policy. Repairs are recorded, failures escalate.',
  APPROVAL_GATE: 'Autonomous agents continue. Review agents wait for a person.',
  EXECUTE_ACTION: 'The target is verified again, then the action is claimed exactly once and performed.',
  PERSIST: 'The turn is recorded and the memory write policy runs.',
};

/**
 * The pipeline drawn from the stored graph, not from a picture of it. These are
 * the versioned node rows the runtime was admitted under.
 */
export function PipelineSection({
  index,
  pipeline,
  triggerLabel,
}: {
  index: number;
  pipeline: PipelineVersionRecord | null;
  triggerLabel: string;
}) {
  const [selected, setSelected] = useState<string | null>(null);

  if (!pipeline) {
    return (
      <Section id="pipeline" index={index} eyebrow="Pipeline" heading="How it works.">
        <EmptyState title="No pipeline yet." detail="A default pipeline is created with every agent." />
      </Section>
    );
  }

  const node = pipeline.nodes.find((n) => n.key === selected);

  return (
    <Section
      id="pipeline"
      index={index}
      eyebrow="Pipeline"
      heading={triggerLabel}
      lede={`${pipeline.name} · version ${pipeline.version}. Each stage settles its own state before the next begins, so a restart resumes rather than restarts.`}
    >
      {/*
        A sequence, so it stays one column -- but a wider and shorter one. Each
        node was a card two lines tall with its outgoing edges listed beneath,
        about 300px per stage and ten stages, which made this the tallest thing
        on the page at nearly half air.
      */}
      <ol className="mx-auto max-w-2xl space-y-1.5">
        {pipeline.nodes.map((n) => {
          const out = pipeline.edges.filter((e) => e.from === n.key);
          return (
            <li key={n.key}>
              <button
                type="button"
                onClick={() => setSelected(n.key)}
                className="flex w-full flex-wrap items-baseline gap-x-3 gap-y-0.5 rounded-lg border border-ink-line bg-ink-raised/40 px-4 py-2.5 text-left transition-colors hover:border-signal-calm/40 hover:bg-signal-calm/[0.04]"
              >
                <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-bone-faint">
                  {n.kind.replace(/_/g, ' ')}
                </span>
                <span className="text-[15px] font-light text-bone">{n.label}</span>
              </button>
              {out.length > 0 && (
                <ul className="mt-0.5 space-y-0.5 pl-5">
                  {out.map((edge) => (
                    <li key={`${edge.from}-${edge.branch}`} className="flex items-center gap-2">
                      <ArrowDown className="h-3.5 w-3.5 shrink-0 text-bone-faint/50" aria-hidden />
                      {edge.branch !== 'next' && (
                        <span
                          className={`chip ${edge.branch === 'false' || edge.branch === 'rejected' ? 'border-signal-wait/40 text-signal-wait' : 'border-signal-live/40 text-signal-live'}`}
                        >
                          {edge.branch}
                        </span>
                      )}
                      <span className="font-mono text-[11px] text-bone-faint">
                        {edge.condition ?? pipeline.nodes.find((x) => x.key === edge.to)?.label ?? edge.to}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ol>

      <Modal open={Boolean(node)} onClose={() => setSelected(null)} title={node?.label ?? 'Stage'}>
        {node && (
          <div className="space-y-5">
            <p className="text-sm leading-relaxed text-bone-dim">{KIND_COPY[node.kind] ?? 'Stage of the reply pipeline.'}</p>
            <div>
              <p className="eyebrow mb-2">Configuration</p>
              <pre className="scroll-x rounded-lg border border-ink-line bg-ink-panel p-3 font-mono text-[12px] text-bone-dim">
                {JSON.stringify(node.config ?? {}, null, 2)}
              </pre>
            </div>
            <div>
              <p className="eyebrow mb-2">Where it goes next</p>
              <ul className="space-y-1 text-sm text-bone-dim">
                {pipeline.edges.filter((e) => e.from === node.key).map((edge) => (
                  <li key={edge.branch} className="font-mono text-[12px]">
                    {edge.branch} &rarr; {pipeline.nodes.find((x) => x.key === edge.to)?.label ?? edge.to}
                  </li>
                ))}
                {pipeline.edges.every((e) => e.from !== node.key) && <li className="text-bone-faint">Nothing: this ends the run.</li>}
              </ul>
            </div>
            <p className="text-xs leading-relaxed text-bone-faint">
              This is the graph the runtime walks, not a drawing of it. Editing the shape from this screen is not
              implemented yet; graphs are changed through the pipeline API, which rejects one that cannot run.
            </p>
          </div>
        )}
      </Modal>
    </Section>
  );
}
