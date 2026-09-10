import { useState } from 'react';
import type { CapabilityPermission, CapabilityView } from '@xbam/shared/contracts';
import { put } from '@app/lib/api';
import { useResource } from '@app/lib/hooks';
import { ChoiceGroup, ChoiceOption, Field, Spinner } from '@app/components/ui';
import { IndexedRow, Section, SubHeading } from './Section';

/**
 * What the agent may reach for, and what it has reached for.
 *
 * **Packs first.** A person deciding about their agent wants to say "it may
 * look things up on chains", not to rule on `chain.read_receipt`. So the
 * default view is a handful of named groups, and the individual switches are
 * behind Advanced for the people who want them.
 *
 * A pack is a projection: its state is computed from the capability permissions
 * underneath it and turning one on writes them. There is no second store, which
 * is why an owner who changes one capability in Advanced sees the pack read
 * MIXED rather than the two screens quietly disagreeing.
 *
 * Turning a pack on sets each capability to *its own default* -- reads allowed,
 * anything that changes something still off or asking. "Let it look at X" is
 * not consent to let it post.
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

/** A group of capabilities, as the API computes it. */
interface ToolpackView {
  id: string;
  name: string;
  summary: string;
  state: 'ON' | 'OFF' | 'MIXED';
  ready: number;
  needsSetup: number;
  total: number;
  detail: string;
  capabilities: CapabilityView[];
}

/**
 * The word beside a pack's name.
 *
 * MIXED is shown as "Some", because "mixed" is a word about the data and
 * somebody reading this wants a word about their agent.
 */
const PACK_WORDS: Record<ToolpackView['state'], string> = { ON: 'On', OFF: 'Off', MIXED: 'Some' };

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
  const packView = useResource<{ packs: ToolpackView[]; ungrouped: CapabilityView[] }>(
    `/api/agents/${agentId}/toolspace/packs`,
  );
  const history = useResource<{ items: Invocation[] }>(`/api/agents/${agentId}/toolspace/invocations`);
  const [saving, setSaving] = useState<string | null>(null);
  /** Which pack has its individual switches showing. One at a time. */
  const [open, setOpen] = useState<string | null>(null);

  const set = async (id: string, permission: CapabilityPermission) => {
    setSaving(id);
    try {
      await put(`/api/agents/${agentId}/toolspace/${id}`, { permission });
      capabilities.reload();
    } finally {
      setSaving(null);
    }
  };

  const packs = packView.data?.packs ?? [];
  const ungrouped = packView.data?.ungrouped ?? [];

  const setPack = async (packId: string, on: boolean) => {
    setSaving(packId);
    try {
      await put(`/api/agents/${agentId}/toolspace/packs/${packId}`, { on });
      packView.reload();
      capabilities.reload();
    } finally {
      setSaving(null);
    }
  };

  return (
    <Section
      id="capabilities"
      index={index}
      eyebrow="Capabilities"
      heading="What it can reach for"
      lede="What the model may choose while it is answering."
      explain="Reading is allowed by default, because an agent that looks something up unasked is useful. Anything that changes something stays off or asks until you say otherwise — turning a group on does not change that."
    >
      {packView.loading && <Spinner />}

      {packs.map((pack, i) => (
        <IndexedRow key={pack.id} index={i + 1} label={PACK_WORDS[pack.state]} title={pack.name}>
          <p className="text-[13px] leading-relaxed text-bone-dim break-words">{pack.summary}</p>
          <p className="mt-1 text-[12px] leading-relaxed text-bone-faint break-words">{pack.detail}</p>

          <div className="mt-3">
            <Field
              label="Whether it may"
              hint={
                pack.state === 'MIXED'
                  ? 'You have changed some of these individually. Turning the group on or off replaces those choices.'
                  : 'Turning this on gives it the reading. Anything that changes something still asks.'
              }
            >
              <ChoiceGroup label="Whether it may">
                <ChoiceOption selected={pack.state === 'ON'} onSelect={() => setPack(pack.id, true)}>
                  On
                </ChoiceOption>
                <ChoiceOption selected={pack.state === 'OFF'} onSelect={() => setPack(pack.id, false)}>
                  Off
                </ChoiceOption>
              </ChoiceGroup>
            </Field>
            {saving === pack.id && <Spinner />}
          </div>

          <button
            type="button"
            className="mt-3 text-[12px] text-bone-faint underline underline-offset-2 hover:text-bone-dim"
            onClick={() => setOpen(open === pack.id ? null : pack.id)}
          >
            {open === pack.id ? 'Hide the individual switches' : `Advanced: all ${pack.total} individually`}
          </button>

          {open === pack.id && (
            <div className="mt-3 border-t border-ink-line pt-3">
              {pack.capabilities.map((capability, j) => (
                <CapabilityRow
                  key={capability.id}
                  capability={capability}
                  index={j}
                  saving={saving === capability.id}
                  onSet={set}
                />
              ))}
            </div>
          )}
        </IndexedRow>
      ))}

      {ungrouped.length > 0 && (
        <>
          <SubHeading>Everything else</SubHeading>
          {ungrouped.map((capability, i) => (
            <CapabilityRow
              key={capability.id}
              capability={capability}
              index={i}
              saving={saving === capability.id}
              onSet={set}
            />
          ))}
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
