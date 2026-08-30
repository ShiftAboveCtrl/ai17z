import type { BrowserTabStatus } from '@xbam/shared/contracts';
import { usePolling, useResource } from '@app/lib/hooks';
import { timeAgo } from '@app/lib/format';
import { StatusDot } from './ui';

/**
 * What the account's three browser tabs are doing.
 *
 * The point of showing this at all: "the mentions monitor died half an hour
 * ago" and "nobody has mentioned you" look identical from outside. One of them
 * needs fixing.
 *
 * The worker publishes this snapshot, because the API owns no browsers and
 * cannot ask. `tabsUpdatedAt` is how a stale snapshot is caught — if nothing
 * has published for a while there is no browser running, whatever the last
 * snapshot said.
 */

const ROLE_WORDS: Record<BrowserTabStatus['role'], { name: string; does: string }> = {
  ACTION: { name: 'Acting', does: 'Replies and posts happen here.' },
  MENTIONS: { name: 'Mentions', does: 'Looks for people talking to it.' },
  NOTIFICATIONS: { name: 'Notifications', does: "X's own notifications, as a second opinion." },
  RESEARCH: { name: 'Looking things up', does: 'Reads the open web when a mention is about something current.' },
};

/** Older than this and the snapshot is describing a browser that has gone. */
const STALE_MS = 90_000;

interface SessionPayload {
  session: {
    tabs?: BrowserTabStatus[];
    tabsUpdatedAt?: string | null;
  } | null;
}

export function BrowserTabsPanel({ accountId }: { accountId: string }) {
  const session = useResource<SessionPayload>(`/api/accounts/${accountId}/session`, [accountId]);
  usePolling(() => session.reload(), 10_000, true);

  const tabs = session.data?.session?.tabs ?? [];
  const updatedAt = session.data?.session?.tabsUpdatedAt ?? null;
  if (tabs.length === 0) return null;

  const stale = !updatedAt || Date.now() - new Date(updatedAt).getTime() > STALE_MS;

  return (
    <div className="rounded-xl border border-ink-line bg-ink-raised/30 p-5">
      <div className="mb-4 flex items-baseline justify-between gap-3">
        <p className="eyebrow">Browser</p>
        <span className="font-mono text-[10px] text-bone-faint">
          {stale ? 'no browser running' : `checked ${timeAgo(updatedAt)}`}
        </span>
      </div>

      <ul className="divide-y divide-ink-line">
        {tabs.map((tab) => {
          const words = ROLE_WORDS[tab.role];
          // A snapshot nobody has refreshed describes a browser that has closed,
          // so every tab in it is reported as gone rather than as healthy.
          const state = stale ? 'MISSING' : tab.state;
          return (
            <li key={tab.role} className="flex items-start justify-between gap-4 py-3">
              <div className="min-w-0">
                <p className="flex items-center gap-2 text-[13px] text-bone-dim">
                  <StatusDot state={state === 'READY' || state === 'BUSY' ? 'live' : state === 'MISSING' ? 'idle' : 'fail'} />
                  {words.name}
                </p>
                <p className="mt-0.5 pl-4 text-[11px] leading-relaxed text-bone-faint">
                  {state === 'FAILED' && tab.lastError ? tab.lastError : words.does}
                </p>
              </div>
              <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.14em] text-bone-faint">
                {state === 'MISSING'
                  ? 'not open'
                  : state === 'BUSY'
                    ? 'working'
                    : state === 'FAILED'
                      ? 'failing'
                      : tab.lastUsedAt
                        ? timeAgo(tab.lastUsedAt)
                        : 'ready'}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
