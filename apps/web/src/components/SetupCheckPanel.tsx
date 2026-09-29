import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, ChevronDown, CircleSlash, MinusCircle } from 'lucide-react';
import { useResource } from '@app/lib/hooks';
import { RetryablePanel, Spinner } from '@app/components/ui';

type CheckState = 'OK' | 'ATTENTION' | 'PROBLEM' | 'NOT_SET_UP';

interface SetupReport {
  checkedAt: string;
  counts: Record<CheckState, number>;
  sections: { key: string; label: string; checks: { key: string; state: CheckState; sentence: string; fix: { label: string; href: string } | null }[] }[];
}

const ICON: Record<CheckState, typeof CheckCircle2> = {
  OK: CheckCircle2,
  ATTENTION: AlertTriangle,
  PROBLEM: CircleSlash,
  NOT_SET_UP: MinusCircle,
};

const TONE: Record<CheckState, string> = {
  OK: 'text-signal-calm',
  ATTENTION: 'text-signal-wait',
  PROBLEM: 'text-signal-fail',
  NOT_SET_UP: 'text-bone-faint',
};

const WORD: Record<CheckState, string> = {
  OK: 'Fine',
  ATTENTION: 'Worth a look',
  PROBLEM: 'Needs fixing',
  NOT_SET_UP: 'Not set up',
};

/**
 * Setup and health, as concrete checks with a way to fix each one.
 *
 * Problems and things worth a look come first and are open; everything fine
 * or simply not set up is folded away, because a list of forty green ticks
 * hides the two that matter.
 */
export function SetupCheckPanel({ agentId }: { agentId: string }) {
  const report = useResource<SetupReport>(`/api/agents/${agentId}/setup-check`);
  const [showAll, setShowAll] = useState(false);

  if (report.loading && !report.data) {
    return (
      <p className="flex items-center gap-2 text-sm text-bone-faint">
        <Spinner className="h-3.5 w-3.5" /> Checking its setup
      </p>
    );
  }
  if (report.error || !report.data) {
    return <RetryablePanel title="Its setup could not be checked." detail={report.error ?? 'No answer came back.'} onRetry={report.reload} />;
  }

  const { counts, sections } = report.data;
  const urgent = sections.flatMap((s) => s.checks.filter((c) => c.state === 'PROBLEM' || c.state === 'ATTENTION').map((c) => ({ ...c, section: s.label })));
  urgent.sort((a, b) => (a.state === b.state ? 0 : a.state === 'PROBLEM' ? -1 : 1));

  return (
    <section aria-labelledby="setup-check-title" className="rounded-lg border border-ink-line bg-ink-panel p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id="setup-check-title" className="text-bone">
          Setup and health
        </h3>
        <p className="text-[12px] text-bone-faint">
          {counts.PROBLEM > 0 && `${counts.PROBLEM} to fix · `}
          {counts.ATTENTION > 0 && `${counts.ATTENTION} worth a look · `}
          {counts.OK} fine{counts.NOT_SET_UP > 0 && ` · ${counts.NOT_SET_UP} not set up`}
        </p>
      </div>

      {urgent.length === 0 ? (
        <p className="mt-3 text-sm text-bone-dim">Nothing needs you. Anything not set up is listed below and is not a fault.</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {urgent.map((c) => (
            <CheckRow key={`${c.section}-${c.key}`} check={c} section={c.section} />
          ))}
        </ul>
      )}

      <button type="button" className="btn-quiet mt-3 px-0 text-xs" aria-expanded={showAll} onClick={() => setShowAll((v) => !v)}>
        <ChevronDown className={`h-3 w-3 transition-transform ${showAll ? 'rotate-180' : ''}`} aria-hidden />
        {showAll ? 'Hide the full check' : 'Show every check'}
      </button>
      {showAll && (
        <div className="mt-3 space-y-4">
          {sections.map((s) => (
            <div key={s.key}>
              <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-bone-faint">{s.label}</p>
              <ul className="mt-1 space-y-1.5">
                {s.checks.map((c) => (
                  <CheckRow key={c.key} check={c} />
                ))}
                {s.checks.length === 0 && <li className="text-sm text-bone-faint">Nothing to check.</li>}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function CheckRow({
  check,
  section,
}: {
  check: { state: CheckState; sentence: string; fix: { label: string; href: string } | null };
  section?: string;
}) {
  const Icon = ICON[check.state];
  return (
    <li className="flex items-start gap-2.5 text-sm">
      <Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${TONE[check.state]}`} aria-label={WORD[check.state]} />
      <span className="min-w-0 break-words text-bone-dim">
        {section && <span className="text-bone-faint">{section}: </span>}
        {check.sentence}{' '}
        {check.fix && (
          <Link to={check.fix.href} className="whitespace-nowrap text-bone underline decoration-bone-faint underline-offset-2 hover:decoration-bone">
            {check.fix.label}
          </Link>
        )}
      </span>
    </li>
  );
}
