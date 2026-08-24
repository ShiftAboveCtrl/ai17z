import { useState } from 'react';
import { ArrowDown } from 'lucide-react';
import type { PipelineVersionRecord } from '@app/lib/types';
import { EmptyState, Modal } from '@app/components/ui';
import { Section } from './Section';

const KIND_COPY: Record<string, string> = {
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
      <ol className="mx-auto max-w-md">
        {pipeline.nodes.map((n, i) => (
          <li key={n.key}>
            <button
              type="button"
              onClick={() => setSelected(n.key)}
              className="w-full rounded-xl border border-ink-line bg-ink-raised/40 px-5 py-4 text-left transition-colors hover:border-signal-calm/40 hover:bg-signal-calm/[0.04]"
            >
              <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-bone-faint">{n.kind.replace(/_/g, ' ')}</span>
              <span className="mt-1 block text-lg font-light text-bone">{n.label}</span>
            </button>
            {i < pipeline.nodes.length - 1 && (
              <div className="flex justify-center py-2" aria-hidden>
                <ArrowDown className="h-4 w-4 text-bone-faint/50" />
              </div>
            )}
          </li>
        ))}
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
            <p className="text-xs leading-relaxed text-bone-faint">
              Stage configuration is stored per pipeline version. Editing the graph shape from this screen is not
              implemented yet: changing agent behaviour today happens through its persona, policy and model settings.
            </p>
          </div>
        )}
      </Modal>
    </Section>
  );
}
