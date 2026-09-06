import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpCircle } from 'lucide-react';
import { get } from '@app/lib/api';
import type { UpdateState } from '@app/components/UpdatePanel';

/**
 * That there is a newer version, said once and quietly.
 *
 * A link, not a dialog. Nothing is blocked, nothing is scheduled, and there is
 * no second reminder -- the only way this becomes insistent is by somebody
 * clicking it. It renders nothing at all when there is no update, when the
 * check is switched off, when the version was skipped, or when the check
 * failed, so an installation with no internet never shows a broken badge.
 *
 * The read is free: the API answers from a cache at most six hours old, so
 * mounting this on every page costs nothing outbound.
 */
export function UpdateBadge() {
  const [state, setState] = useState<UpdateState | null>(null);

  useEffect(() => {
    let cancelled = false;
    // A failure here is silence. An update badge is the least important thing
    // on the page and has no business reporting its own problems.
    void get<UpdateState>('/api/updates')
      .then((next) => {
        if (!cancelled) setState(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  if (!state?.updateAvailable || !state.latest) return null;

  return (
    <Link
      to="/settings#version"
      className="flex shrink-0 items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-signal-wait transition-colors hover:text-bone"
      title={`${state.latest.name} has been released. Nothing updates on its own.`}
      aria-label={`${state.latest.name} is available`}
    >
      <ArrowUpCircle className="h-3.5 w-3.5" aria-hidden />
      {/*
        The number goes below `md`, the icon stays. Seven controls already
        overflowed a 375px bar, which is why the detail switch moved to its own
        row -- but an update nobody on a phone can see is not a notice, and the
        icon alone is four characters' worth of space.
      */}
      <span className="hidden md:inline">v{state.latest.version}</span>
    </Link>
  );
}
