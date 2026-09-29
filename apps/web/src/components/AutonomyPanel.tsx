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
      quietHoursEnabled: boolean;
      timezone: string;
      quietHoursStart: number;
      quietHoursEnd: number;
      maxSessionsPerHour: number;
      maxSessionsPerDay: number;
      sessionMinutes: number;
      cooldownMinutes: number;
      maxModelCallsPerDay: number;
      maxResearchPerDay: number;
    };
    state: 'OPEN' | 'ELIGIBLE' | 'RESTING' | 'QUIET_HOURS' | 'SPENT' | 'OFF' | 'HELD';
    allowed: boolean;
    message: string;
    nextEligibleAt: string | null;
    sessionOpenSince: string | null;
    lastSessionEndedAt: string | null;
    sessionsThisHour: number;
    sessionsToday: number;
    spentToday: { modelCalls: number; researchCalls: number; publicActions: number };
  };
  accountHealth: {
    health: 'HEALTHY' | 'DEGRADED' | 'COOLDOWN' | 'HUMAN_ACTION_REQUIRED';
    healthReason: string | null;
    healthUntil: string | null;
    healthChangedAt: string | null;
  };
  xCapacity: {
    health: 'HEALTHY' | 'DEGRADED' | 'COOLDOWN' | 'HUMAN_ACTION_REQUIRED';
    reason: string | null;
    until: string | null;
    strikes: number;
    readsLast10Minutes: number;
    readsByClass: { DIRECT: number; TARGET: number; BROAD: number };
    budgetPer10Minutes: number;
    pushbackLastHour: { rateLimited: number; stalled: number; broken: number };
  } | null;
  broadGrowth: {
    seen: number;
    queued: number;
    declined: number;
    topDecline: { reason: string; count: number } | null;
    medianQueuedFollowers: number | null;
    published: number;
  };
  responses: { answered: number; p50Seconds: number | null; p90Seconds: number | null; modelCallsPerAnswer: number | null };
  habits: { phrase: string; posts: number }[];
  learning: {
    enabled: boolean;
    outcomes: number;
    choices: {
      dimension: string;
      trust: number;
      kept: number;
      reverted: number;
      options: { arm: string; label: string; placed: number; evidence: number }[];
      current: { arm: string; label: string; status: 'RUNNING' | 'KEPT' } | null;
    }[];
    trials: {
      dimension: string;
      label: string;
      status: string;
      hypothesis: string;
      verdict: string | null;
      startedAt: string;
      decidedAt: string | null;
      samples: { withChange: number; control: number; neededWithChange: number; neededControl: number; decidesBy: string } | null;
    }[];
    rules?: { controlWhileTesting: string; controlAfterKeeping: string; measuredAfterHours: number; neverTouches: string[] };
    ownerFeedback?: { rejectedThisWeek: number; acceptedThisWeek: number };
  };
  doNotContact: { id: string; handle: string; source: string; evidence: string | null; createdAt: string }[];
  learned: { family: string; accepted: number; rejected: number; lastDecisionAt: string }[];
  targets: {
    id: string;
    handle: string;
    displayName: string | null;
    mode: 'WATCH' | 'PRIORITIZE' | 'ENGAGE';
    enabled: boolean;
    priority: number;
    lastSeenAt: string | null;
    lastProcessedAt: string | null;
    lastInteractionAt: string | null;
    pacedUntil: string | null;
    pacedReason: string | null;
    latestDisposition: string | null;
    latestReason: string | null;
    latestDecidedAt: string | null;
  }[];
}

