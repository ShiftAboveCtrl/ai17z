import { post } from '@app/lib/api';
import { useResource } from '@app/lib/hooks';
import { timeAgo } from '@app/lib/format';
import { ErrorPanel, Spinner, StatusDot } from './ui';
import { Explain } from './Explain';

/**
 * What the agent is allowed to do on its own, and what it is doing about it.
 *
 * One panel rather than four screens, because an owner asking "why has it gone
 * quiet" cannot know in advance whether the answer is the hour, the budget,
 * the account's health or somebody who asked to be left alone. Any of the four
 * could be it, so all four are here.
 *
 * Nothing about prompts, memories or what the agent is thinking. This is about
 * restraint, and restraint is the owner's business.
 */

interface Autonomy {
  growth: {
    policy: {
      enabled: boolean;
      timezone: string;
      quietHoursStart: number;
      quietHoursEnd: number;
      maxSessionsPerDay: number;
      sessionMinutes: number;
      cooldownMinutes: number;
      maxModelCallsPerDay: number;
      maxResearchPerDay: number;
    };
    state: 'OPEN' | 'RESTING' | 'QUIET_HOURS' | 'SPENT' | 'OFF' | 'HELD';
    allowed: boolean;
    message: string;
    sessionOpenSince: string | null;
    sessionsToday: number;
    spentToday: { modelCalls: number; researchCalls: number; publicActions: number };
  };
  accountHealth: {
    health: 'HEALTHY' | 'DEGRADED' | 'COOLDOWN' | 'HUMAN_ACTION_REQUIRED';
    healthReason: string | null;
    healthUntil: string | null;
    healthChangedAt: string | null;
  };
  doNotContact: { id: string; handle: string; source: string; evidence: string | null; createdAt: string }[];
  learned: { family: string; accepted: number; rejected: number; lastDecisionAt: string }[];
}

/** Resting is not broken, and the colours have to say so. */
const GROWTH_TONE: Record<Autonomy['growth']['state'], 'live' | 'wait' | 'fail' | 'idle'> = {
  OPEN: 'live',
  RESTING: 'idle',
  QUIET_HOURS: 'idle',
  SPENT: 'idle',
  OFF: 'idle',
  HELD: 'wait',
};

const HEALTH_TONE: Record<Autonomy['accountHealth']['health'], 'live' | 'wait' | 'fail' | 'idle'> = {
  HEALTHY: 'live',
  DEGRADED: 'wait',
  COOLDOWN: 'wait',
  HUMAN_ACTION_REQUIRED: 'fail',
};

const HEALTH_WORDS: Record<Autonomy['accountHealth']['health'], string> = {
  HEALTHY: 'working normally',
  DEGRADED: 'having some trouble',
  COOLDOWN: 'resting after trouble',
  HUMAN_ACTION_REQUIRED: 'needs you',
};

const hh = (hour: number) => `${String(hour).padStart(2, '0')}:00`;

