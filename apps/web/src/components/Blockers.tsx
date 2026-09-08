import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowRight } from 'lucide-react';
import type { Blocker } from '@xbam/shared/contracts';
import { blockerHref } from '@app/lib/blockers';

/**
 * What is stopping an agent from running, and where to go and fix it.
 *
 * This was written three times -- on the setup wizard's review step, on the
 * simplified agent view, and on the agent page -- with three headings for the
 * same list, three presentations, and three inline copies of the type. All
 * three dropped the `where` the API computes, so somebody told "no account is
 * connected" had to go and find the accounts panel themselves.
 *
 * One list, one wording, and the link the API was already describing.
 */
export function Blockers({
  blockers,
  agentId,
  heading,
  className = '',
}: {
  blockers: Blocker[];
  /** The agent the fixes live on, when there is one. Null during setup. */
  agentId?: string | null;
  /** Overrides the count sentence where the surrounding copy already says it. */
  heading?: string;
  className?: string;
}) {
  if (blockers.length === 0) return null;

  return (
    <div
      className={`space-y-2 rounded-xl border border-signal-wait/40 bg-signal-wait/[0.06] p-5 ${className}`}
      // Announced rather than silently appearing: pressing Start and having a
      // list arrive below the fold is indistinguishable from nothing happening.
      role="status"
    >
      <p className="flex items-center gap-2 text-sm text-bone">
        <AlertTriangle className="h-4 w-4 shrink-0 text-signal-wait" aria-hidden />
        {heading ?? (blockers.length === 1 ? 'One thing needs sorting.' : `${blockers.length} things need sorting.`)}
      </p>
      <ul className="space-y-1.5 pl-6">
        {blockers.map((blocker) => {
          const href = blockerHref(blocker, agentId ?? null);
          return (
            <li key={`${blocker.what}${blocker.fix}`} className="text-[13px] leading-relaxed text-bone-dim break-words">
              {blocker.what} <span className="text-bone-faint">{blocker.fix}</span>
              {href && (
                <Link
                  to={href}
                  className="ml-2 inline-flex items-center gap-1 whitespace-nowrap font-mono text-[10px] uppercase tracking-[0.18em] text-bone-faint hover:text-bone"
                >
                  Take me there
                  <ArrowRight className="h-3 w-3" aria-hidden />
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