/** Resting is not broken, and the colours have to say so. */
const GROWTH_TONE: Record<Autonomy['growth']['state'], 'live' | 'wait' | 'fail' | 'idle'> = {
  OPEN: 'live',
  ELIGIBLE: 'live',
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
  const resetLearning = async () => {
    await post(`/api/agents/${agentId}/learning/reset`, {});
    data.reload();
  };

  if (data.loading && !data.data) return <Spinner />;
  if (data.error) return <ErrorPanel title="Could not read what this agent is allowed to do." detail={data.error} />;
  if (!data.data) return null;

  const { growth, accountHealth, doNotContact, learned, targets, xCapacity, broadGrowth, responses, habits, learning } = data.data;

  return (
    <section className="space-y-8">
      <header>
        <h2 className="text-lg text-bone">Going looking for people</h2>
        <Explain label="this" className="mt-2">
          <p><strong>These are ceilings, not targets.</strong> An agent that has used none of its allowance is not behind on anything.</p>
          <p>None of it applies to somebody who writes to your agent. Direct mentions and watched-account posts still take priority.</p>
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
        {growth.nextEligibleAt && (
          <p className="font-mono text-[10px] text-bone-faint">
            Next eligible {new Date(growth.nextEligibleAt).toLocaleString()}
          </p>
        )}

        <dl className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
          <Row label="Quiet hours">
            {!growth.policy.quietHoursEnabled
              ? 'off for this agent'
              : growth.policy.quietHoursStart === growth.policy.quietHoursEnd
                ? 'none'
                : `${hh(growth.policy.quietHoursStart)} to ${hh(growth.policy.quietHoursEnd)} ${growth.policy.timezone}`}
          </Row>
          <Row label="Growth sessions this hour">
            {growth.sessionsThisHour} of {growth.policy.maxSessionsPerHour}
          </Row>
          <Row label="Growth sessions today">
            {growth.sessionsToday}{growth.policy.maxSessionsPerDay === 0 ? ' · no daily stop' : ` of ${growth.policy.maxSessionsPerDay}`}
          </Row>
          <Row label="Session length">{growth.policy.sessionMinutes} minutes, then {growth.policy.cooldownMinutes} resting</Row>
          <Row label="Optional model calls today">
            {growth.spentToday.modelCalls} of {growth.policy.maxModelCallsPerDay}
          </Row>
          <Row label="Things looked up today">
            {growth.spentToday.researchCalls} of {growth.policy.maxResearchPerDay}
          </Row>
          <Row label="Public actions today">{growth.spentToday.publicActions}</Row>
          <Row label="Last session ended">
            {growth.sessionOpenSince
              ? `running since ${timeAgo(growth.sessionOpenSince)}`
              : growth.lastSessionEndedAt
                ? timeAgo(growth.lastSessionEndedAt)
                : 'never'}
          </Row>
        </dl>

        {/* What its own looking came to. A quiet agent should say which of these was the reason. */}
        <dl className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
          <Row label="Posts it came across today">{broadGrowth.seen}</Row>
          <Row label="Taken for a closer look">{broadGrowth.queued}</Row>
          <Row label="Replied to in public">{broadGrowth.published}</Row>
          <Row label="Typical audience of those it took">
            {broadGrowth.medianQueuedFollowers === null
              ? 'not reported by X'
              : `${broadGrowth.medianQueuedFollowers.toLocaleString()} followers`}
          </Row>
        </dl>
        {broadGrowth.topDecline && (
          <p className="break-words text-xs text-bone-faint">
            Most often declined because: {broadGrowth.topDecline.reason} ({broadGrowth.topDecline.count}).
          </p>
        )}

        {/* How it has been answering. Arrival to a checked draft, over the last day. */}
        <dl className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
          <Row label="Answers drafted today">{responses.answered}</Row>
          <Row label="Typical time to a draft">
            {responses.p50Seconds === null
              ? 'nothing drafted yet'
              : `${Math.round(responses.p50Seconds)}s, slowest tenth ${Math.round(responses.p90Seconds ?? responses.p50Seconds)}s`}
          </Row>
          <Row label="Model calls per answer">
            {responses.modelCallsPerAnswer === null ? 'none yet' : responses.modelCallsPerAnswer}
          </Row>
        </dl>
        {habits.length > 0 && (
          <p className="break-words text-xs text-bone-faint">
            Keeps reaching for: {habits.map((h) => `"${h.phrase}" (${h.posts} times)`).join(', ')}. It is told to avoid these in its next replies.
          </p>
        )}
      </div>

      <LearningSection learning={learning} onReset={resetLearning} />

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
        {xCapacity && (
          <dl className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
            <Row label="Reads of X, last ten minutes">
              {xCapacity.readsLast10Minutes} of {xCapacity.budgetPer10Minutes}
              {' '}({xCapacity.readsByClass.DIRECT} direct, {xCapacity.readsByClass.TARGET} watched, {xCapacity.readsByClass.BROAD} looking)
            </Row>
            <Row label="X pushed back, last hour">
              {xCapacity.pushbackLastHour.rateLimited + xCapacity.pushbackLastHour.stalled + xCapacity.pushbackLastHour.broken === 0
                ? 'not at all'
                : `${xCapacity.pushbackLastHour.rateLimited} slow down, ${xCapacity.pushbackLastHour.stalled} never drew, ${xCapacity.pushbackLastHour.broken} error pages`}
            </Row>
            {xCapacity.until && (
              <Row label={xCapacity.health === 'COOLDOWN' ? 'Cooling down until' : 'Reading less until'}>
                {new Date(xCapacity.until).toLocaleString()}
              </Row>
            )}
          </dl>
        )}
      </div>

      <div className="space-y-3 border-t border-ink-line pt-6">
        <h3 className="text-sm text-bone">Owner-designated targets</h3>
        {targets.length === 0 ? (
          <p className="text-sm text-bone-faint">No tracked account has produced a post yet.</p>
        ) : (
          <ul className="space-y-2">
            {targets.map((target) => (
              <li key={target.id} className="rounded-lg border border-ink-line bg-black/20 p-3">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="text-sm text-bone">@{target.handle}</span>
                  {target.displayName && <span className="text-xs text-bone-dim">{target.displayName}</span>}
                  <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-bone-faint">
                    {target.enabled ? target.mode.toLowerCase() : 'disabled'} · priority {target.priority}
                  </span>
                </div>
                <p className="mt-2 break-words text-sm text-bone-dim">
                  {target.latestDisposition
                    ? target.latestDisposition.toLowerCase().replace(/_/g, ' ')
                    : 'No post considered yet'}
                  {target.latestReason ? `: ${target.latestReason}` : ''}
                </p>
                <p className="mt-1 font-mono text-[10px] text-bone-faint">
                  {target.lastSeenAt ? `seen ${timeAgo(target.lastSeenAt)}` : 'not seen yet'}
                  {target.lastProcessedAt ? ` · processed ${timeAgo(target.lastProcessedAt)}` : ''}
                  {target.lastInteractionAt ? ` · interacted ${timeAgo(target.lastInteractionAt)}` : ''}
                </p>
                {target.pacedUntil && (
                  <p className="mt-1 text-xs text-signal-wait">
                    Paced until {new Date(target.pacedUntil).toLocaleString()}
                    {target.pacedReason ? `. ${target.pacedReason}` : ''}
                  </p>
                )}
              </li>
            ))}
          </ul>
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

const CHOICE_TITLES: Record<string, string> = {
  mode: 'Where it looks',
  length: 'How long it writes',
  question: 'Whether it asks',
  audience: 'Whose posts it favours',
};

/**
 * What it has learned from how its own replies and posts did.
 *
 * Every line is a measurement or a test with its verdict, never a claim the
 * agent made about itself. "Placed" is where an option's results sit in the
 * agent's own range, so fifty per cent is its ordinary.
 */
function LearningSection({ learning, onReset }: { learning: Autonomy['learning']; onReset: () => Promise<void> }) {
  const shown = learning.choices.filter((c) => c.options.length > 0 || c.current);
  return (
    <div id="learning" className="scroll-mt-24 space-y-3 border-t border-ink-line pt-6">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm text-bone">What it has learned</span>
        <span className="font-mono text-[10px] text-bone-faint">
          {learning.enabled ? `${learning.outcomes} measured replies and posts` : 'learning is switched off in Policies'}
        </span>
        {learning.outcomes > 0 && (
          <button
            type="button"
            className="btn-quiet ml-auto px-0 text-xs"
            onClick={() => {
              if (window.confirm('Forget everything this agent learned from its outcomes? Its rules and limits are not affected.')) void onReset();
            }}
          >
            Forget what it learned
          </button>
        )}
      </div>
      {shown.length === 0 ? (
        <p className="text-xs text-bone-faint">
          Nothing yet. A change is only tried once the evidence is clear.
        </p>
      ) : (
        <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
          {shown.map((choice) => (
            <div key={choice.dimension}>
              <dt className="text-xs text-bone-faint">{CHOICE_TITLES[choice.dimension] ?? choice.dimension}</dt>
              <dd className="mt-1 space-y-0.5">
                {choice.current && (
                  <p className="break-words text-bone">
                    {choice.current.status === 'RUNNING' ? 'Testing' : 'Leaning into'} {choice.current.label}
                  </p>
                )}
                {choice.options.slice(0, 3).map((option) => (
                  <p key={option.arm} className="break-words text-[12px] text-bone-dim">
                    {option.label}: placed {Math.round(option.placed * 100)}%, {option.evidence} measured
                  </p>
                ))}
                {(choice.kept > 0 || choice.reverted > 0) && (
                  <p className="text-[11px] text-bone-faint">
                    {choice.kept} kept, {choice.reverted} undone, so it {choice.trust >= 1 ? 'trusts' : 'is wary of'} its own changes here
                  </p>
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {learning.trials.length > 0 && (
        <ul className="space-y-2">
          {learning.trials.slice(0, 5).map((trial) => (
            <li key={`${trial.dimension}-${trial.startedAt}`} className="break-words text-xs leading-relaxed text-bone-dim">
              <span className="font-mono text-[10px] text-bone-faint">
                {trial.status === 'RUNNING' ? 'testing' : trial.status === 'KEPT' ? 'kept' : 'undone'} · started {timeAgo(trial.startedAt)}
                {trial.decidedAt && ` · decided ${timeAgo(trial.decidedAt)}`}
              </span>{' '}
              {trial.status === 'RUNNING' ? trial.hypothesis : (trial.verdict ?? trial.hypothesis)}
              {trial.samples && (
                <span className="block text-[11px] text-bone-faint">
                  Measured so far: {trial.samples.withChange} of {trial.samples.neededWithChange} with the change,{' '}
                  {trial.samples.control} of {trial.samples.neededControl} without it. Decided once both are reached, or{' '}
                  {new Date(trial.samples.decidesBy).toLocaleDateString()} at the latest.
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {learning.enabled && learning.rules && (
        <div className="space-y-1 text-[11px] leading-relaxed text-bone-faint">
          <p>
            Each reply and post is measured about {learning.rules.measuredAfterHours} hours after it goes out. {learning.rules.controlWhileTesting}{' '}
            {learning.rules.controlAfterKeeping}
          </p>
          <p>It can never change its {learning.rules.neverTouches.join(', ')}.</p>
          {learning.ownerFeedback && (learning.ownerFeedback.rejectedThisWeek > 0 || learning.ownerFeedback.acceptedThisWeek > 0) && (
            <p>
              Your decisions this week: {learning.ownerFeedback.acceptedThisWeek} approved, {learning.ownerFeedback.rejectedThisWeek} rejected. An
              approach you rejected holds further approaches to that person for a week.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
