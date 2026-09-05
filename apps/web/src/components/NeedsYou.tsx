import { AlertTriangle, Check } from 'lucide-react';
import type { Agent, AgentAccountRow, AgentStats, ModelConfig } from '@app/lib/types';

/**
 * What to do next, in the order it matters.
 *
 * This is two things wearing one name, because they are the same question asked
 * at different moments.
 *
 * **Before an agent has ever worked**, it is a path. Somebody who has just made
 * their first agent does not need a list of everything that could be wrong;
 * they need the next step, and a sense that there are three of them and not
 * thirty. So the steps are numbered, the finished ones are ticked, and exactly
 * one is live. Nothing else competes with it -- an agent with no account is not
 * also told it has no vision model, because that is true of every new agent and
 * saying it now is noise on top of the thing that actually matters.
 *
 * **Once it is running**, it is a list of what is wrong, blockers first, and
 * usually empty.
 *
 * The rules that hold in both:
 *
 *   - **Only what is true now.** A list that cries wolf gets scrolled past.
 *   - **Every item goes somewhere.** A problem with no button is a complaint.
 *   - **Nothing wrong is one line**, not an empty checklist occupying a screen.
 */

interface Step {
  title: string;
  detail: string;
  done: boolean;
  action: { label: string; area: string };
}

interface Problem {
  kind: 'blocker' | 'warning';
  title: string;
  detail: string;
  action: { label: string; area: string };
}

/** The three things an agent cannot work without, in the order you would do them. */
function setupPath(agent: Agent, accounts: AgentAccountRow[], models: ModelConfig[]): Step[] {
  return [
    {
      title: 'Connect an account',
      detail: 'The account it reads and replies from. A browser window opens and you sign in yourself.',
      done: accounts.length > 0,
      action: { label: 'Connect', area: 'reach' },
    },
    {
      title: 'Choose a model',
      detail: 'What it thinks with. You bring your own provider key, and it is stored encrypted.',
      done: models.some((m) => m.role === 'primary'),
      action: { label: 'Choose', area: 'reach' },
    },
    {
      title: 'Start it',
      detail: 'Nothing is read and no browser opens until you do. You can stop it again at any time.',
      done: agent.state === 'ACTIVE',
      action: { label: 'Start', area: 'overview' },
    },
  ];
}

function problems(agent: Agent, accounts: AgentAccountRow[], models: ModelConfig[]): Problem[] {
  const items: Problem[] = [];

  // First, because AI17Z never answers a security challenge and nothing at all
  // happens on that account until a person does.
  for (const account of accounts.filter((a) => a.status === 'CHALLENGE_REQUIRES_USER')) {
    items.push({
      kind: 'blocker',
      title: `@${account.handle} is waiting for you`,
      detail:
        'X asked for a code, a CAPTCHA or a confirmation. AI17Z never answers those, so the browser window is open and waiting for you to finish signing in.',
      action: { label: 'Open accounts', area: 'reach' },
    });
  }

  const connected = accounts.filter((a) => a.status === 'CONNECTED');
  if (accounts.length > 0 && connected.length === 0 && items.length === 0) {
    items.push({
      kind: 'blocker',
      title: 'No account is signed in',
      detail: 'The accounts here exist but none of them currently has a working session.',
      action: { label: 'Open accounts', area: 'reach' },
    });
  }

  if (agent.state !== 'ACTIVE') {
    items.push({
      kind: 'blocker',
      title: 'The agent is stopped',
      detail: 'Nothing is read and no browser is open until you start it.',
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
  stats,
  onGo,
}: {
  agent: Agent;
  accounts: AgentAccountRow[];
  models: ModelConfig[];
  stats?: AgentStats;
  onGo?: (area: string) => void;
}) {
  const steps = setupPath(agent, accounts, models);
  const remaining = steps.filter((s) => !s.done);

  // Still being set up: anything essential missing, or it has never done a
  // thing. An agent that has replied to somebody is past this even if it is
  // stopped right now.
  const neverRun = (stats?.jobsTotal ?? 0) === 0 && !stats?.lastActivityAt;
  if (remaining.length > 0 && (neverRun || remaining.length > 1)) {
    const next = steps.findIndex((s) => !s.done);
    return (
      <div className="mt-6">
        <p className="eyebrow mb-3">
          Set this agent up &middot; {steps.length - remaining.length} of {steps.length} done
        </p>
        <ol className="divide-y divide-ink-line overflow-hidden rounded-xl border border-ink-line">
          {steps.map((step, index) => {
            const current = index === next;
            return (
              <li
                key={step.title}
                className={`flex flex-wrap items-start gap-x-4 gap-y-2 px-4 py-3.5 ${
                  step.done ? 'opacity-55' : current ? '' : 'opacity-45'
                }`}
              >
                <span
                  className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border font-mono text-[10px] ${
                    step.done
                      ? 'border-signal-live/50 text-signal-live'
                      : current
                        ? 'border-signal-calm/60 text-signal-calm'
                        : 'border-ink-line text-bone-faint'
                  }`}
                >
                  {step.done ? <Check className="h-3 w-3" aria-hidden /> : index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className={`text-sm ${step.done ? 'text-bone-dim line-through decoration-bone-faint/40' : 'text-bone'}`}>
                    {step.title}
                  </p>
                  {/* Only the step you are on explains itself. Three
                      paragraphs of instructions for three steps is a wall. */}
                  {current && <p className="mt-1 max-w-prose text-[13px] leading-relaxed text-bone-faint">{step.detail}</p>}
                </div>
                {current && (
                  <button type="button" className="btn-primary shrink-0" onClick={() => onGo?.(step.action.area)}>
                    {step.action.label}
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      </div>
    );
  }

  const items = problems(agent, accounts, models);
  if (items.length === 0) {
    return (
      <div className="mt-6 flex items-center gap-2.5 rounded-xl border border-signal-live/25 bg-signal-live/[0.05] px-4 py-3">
        <Check className="h-4 w-4 shrink-0 text-signal-live" aria-hidden />
        <p className="text-sm text-bone-dim">Everything this agent needs is set up.</p>
      </div>
    );
  }

  const blockers = items.filter((i) => i.kind === 'blocker');
  return (
    <div className="mt-6">
      <p className="eyebrow mb-3">{blockers.length > 0 ? 'Before this can work' : 'Worth knowing'}</p>
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
            <button type="button" className="btn-quiet shrink-0" onClick={() => onGo?.(item.action.area)}>
              {item.action.label}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
