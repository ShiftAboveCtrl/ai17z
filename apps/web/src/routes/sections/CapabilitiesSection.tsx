import { useState } from 'react';
import type { CapabilityPermission, CapabilityView } from '@xbam/shared/contracts';
import { put } from '@app/lib/api';
import { useResource } from '@app/lib/hooks';
import { ChoiceGroup, ChoiceOption, Field, Spinner } from '@app/components/ui';
import { IndexedRow, Section, SubHeading } from './Section';

/**
 * What the agent may reach for, and what it has reached for.
 *
 * The older Tools section is about three built-ins and a switch each. This is
 * the capability layer: what the model can choose mid-answer, what the owner
 * has decided about each one, and -- the half that matters most -- what it
 * actually did, including every time it was refused.
 *
 * Status is not permission. A capability can be allowed and still unavailable
 * because nothing can open a browser, and telling somebody "you have not
 * enabled this" about something that could not have worked anyway teaches them
 * the wrong thing. So the reason travels with the row.
 */

const WORDS: Record<CapabilityPermission, { label: string; hint: string }> = {
  ALLOWED: { label: 'Allowed', hint: 'It may use this whenever it decides to.' },
  OWNER_APPROVAL: { label: 'Ask me', hint: 'Held for you before it runs.' },
  DISABLED: { label: 'Off', hint: 'It may not use this at all.' },
};

const STATUS_TONE: Record<string, string> = {
  AVAILABLE: 'text-bone',
  DISABLED: 'text-bone-faint',
  OWNER_APPROVAL: 'text-bone-dim',
  UNAVAILABLE: 'text-bone-faint',
  BLOCKED: 'text-bone-faint',
  DEGRADED: 'text-bone-dim',
};

interface Invocation {
  id: string;
  capabilityId: string;
  outcome: string;
  detail: string;
  durationMs: number;
  createdAt: string;
}

export function CapabilitiesSection({ index, agentId }: { index: number; agentId: string }) {
  const capabilities = useResource<{ items: CapabilityView[] }>(`/api/agents/${agentId}/toolspace`);
  const history = useResource<{ items: Invocation[] }>(`/api/agents/${agentId}/toolspace/invocations`);
  const [saving, setSaving] = useState<string | null>(null);

  const set = async (id: string, permission: CapabilityPermission) => {
    setSaving(id);
    try {
      await put(`/api/agents/${agentId}/toolspace/${id}`, { permission });
      capabilities.reload();
    } finally {
      setSaving(null);
    }
  };

  const items = capabilities.data?.items ?? [];
  const reads = items.filter((c) => c.effect === 'READ');
  const writes = items.filter((c) => c.effect === 'WRITE');

  return (
    <Section
      id="capabilities"
      index={index}
      eyebrow="Capabilities"
      heading="What it can reach for"
      lede="What the model may choose while it is answering."
      explain="Reading is allowed by default, because an agent that looks something up unasked is useful. Anything that changes something is off until you turn it on."
    >
      {capabilities.loading && <Spinner />}

      {items.length > 0 && (
        <>
          <SubHeading>Reading</SubHeading>
          {reads.map((capability, i) => (
            <CapabilityRow key={capability.id} capability={capability} index={i} saving={saving === capability.id} onSet={set} />
          ))}

          <SubHeading>Acting</SubHeading>
          {writes.length === 0 ? (
            <p className="text-[13px] text-bone-faint">Nothing here can change anything yet.</p>
          ) : (
            writes.map((capability, i) => (
              <CapabilityRow key={capability.id} capability={capability} index={i} saving={saving === capability.id} onSet={set} />
            ))
          )}
        </>
      )}

      <SubHeading>What it has used</SubHeading>
      {history.data?.items.length === 0 && (
        <p className="text-[13px] leading-relaxed text-bone-faint">
          Nothing yet. Every time the agent asks for one of these — including every time it is refused — it appears
          here with what it was told.
        </p>
      )}
      <ul className="space-y-1">
        {(history.data?.items ?? []).slice(0, 12).map((row) => (
          <li key={row.id} className="grid gap-1 border-b border-ink-line py-2 sm:grid-cols-[10rem_minmax(0,1fr)]">
            <span className="font-mono text-[11px] text-bone-faint break-words">{row.capabilityId}</span>
            <span className="text-[13px] leading-relaxed text-bone-dim break-words">
              <span className={row.outcome === 'SUCCEEDED' ? 'text-bone' : 'text-bone-faint'}>{row.outcome}</span>
              {' · '}
              {row.detail}
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function CapabilityRow({
  capability,
  index,
  saving,
  onSet,
}: {
  capability: CapabilityView;
  index: number;
  saving: boolean;
  onSet: (id: string, permission: CapabilityPermission) => void;
}) {
  return (
    <IndexedRow index={index + 1} label={capability.category} title={capability.name}>
      <p className="text-[13px] leading-relaxed text-bone-dim break-words">{capability.description}</p>
      <p className="mt-1 font-mono text-[11px] text-bone-faint break-words">{capability.id}</p>

      {/*
        Status before the switch. A capability that cannot run says so, and says
        which kind of cannot it is -- an owner reading "you have not enabled
        this" about something with no browser behind it learns nothing.
      */}
      {capability.why && (
        <p className={`mt-2 text-[12px] leading-relaxed break-words ${STATUS_TONE[capability.status] ?? 'text-bone-dim'}`}>
          {capability.why}
        </p>
      )}

      <div className="mt-3">
        <Field label="Whether it may" hint={WORDS[capability.permission].hint}>
          <ChoiceGroup label="Whether it may">
            {(['ALLOWED', 'OWNER_APPROVAL', 'DISABLED'] as CapabilityPermission[]).map((permission) => (
              <ChoiceOption
                key={permission}
                selected={capability.permission === permission}
                onSelect={() => onSet(capability.id, permission)}
              >
                {WORDS[permission].label}
              </ChoiceOption>
            ))}
          </ChoiceGroup>
        </Field>
        {saving && <Spinner />}
      </div>
    </IndexedRow>
  );
}
