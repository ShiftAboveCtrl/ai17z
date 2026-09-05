import { useState } from 'react';
import { useResource } from '@app/lib/hooks';
import { EmptyState, Spinner } from '@app/components/ui';
import { Section } from './Section';

interface Metrics {
  windowDays: number;
  engagement: { engaged: number; ignored: number; review: number };
  intents: { intent: string; n: number }[];
  quality: { voice: number | null; generic: number | null; repetition: number | null; samples: number };
  rewrites: { none: number; light: number; model: number };
  stanceConflicts: number;
  actions: { executed: number; dryRun: number };
  medianPublishedChars: number | null;
}

interface ProviderRow {
  provider: string;
  model: string;
  calls: number;
  medianChars: number | null;
}

/**
 * How the agent is actually behaving.
 *
 * Deliberately not framed as engagement metrics: an agent optimised for replies
 * per hour is a worse agent. These are the numbers that say whether it is
 * behaving like the thing it was configured to be.
 */
export function BehaviourSection({ index, agentId }: { index: number; agentId: string }) {
  const [days, setDays] = useState(7);
  const { data, loading } = useResource<{ metrics: Metrics; providers: ProviderRow[] }>(
    `/api/agents/${agentId}/evaluation?days=${days}`,
    [days],
  );

  const metrics = data?.metrics;
  const decided = metrics ? metrics.engagement.engaged + metrics.engagement.ignored + metrics.engagement.review : 0;

  return (
    <Section
      id="behaviour"
      index={index}
      eyebrow="Behaviour"
      heading="What it has been doing."
      lede="Counted from what actually happened, not from a running tally. Nothing here is an engagement metric: an agent optimised for replies per hour is a worse agent."
      explain={
        <>
          <p><strong>How it decides whether to answer at all</strong>, and how much of the other person's tone to take on.</p>
          <p>Not replying is a real answer here, with its reasons recorded. Hostility is met by stepping back rather than matching it, which is how an agent avoids ending up in an argument on your behalf.</p>
        </>
      }
    >
      <div className="mb-6 flex gap-2">
        {[1, 7, 30].map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setDays(option)}
            className={`rounded-lg border px-3 py-1.5 text-xs transition-colors ${
              days === option
                ? 'border-signal-calm/60 bg-signal-calm/[0.07] text-bone'
                : 'border-ink-line text-bone-dim hover:border-bone-faint'
            }`}
          >
            {option === 1 ? 'Today' : `${option} days`}
          </button>
        ))}
      </div>

      {loading && !data ? (
        <Spinner />
      ) : decided === 0 && (metrics?.actions.executed ?? 0) === 0 ? (
        <EmptyState
          title="Nothing yet in this window."
          detail="Once the agent has handled some events, this shows how selective it has been and how closely it has stayed in voice."
        />
      ) : (
        <div className="space-y-10">
          <div>
            <p className="eyebrow mb-3">What it did with what arrived</p>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Answered" value={metrics!.engagement.engaged} />
              <Stat label="Stayed silent" value={metrics!.engagement.ignored} />
              <Stat label="Asked you" value={metrics!.engagement.review} tone="wait" />
              <Stat label="Published" value={metrics!.actions.executed} />
            </div>
            {decided > 0 && (
              <p className="mt-3 text-xs leading-relaxed text-bone-faint">
                It answered {Math.round((metrics!.engagement.engaged / decided) * 100)}% of what reached it.
                {metrics!.medianPublishedChars !== null &&
                  ` Typical reply: ${metrics!.medianPublishedChars} characters.`}
              </p>
            )}
          </div>

          {metrics!.quality.samples > 0 && (
            <div>
              <p className="eyebrow mb-3">How it sounded</p>
              <div className="grid grid-cols-3 gap-3">
                <Stat label="Voice match" value={metrics!.quality.voice ?? 0} suffix="/100" />
                <Stat label="Generic AI" value={metrics!.quality.generic ?? 0} suffix="/100" tone={(metrics!.quality.generic ?? 0) > 30 ? 'wait' : undefined} />
                <Stat label="Repetition" value={metrics!.quality.repetition ?? 0} suffix="/100" tone={(metrics!.quality.repetition ?? 0) > 40 ? 'wait' : undefined} />
              </div>
              <p className="mt-3 text-xs leading-relaxed text-bone-faint">
                Averaged over {metrics!.quality.samples} replies.{' '}
                {metrics!.rewrites.none + metrics!.rewrites.light + metrics!.rewrites.model > 0 && (
                  <>
                    {metrics!.rewrites.none} needed no work, {metrics!.rewrites.light} were tidied, and{' '}
                    {metrics!.rewrites.model} needed a model rewrite.
                  </>
                )}
              </p>
            </div>
          )}

          {metrics!.intents.length > 0 && (
            <div>
              <p className="eyebrow mb-3">What kind of replies</p>
              {/* A distribution, not a total: one intent dominating is worth
                  seeing, and is usually a persona that needs adjusting. */}
              <ul className="space-y-1.5">
                {metrics!.intents.slice(0, 8).map((row) => {
                  const total = metrics!.intents.reduce((sum, i) => sum + i.n, 0);
                  return (
                    <li key={row.intent} className="flex items-center gap-3">
                      <span className="w-32 shrink-0 font-mono text-[10px] uppercase tracking-[0.14em] text-bone-faint">
                        {row.intent.toLowerCase()}
                      </span>
                      <span className="h-1 flex-1 overflow-hidden rounded-full bg-ink-line">
                        <span
                          className="block h-full bg-bone-faint"
                          style={{ width: `${Math.round((row.n / total) * 100)}%` }}
                        />
                      </span>
                      <span className="w-8 shrink-0 text-right font-mono text-[10px] tabular-nums text-bone-faint">
                        {row.n}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {(data?.providers.length ?? 0) > 0 && (
            <div>
              <p className="eyebrow mb-3">Which model wrote it</p>
              <p className="mb-3 max-w-xl text-xs leading-relaxed text-bone-faint">
                If one provider's replies come out systematically longer than another's after the voice pass, the
                provider is leaking into the identity.
              </p>
              <ul className="divide-y divide-ink-line border-y border-ink-line">
                {data!.providers.map((row) => (
                  <li key={`${row.provider}/${row.model}`} className="flex flex-wrap items-baseline gap-x-4 py-2.5">
                    <span className="font-mono text-xs text-bone">{row.model}</span>
                    <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-bone-faint">
                      {row.provider}
                    </span>
                    <span className="ml-auto font-mono text-[10px] tabular-nums text-bone-faint">
                      {row.calls} calls
                      {row.medianChars !== null && ` · median ${Math.round(row.medianChars)} chars`}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {metrics!.stanceConflicts > 0 && (
            <p className="text-sm text-signal-wait">
              {metrics!.stanceConflicts} draft{metrics!.stanceConflicts === 1 ? '' : 's'} contradicted a position the
              agent already held. Worth reading those in Activity.
            </p>
          )}
        </div>
      )}
    </Section>
  );
}

function Stat({
  label,
  value,
  suffix,
  tone,
}: {
  label: string;
  value: number;
  suffix?: string;
  tone?: 'wait';
}) {
  return (
    <div>
      <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-bone-faint">{label}</p>
      <p className={`mt-1 font-mono text-2xl font-light tabular-nums ${tone === 'wait' ? 'text-signal-wait' : 'text-bone'}`}>
        {value}
        {suffix && <span className="text-sm text-bone-faint">{suffix}</span>}
      </p>
    </div>
  );
}
