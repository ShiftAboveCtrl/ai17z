import { Link, NavLink, useLocation } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { LogOut, Plus } from 'lucide-react';
import { useSession } from '@app/lib/session';

/**
 * Deliberately not a persistent sidebar. Navigation stays out of the way until
 * the page is scrolled, then earns a background.
 */
export function TopBar() {
  const { signOut, user } = useSession();
  const { pathname } = useLocation();
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const link = ({ isActive }: { isActive: boolean }) =>
    `font-mono text-[11px] uppercase tracking-[0.18em] transition-colors ${
      isActive ? 'text-bone' : 'text-bone-faint hover:text-bone-dim'
    }`;

  return (
    <header
      className={`fixed inset-x-0 top-0 z-40 transition-colors duration-300 ${
        scrolled ? 'border-b border-ink-line bg-ink/85 backdrop-blur-md' : 'border-b border-transparent'
      }`}
    >
      <nav className="mx-auto flex max-w-page items-center gap-4 px-5 py-4 sm:gap-8 sm:px-8">
        <Link to="/" className="font-semibold tracking-monument text-bone" aria-label="XBAM home">
          XBAM
        </Link>

        <div className="hidden items-center gap-6 sm:flex">
          <NavLink to="/" end className={link}>
            Agents
          </NavLink>
          <NavLink to="/activity" className={link}>
            Activity
          </NavLink>
          <NavLink to="/settings" className={link}>
            Settings
          </NavLink>
        </div>

        <div className="ml-auto flex items-center gap-2 sm:gap-3">
          {pathname !== '/agents/new' && (
            <Link to="/agents/new" className="btn-ghost px-3 py-2 text-xs sm:px-4">
              <Plus className="h-3.5 w-3.5" aria-hidden />
              <span className="hidden sm:inline">Create agent</span>
              <span className="sm:hidden">New</span>
            </Link>
          )}
          <button
            type="button"
            onClick={() => void signOut()}
            className="btn-quiet p-2"
            aria-label={`Sign out ${user?.displayName ?? ''}`}
            title="Sign out"
          >
            <LogOut className="h-4 w-4" aria-hidden />
          </button>
        </div>
      </nav>

      {/* Mobile navigation sits under the bar rather than behind a menu button. */}
      <div className="flex items-center gap-5 border-t border-ink-line/60 px-5 py-2.5 sm:hidden">
        <NavLink to="/" end className={link}>
          Agents
        </NavLink>
        <NavLink to="/activity" className={link}>
          Activity
        </NavLink>
        <NavLink to="/settings" className={link}>
          Settings
        </NavLink>
      </div>
    </header>
  );
}