export function AutonomyPanel({ agentId }: { agentId: string }) {
  const data = useResource<Autonomy>(`/api/agents/${agentId}/autonomy`);

  const contactAgain = async (entryId: string) => {
    await post(`/api/agents/${agentId}/autonomy/contact-again/${entryId}`, {});
    data.reload();
  };

  if (data.loading && !data.data) return <Spinner />;
  if (data.error) return <ErrorPanel title="Could not read what this agent is allowed to do." detail={data.error} />;
  if (!data.data) return null;

  const { growth, accountHealth, doNotContact, learned } = data.data;

  return (
    <section className="space-y-8">
      <header>
        <h2 className="text-lg text-bone">Going looking for people</h2>
        <Explain label="this" className="mt-2">
          <p><strong>These are ceilings, not targets.</strong> An agent that has used none of its allowance is not behind on anything.</p>
          <p>None of it applies to somebody who writes to your agent. A mention arriving in the middle of the quiet window is still answered.</p>
        </Explain>
      </header>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <StatusDot state={GROWTH_TONE[growth.state]} />
          <span className="text-sm text-bone">{growth.state.toLowerCase().replace(/_/g, ' ')}</span>
          {growth.sessionOpenSince && (
            <span className="font-mono text-[10px] text-bone-faint">started {timeAgo(growth.sessionOpenSince)}</span>
          )}
        </div>
        {/* The sentence, always. "Growth is paused" tells nobody anything. */}
        <p className="break-words text-sm text-bone-dim">{growth.message}</p>

        <dl className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
          <Row label="Quiet hours">
            {growth.policy.quietHoursStart === growth.policy.quietHoursEnd
              ? 'none'
              : `${hh(growth.policy.quietHoursStart)} to ${hh(growth.policy.quietHoursEnd)} ${growth.policy.timezone}`}
          </Row>
          <Row label="Sessions today">
            {growth.sessionsToday} of {growth.policy.maxSessionsPerDay}
          </Row>
          <Row label="Session length">{growth.policy.sessionMinutes} minutes, then {growth.policy.cooldownMinutes} resting</Row>
          <Row label="Optional model calls today">
            {growth.spentToday.modelCalls} of {growth.policy.maxModelCallsPerDay}
          </Row>
          <Row label="Things looked up today">
            {growth.spentToday.researchCalls} of {growth.policy.maxResearchPerDay}
          </Row>
          <Row label="Public actions today">{growth.spentToday.publicActions}</Row>
        </dl>
      </div>

      <div className="space-y-2 border-t border-ink-line pt-6">
        <div className="flex flex-wrap items-center gap-3">
          <StatusDot state={HEALTH_TONE[accountHealth.health]} />
          <span className="text-sm text-bone">The account is {HEALTH_WORDS[accountHealth.health]}</span>
          {accountHealth.healthChangedAt && accountHealth.health !== 'HEALTHY' && (
            <span className="font-mono text-[10px] text-bone-faint">since {timeAgo(accountHealth.healthChangedAt)}</span>
          )}
        </div>
        {/* Naming what was seen, never just the state. "DEGRADED" is a colour. */}
        {accountHealth.healthReason && (
          <p className="break-words text-sm text-bone-dim">{accountHealth.healthReason}</p>
        )}
      </div>

      <div className="space-y-3 border-t border-ink-line pt-6">
        <h3 className="text-sm text-bone">People who asked to be left alone</h3>
        {doNotContact.length === 0 ? (
          <p className="text-sm text-bone-faint">Nobody has asked this agent to stop contacting them.</p>
        ) : (
          <ul className="divide-y divide-ink-line border-y border-ink-line">
            {doNotContact.map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-start gap-x-4 gap-y-1 py-3">
                <span className="text-sm text-bone">@{entry.handle}</span>
                <span className="font-mono text-[10px] text-bone-faint">
                  {entry.source === 'OWNER' ? 'you added this' : 'they asked'} · {timeAgo(entry.createdAt)}
                </span>
                {/* Their own words, so the decision can be checked rather than
                    taken on trust. */}
                {entry.evidence && (
                  <p className="w-full break-words text-xs leading-relaxed text-bone-dim">“{entry.evidence}”</p>
                )}
                <button type="button" className="btn-quiet ml-auto px-0 text-xs" onClick={() => void contactAgain(entry.id)}>
                  Allow contact again
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {learned.length > 0 && (
        <div className="space-y-3 border-t border-ink-line pt-6">
          <h3 className="text-sm text-bone">What your decisions have taught it</h3>
          <Explain label="what this does" className="mb-1">
            <p>This changes <strong>what you are shown first</strong>, and nothing else.</p>
            <p>It can never grant a permission, skip an approval, or let the agent do something it could not do before.</p>
          </Explain>
          <ul className="space-y-1.5">
            {learned.map((row) => (
              <li key={row.family} className="flex flex-wrap items-baseline gap-x-3 text-sm">
                <span className="break-words text-bone-dim">{row.family.replace(/[:_]/g, ' ')}</span>
                <span className="font-mono text-[10px] text-bone-faint">
                  {row.accepted} approved · {row.rejected} turned down · {timeAgo(row.lastDecisionAt)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 border-b border-ink-line/50 pb-1.5">
      <dt className="text-bone-faint">{label}</dt>
      <dd className="break-words text-bone-dim">{children}</dd>
    </div>
  );
}
