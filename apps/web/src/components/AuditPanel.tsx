import { useState } from 'react';
import { ScrollText } from 'lucide-react';
import { useResource } from '@app/lib/hooks';
import { timeAgo } from '@app/lib/format';
import { ChoiceGroup, ChoiceOption, EmptyState, ErrorPanel, Spinner } from '@app/components/ui';

/**
 * What has been done to this installation, and by whom.
 *
 * Fifty-three places in the codebase write an audit row and nothing read one.
 * The route named for the audit log returned the AI4CZ import history, so an
 * owner had no way to see who paused their agents or approved a reply.
 *
 * That became a real gap rather than an untidy one when Telegram grew a command
 * surface: a paired chat can pause every agent and decide what they send, and
 * "remote control of somebody's accounts is worth a row" is only true if the
 * row is reachable.
 *
 * Deliberately a list to scan rather than something to query. An audit log with
 * a search box is a promise about an index nobody has, and the answer an owner
 * wants here is "what happened recently", which is the default order.
 */

interface AuditEvent {
  id: string;
  actorUserId: string | null;
  actorEmail: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  data: Record<string, unknown>;
  at: string;
}

interface AuditView {
  items: AuditEvent[];
  actions: { action: string; count: number }[];
}

/**
 * The prefix is the subsystem, which is the only grouping worth offering.
 *
 * `telegram.pause` and `telegram.approve` belong together because the question
 * is "what has been done from my phone", not "was it a pause".
 */
function familyOf(action: string): string {
  const [head] = action.split('.');
  return head || action;
}

/** What the row means, without repeating the machine name beside it. */
function readable(action: string): string {
  const parts = action.split('.');
  const verb = parts[parts.length - 1] ?? action;
  return verb.replace(/[_-]/g, ' ');
}

export function AuditPanel() {
  const [family, setFamily] = useState<string | null>(null);
  const audit = useResource<AuditView>(`/api/audit?limit=200${family ? `&action=${encodeURIComponent(family)}` : ''}`, [
    family,
  ]);

  const families = [...new Set((audit.data?.actions ?? []).map((entry) => familyOf(entry.action)))].sort();
  const items = audit.data?.items ?? [];

  return (
    <div>
      <p className="mb-4 max-w-prose text-sm leading-relaxed text-bone-dim">
        Everything anybody has done to this installation, newest first. Approving a reply, pausing every agent,
        connecting an account, and anything sent from Telegram all land here.
      </p>

      {families.length > 0 && (
        <ChoiceGroup label="Which part of AI17Z">
          <ChoiceOption selected={family === null} onSelect={() => setFamily(null)}>
            Everything
          </ChoiceOption>
          {families.map((entry) => (
            <ChoiceOption key={entry} selected={family === entry} onSelect={() => setFamily(entry)}>
              {entry}
            </ChoiceOption>
          ))}
        </ChoiceGroup>
      )}

      {audit.error && <ErrorPanel title="That could not be read." detail={audit.error} />}
      {audit.loading && !audit.data && (
        <div className="mt-4">
          <Spinner />
        </div>
      )}

      {audit.data && items.length === 0 && (
        <div className="mt-4">
          <EmptyState
            title="Nothing recorded yet"
            detail={
              family
                ? 'Nothing in this part of AI17Z has been done yet.'
                : 'Actions appear here as soon as anybody does something on this installation.'
            }
          />
        </div>
      )}

      {items.length > 0 && (
        <ul className="mt-4 space-y-1.5">
          {items.map((item) => (
            <li key={item.id} className="rounded-lg border border-ink-line px-3.5 py-2.5">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-[13px] text-bone">{readable(item.action)}</span>
                <span className="font-mono text-[11px] text-bone-faint">{item.entityType}</span>
                <span className="ml-auto font-mono text-[11px] text-bone-faint">{timeAgo(item.at)}</span>
              </div>
              <p className="mt-1 break-words font-mono text-[11px] leading-relaxed text-bone-faint">
                {item.action}
                {item.actorEmail ? ` · ${item.actorEmail}` : ' · nobody signed in'}
                {item.entityId ? ` · ${item.entityId}` : ''}
              </p>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-4 flex items-center gap-2 text-[11px] text-bone-faint">
        <ScrollText className="h-3 w-3" aria-hidden />
        Kept on this machine. Nothing here is sent anywhere.
      </p>
    </div>
  );
}
