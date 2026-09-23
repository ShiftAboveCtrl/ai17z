import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { CapabilityPermission, CapabilityView } from '@xbam/shared/contracts';
import { useResource } from '@app/lib/hooks';
import { Spinner } from '@app/components/ui';
import { IndexedRow, Section, SubHeading } from './Section';

/**
 * What the agent may reach for, and what it has reached for.
 *
 * **This reads and does not write.** Plugins is where an owner decides, and
 * this says the same things about the same agent with a way through to it.
 * Two screens that both look authoritative about one setting is how something
 * ends up allowed on one and refused on the other, and the fix is not to make
 * them agree carefully -- it is to have one of them be the place.
 *
 * A pack is a projection: its state is computed from the capability
 * permissions underneath it, never stored, which is why what is shown here
 * cannot drift from what the runtime does. The Plugins screen computes its own
 * summary from the same comparison, so the word beside a pack here and the
 * word beside the same Plugin there are the same word.
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
  /**
   * One resource, because the pack view already contains everything.
   *
   * `packs` plus `ungrouped` is every capability there is, so the flat
   * `/toolspace` list this screen also used to fetch was answered, paid for and
   * thrown away -- and worse, it was the one the individual switches reloaded,
   * while every row on screen was drawn from this one. Changing a single
   * capability refreshed nothing an owner could see.
   */
  const packView = useResource<{ packs: ToolpackView[]; ungrouped: CapabilityView[] }>(
    `/api/agents/${agentId}/toolspace/packs`,
  );
  const history = useResource<{ items: Invocation[] }>(`/api/agents/${agentId}/toolspace/invocations`);
  /** Which pack has its individual capabilities showing. One at a time. */
  const [open, setOpen] = useState<string | null>(null);

  const packs = packView.data?.packs ?? [];
  const ungrouped = packView.data?.ungrouped ?? [];

  return (
    <Section
      id="capabilities"
      index={index}
      eyebrow="Capabilities"
      heading="What it can reach for"
      lede="What the model may choose while it is answering."
      explain="Reading is allowed by default, because an agent that looks something up unasked is useful. Anything that changes something stays off or asks until you say otherwise. This page shows what is set; Plugins is where it is changed."
    >
      {packView.loading && <Spinner />}

      <p className="text-[13px] leading-relaxed text-bone-dim break-words">
        These are set under{' '}
        <Link to="/plugins" className="underline underline-offset-2 hover:text-bone">
          Plugins
        </Link>
        , where each group is a Plugin and each capability has its own switch. Shown here so this page can say what
        the agent may reach for without being a second place to decide it.
      </p>

      {packs.map((pack, i) => (
        <IndexedRow key={pack.id} index={i + 1} label={PACK_WORDS[pack.state]} title={pack.name}>
          <p className="text-[13px] leading-relaxed text-bone-dim break-words">{pack.summary}</p>
          <p className="mt-1 text-[12px] leading-relaxed text-bone-faint break-words">{pack.detail}</p>

          <p className="mt-3 text-[12px] leading-relaxed text-bone-faint break-words">
            {pack.state === 'MIXED'
              ? 'Some of these have been set individually.'
              : pack.state === 'ON'
                ? 'On. Anything in it that changes something still asks or stays off.'
                : 'Off.'}{' '}
            <Link to="/plugins" className="underline underline-offset-2 hover:text-bone-dim">
              Change it under Plugins
            </Link>
          </p>

          <button
            type="button"
            className="mt-3 text-[12px] text-bone-faint underline underline-offset-2 hover:text-bone-dim"
            onClick={() => setOpen(open === pack.id ? null : pack.id)}
          >
            {open === pack.id ? 'Hide the individual capabilities' : `All ${pack.total} individually`}
          </button>

          {open === pack.id && (
            <div className="mt-3 border-t border-ink-line pt-3">
              {pack.capabilities.map((capability, j) => (
                <CapabilityRow key={capability.id} capability={capability} index={j} />
              ))}
            </div>
          )}
        </IndexedRow>
      ))}

      {ungrouped.length > 0 && (
        <>
          <SubHeading>Everything else</SubHeading>
          {ungrouped.map((capability, i) => (
            <CapabilityRow key={capability.id} capability={capability} index={i} />
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

function CapabilityRow({ capability, index }: { capability: CapabilityView; index: number }) {
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

      <p className="mt-3 text-[12px] leading-relaxed text-bone-dim break-words">
        {WORDS[capability.permission].label}. {WORDS[capability.permission].hint}
      </p>
    </IndexedRow>
  );
}
