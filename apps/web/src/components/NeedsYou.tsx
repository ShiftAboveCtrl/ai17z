import { Link } from 'react-router-dom';
import { AlertTriangle, Check } from 'lucide-react';
import type { Agent, AgentAccountRow, ModelConfig } from '@app/lib/types';

/**
 * What to do next, in the order it matters.
 *
 * The problem this solves is not that AI17Z fails to explain itself -- almost
 * every screen does. It is that the explanations are spread across fifteen
 * places, and somebody who has just made their first agent has no idea which of
 * them applies to them right now. They are told what a vision model is, on a
 * screen they have not opened, about a problem they do not yet know they have.
 *
 * So this answers one question on the page people land on: is anything stopping
 * this agent working, and what do I press. Three rules keep it honest:
 *
 *   - **Only what is actually true now.** Nothing speculative, nothing that
 *     might matter later. A list that cries wolf gets scrolled past.
 *   - **Blockers before warnings.** An agent with no model cannot run at all;
 *     an agent with no vision model runs and admits it cannot see pictures.
 *     Sorting those together would bury the one that matters.
 *   - **Every item goes somewhere.** A problem with no button is a complaint.
 *
 * When there is nothing, it says so in one line and gets out of the way. An
 * empty checklist that still occupies half a screen is furniture.
 */

interface Item {
  /** Blockers stop the agent working at all. Warnings narrow what it can do. */
  kind: 'blocker' | 'warning';
  title: string;
  detail: string;
  action: { label: string; area?: string; to?: string };
}

function build(agent: Agent, accounts: AgentAccountRow[], models: ModelConfig[]): Item[] {
  const items: Item[] = [];

  const connected = accounts.filter((a) => a.status === 'CONNECTED');
  const needsUser = accounts.filter((a) => a.status === 'CHALLENGE_REQUIRES_USER');

  // First, because AI17Z never answers a security challenge and nothing at all
  // happens on that account until a person does.
  for (const account of needsUser) {
    items.push({
      kind: 'blocker',
      title: `@${account.handle} is waiting for you`,
      detail:
        'X asked for a code, a CAPTCHA or a confirmation. AI17Z never answers those, so the browser window is open and waiting for you to finish signing in.',
      action: { label: 'Open accounts', area: 'reach' },
    });
  }

  if (accounts.length === 0) {
    items.push({
      kind: 'blocker',
      title: 'No account connected',
      detail: 'There is nothing for this agent to read or reply to until you connect one.',
      action: { label: 'Connect an account', area: 'reach' },
    });
  } else if (connected.length === 0 && needsUser.length === 0) {
    items.push({
      kind: 'blocker',
      title: 'No account is signed in',
      detail: 'The accounts here exist but none of them currently has a working session.',
      action: { label: 'Open accounts', area: 'reach' },
    });
  }

  if (!models.some((m) => m.role === 'primary')) {
    items.push({
      kind: 'blocker',
      title: 'No model chosen',
      detail: 'This is what the agent thinks with. Without one it cannot write anything at all.',
      action: { label: 'Choose a model', area: 'reach' },
    });
  }

  // Only worth saying once the agent could otherwise run. Telling somebody
  // their stopped agent is stopped, while it also has no model and no account,
  // is three complaints about one unfinished setup.
  if (agent.state !== 'ACTIVE' && items.length === 0) {
    items.push({
      kind: 'blocker',
      title: 'The agent is stopped',
      detail: 'Everything is configured. Nothing is read and no browser is open until you start it.',
      action: { label: 'Start it', area: 'overview' },
    });
  }

  if (!models.some((m) => m.role === 'vision')) {
    items.push({
      kind: 'warning',
      title: 'It cannot see pictures',
      detail:
        'Someone asking about a screenshot will be told the agent could not see it. That is honest, but it cannot answer the question.',
      action: { label: 'Add a vision model', area: 'reach' },
    });
  }

  return items;
}

export function NeedsYou({
  agent,
  accounts,
  models,
  onGo,
}: {
  agent: Agent;
  accounts: AgentAccountRow[];
  models: ModelConfig[];
  onGo?: (area: string) => void;
}) {
  const items = build(agent, accounts, models);
  const blockers = items.filter((i) => i.kind === 'blocker');

  if (items.length === 0) {
    return (
      <div className="mt-6 flex items-center gap-2.5 rounded-xl border border-signal-live/25 bg-signal-live/[0.05] px-4 py-3">
        <Check className="h-4 w-4 shrink-0 text-signal-live" aria-hidden />
        <p className="text-sm text-bone-dim">Everything this agent needs is set up.</p>
      </div>
    );
  }

  return (
    <div className="mt-6">
      <p className="eyebrow mb-3">
        {blockers.length > 0 ? 'Before this can work' : 'Worth knowing'}
      </p>
      <ul className="divide-y divide-ink-line overflow-hidden rounded-xl border border-ink-line">
        {items.map((item) => (
          <li key={item.title} className="flex flex-wrap items-start gap-x-4 gap-y-2 px-4 py-3.5">
            <AlertTriangle
              className={`mt-0.5 h-4 w-4 shrink-0 ${item.kind === 'blocker' ? 'text-signal-fail' : 'text-signal-wait'}`}
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <p className="text-sm text-bone">{item.title}</p>
              <p className="mt-1 max-w-prose text-[13px] leading-relaxed text-bone-faint">{item.detail}</p>
            </div>
            {item.action.to ? (
              <Link className="btn-quiet shrink-0" to={item.action.to}>
                {item.action.label}
              </Link>
            ) : (
              <button type="button" className="btn-quiet shrink-0" onClick={() => onGo?.(item.action.area ?? 'overview')}>
                {item.action.label}
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
