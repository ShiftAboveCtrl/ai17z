/**
 * What an agent is actually doing, right now.
 *
 * The screen used to say RUNNING, and RUNNING was true of an agent waiting on a
 * dead provider, an agent whose Chrome had gone, an agent holding twelve replies
 * for review, and an agent happily answering mentions. One word for four
 * situations, three of which need somebody.
 *
 * Everything here is derived from work that exists: a job in a particular
 * state, a review queue with a length, a component that is failing. Nothing is
 * inferred from elapsed time or from the absence of evidence, because a status
 * that guesses is worse than one that says it does not know -- it is a status
 * somebody stops reading.
 *
 * Pure, so every branch can be exercised without a runtime.
 */
import type { AgentDiagnostics } from '@xbam/shared/contracts';

export const AGENT_ACTIVITIES = [
  /** Connected, nothing in hand, waiting for something to happen. */
  'LISTENING',
  /** Working out context, memory, or whether to answer at all. */
  'THINKING',
  /** Looking something up, which is the slowest step and worth naming. */
  'RESEARCHING',
  /** The model has the prompt and has not answered yet. */
  'WAITING_FOR_MODEL',
  'REPLYING',
  'POSTING',
  /** Deliberately stopped by a person. */
  'PAUSED',
  /** Nothing will happen until somebody does something. */
  'NEEDS_ATTENTION',
] as const;
export type AgentActivity = (typeof AGENT_ACTIVITIES)[number];

export interface JobInFlight {
  status: string;
  /** Which pipeline node it is on, when it is on one. */
  currentNodeKey: string | null;
  actionType: string;
}

export interface LiveStatusInput {
  diagnostics: AgentDiagnostics;
  /** Jobs currently held by a worker. */
  inFlight: JobInFlight[];
  /** Jobs that will not move until a person decides. */
  awaitingPeople: number;
}

export interface LiveStatus {
  activity: AgentActivity;
  /** One sentence, and never one that implies more is happening than is. */
  detail: string;
}

/** The parts whose failure means nothing can work, in the order worth reporting. */
function blockingProblem(d: AgentDiagnostics): string | null {
  if (d.worker.state === 'FAILING') return d.worker.detail;
  if (!d.account.connected) {
    return d.account.handle
      ? `The account @${d.account.handle} is ${d.account.status?.toLowerCase() ?? 'not connected'}.`
      : 'No account is connected, so there is nothing to read or reply to.';
  }
  const provider = d.providers.find((p) => p.state === 'FAILING');
  if (provider) return `${provider.name} is not answering, so nothing can be written.`;
  const browser = d.browser.find((b) => b.state === 'FAILING');
  if (browser) return `${browser.name} is not available, so nothing can be read or sent.`;
  return null;
}

/** What a job in flight is busy with, if it is on a step worth a word. */
function activityOf(job: JobInFlight): AgentActivity | null {
  if (job.currentNodeKey === 'research') return 'RESEARCHING';
  switch (job.status) {
    case 'GENERATING':
      return 'WAITING_FOR_MODEL';
    case 'EXECUTING':
      return job.actionType === 'POST' ? 'POSTING' : 'REPLYING';
    case 'CONTEXT_RESOLVING':
    case 'MEMORY_RETRIEVING':
    case 'VALIDATING':
      return 'THINKING';
    default:
      return null;
  }
}

/** Whichever of the things in hand is worth showing, when several are. */
const INTEREST: AgentActivity[] = ['POSTING', 'REPLYING', 'WAITING_FOR_MODEL', 'RESEARCHING', 'THINKING'];

export function liveStatus(input: LiveStatusInput): LiveStatus {
  const { diagnostics: d } = input;

  // Somebody stopped it. That is not a problem to be reported as one.
  if (!d.agent.canWork) {
    return {
      activity: d.agent.state === 'PAUSED' ? 'PAUSED' : 'NEEDS_ATTENTION',
      detail: d.agent.reason ?? `The agent is ${d.agent.state.toLowerCase()}.`,
    };
  }

  // Work in hand comes before problems, because an agent that is mid-reply is
  // doing that whatever else is also true, and saying so is more honest than
  // reporting a degraded monitor while a reply is being sent.
  const busy = input.inFlight.map(activityOf).filter((a): a is AgentActivity => a !== null);
  const doing = INTEREST.find((activity) => busy.includes(activity));
  if (doing) {
    return {
      activity: doing,
      detail:
        doing === 'WAITING_FOR_MODEL'
          ? 'The model has the prompt and has not answered yet.'
          : doing === 'RESEARCHING'
            ? 'Looking something up before answering.'
            : doing === 'POSTING'
              ? 'Sending a post of its own.'
              : doing === 'REPLYING'
                ? 'Sending a reply.'
                : 'Working out what this is about.',
    };
  }

  // Nothing in hand, and something is stopping it. This is the case the old
  // single RUNNING hid completely.
  const blocked = blockingProblem(d);
  if (blocked) return { activity: 'NEEDS_ATTENTION', detail: blocked };

  if (input.awaitingPeople > 0) {
    return {
      activity: 'NEEDS_ATTENTION',
      detail: `${input.awaitingPeople} ${input.awaitingPeople === 1 ? 'message is' : 'messages are'} waiting for you to decide.`,
    };
  }

  // A degraded monitor is worth saying without claiming nothing works, because
  // the other monitors are the reason it still does.
  const degraded = d.radar.filter((r) => r.state === 'FAILING' || r.state === 'DEGRADED');
  const healthy = d.radar.filter((r) => r.state === 'HEALTHY');
  if (degraded.length > 0 && healthy.length > 0) {
    return {
      activity: 'LISTENING',
      detail: `Listening. ${degraded[0]!.name} is not working, but ${healthy.length} other source${healthy.length === 1 ? '' : 's'} still ${healthy.length === 1 ? 'is' : 'are'}.`,
    };
  }
  if (degraded.length > 0) {
    return { activity: 'NEEDS_ATTENTION', detail: `${degraded[0]!.name} is not working, and nothing else is looking.` };
  }

  return {
    activity: 'LISTENING',
    detail: d.lastSuccess.poll ? 'Listening for mentions and replies.' : 'Connected, and has not polled yet.',
  };
}
