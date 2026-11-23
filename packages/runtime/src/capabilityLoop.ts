import { capabilityInvocations } from '@xbam/database';
import { createLogger, type Logger } from '@xbam/shared';
import type { AutonomyLevel, ChatMessage } from '@xbam/shared/contracts';
import { permissionWhenUnset, type CapabilityPermission } from '@xbam/shared/contracts';
import {
  invokeCapability,
  getCapability,
  listModelCallable,
  parseTurn,
  renderInstructions,
  renderMenu,
  type AnyCapability,
  type InvocationResult,
} from '@xbam/tools';
import { zodToDescription } from './capabilityInputShape';
import { shortlistCapabilities, type Shortlist } from './capabilityRelevance';

const log = createLogger('capability-loop');

/**
 * The loop AI17Z did not have.
 *
 * `docs/ENGINEERING.md` said, correctly, that the model never chooses a tool:
 * the runtime looks things up itself and passes evidence, and a switch for
 * something nothing calls is worse than no switch. That stays true of research
 * -- deciding whether to search is a decision about the shape of a question and
 * it happens before the prompt is assembled. This is the other case: a model
 * part-way through an answer that needs one specific fact it does not have.
 *
 * Three properties make it safe to let a model choose at all:
 *
 *   **Bounded.** A fixed number of steps and one wall-clock budget for the
 *   whole loop. A model that keeps asking runs out of asks, and the job
 *   continues with what it has rather than hanging.
 *
 *   **Narrow.** It chooses from declared capabilities with schemas, not from a
 *   shell. Every argument is parsed before an implementation sees it.
 *
 *   **Recorded.** Every step, including every refusal, is a row. An owner can
 *   see what their agent asked for and what it was told.
 *
 * What it deliberately does not do is decide anything. Permission is the
 * owner's, the schema is the capability's, and the loop only carries answers
 * back.
 */
export interface LoopOptions {
  agentId: string;
  jobId: string | null;
  accountId: string | null;
  /** The conversation so far. The loop appends to a copy. */
  messages: ChatMessage[];
  /** Runs one model call. Supplied so the loop never picks a model itself. */
  generate(messages: ChatMessage[]): Promise<string>;
  /**
   * What was actually asked, for choosing the menu.
   *
   * Supplied by the caller because only the caller knows it. `messages` is the
   * assembled prompt, and its last user message is not a question: it is the
   * whole user layer, with memory, evidence, the sender, output rules and the
   * task framing around one line of incoming text. Judging relevance against
   * that block offers reads for the words in the framing.
   *
   * Absent falls back to the last user message, which is right for a caller
   * that really is holding a conversation rather than assembling a prompt.
   */
  task?: string;
  /** What the owner configured, by capability id. Absent means the default. */
  permissions: Map<string, CapabilityPermission>;
  paused: boolean;
  /**
   * OWNER only in owner chat. Everything else is a conversation somebody else
   * can read, and is never shown what an OWNER capability returns.
   */
  audience?: 'PUBLIC' | 'OWNER';
  /** The owner message being answered, in owner chat. Never set anywhere else. */
  origin?: { conversationId: string; messageId: string; text: string; ownerId: string | null } | null;
  /** Per-agent capability configuration, by capability id. */
  configs?: Map<string, Record<string, unknown>>;
  maxSteps?: number;
  budgetMs?: number;
  logger?: Logger;
  /** A wake owns the plan; the loop remains the only capability executor. */
  goalPlan?: {
    checkpoint(): Promise<{
      permissions: Map<string, CapabilityPermission>;
      configs: Map<string, Record<string, unknown>>;
      paused: boolean;
      autonomy: AutonomyLevel;
      enabled: boolean;
    }>;
    onStep(step: LoopResult['steps'][number], index: number): Promise<void>;
  };
}

export interface LoopResult {
  /** What the model finally wrote, with no capability call in it. */
  answer: string;
  steps: {
    capabilityId: string;
    outcome: string;
    detail: string;
    durationMs: number;
    /** What it returned, validated, or null on anything but success. */
    output: unknown;
    input?: unknown;
  }[];
  /** True when the loop stopped because it ran out of steps or time. */
  exhausted: boolean;
  halted?: 'PROPOSED' | 'STOPPED';
  reason?: string;
  /**
   * What was on offer, and how much was narrowed away to get there.
   *
   * Carried out so a caller can record it: "the model was shown these eight of
   * seventy-three" is the difference between a capability nobody wanted and one
   * the agent never saw, and those need different fixes.
   */
  shortlist: Shortlist;
}

/**
 * The text a shortlist is judged against: **what was asked, and nothing else.**
 *
 * The last thing a person said. Not the whole conversation, because an exchange
 * that mentioned GitHub twenty minutes ago should not keep offering repository
 * reads to somebody now asking about the weather.
 *
 * And **not the system layer**, which is the fix here. It used to be included on
 * the reasoning that it frames the job, and on a fixture it is short enough to
 * do no harm. On a real job it is the assembled persona: measured at 3,767
 * characters against a fifty-character question, listing every subject the agent
 * writes about. So the shortlist stopped being about the question and became
 * about the agent's interests, which are the same for every message it ever
 * receives.
 *
 * Measured on a live installation, asked "what time is it where you are right
 * now, actually": with the question alone the shortlist is `time.now`; with the
 * system layer appended it is eight GitHub, contract and market reads and
 * `time.now` does not appear at all. The agent answered "I couldn't check the
 * current time", which is exactly the symptom shortlisting was added to remove,
 * reintroduced one layer up.
 *
 * A task that genuinely needs the agent's own context still gets it: the model
 * has the whole prompt when it decides. This only chooses what to put on the
 * menu, and a menu chosen from the persona is the same menu every time.
 */
export function taskText(messages: ChatMessage[]): string {
  const lastUser = [...messages].reverse().find((message) => message.role === 'user');
  return lastUser?.content ?? '';
}

/**
 * Four is not arbitrary.
 *
 * One is enough for "what time is it". Two covers a lookup that names the
 * subject of a second. Beyond four the model is usually not gathering evidence
 * but circling -- and each step is a full model call, so the ceiling is also
 * what stops one reply costing what ten should.
 */
const DEFAULT_MAX_STEPS = 4;

/** Long enough for a browser read, short enough that a job is not held open. */
const DEFAULT_BUDGET_MS = 90_000;

export async function runCapabilityLoop(options: LoopOptions): Promise<LoopResult> {
  const logger = options.logger ?? log;
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  const deadline = Date.now() + budgetMs;

  /**
   * What this agent may actually reach for, not everything that exists.
   *
   * The menu used to be the whole registry. Two things were wrong with that.
   * An owner who switched the Crypto pack off still had all of its capabilities
   * described to their agent, which could then choose one and be refused --
   * spending a step and a model call to be told no. And the menu is prompt: at
   * the time of writing, 38 capabilities are about 2,700 tokens on every
   * generation, and the catalogue is going to keep growing.
   *
   * So a capability switched off is not offered. One that asks first still is:
   * the model is allowed to ask, and the owner's approval is the point of that
   * setting rather than a reason to hide it.
   */
  const audience = options.audience ?? 'PUBLIC';
  const available = listModelCallable().filter((capability) => {
    if (capability.audience === 'OWNER' && audience !== 'OWNER') return false;
    const stored = options.permissions.get(capability.id) ?? null;
    return (stored ?? permissionWhenUnset(capability)) !== 'DISABLED';
  });

  /*
    Everything available is not the same as everything worth showing.

    The menu is prompt, and the catalogue outgrew the question: seventy-three
    capabilities render 20,535 characters, against a 3,010-character prompt on
    an ordinary reply. Measured on a live agent with this loop enabled, that
    menu produced no capability call at all -- asked the time in Tokyo it ran a
    web search and answered "I don't know" while `time.now` was listed.

    So the model is shown the few that bear on what it is answering. Narrowing,
    not gating: every one of these was already permitted, and a task that
    matches nothing is offered nothing, which is the right answer for "nice
    one" and costs no tokens at all.
  */
  const shortlist: Shortlist = shortlistCapabilities(
    available,
    options.task?.trim() || taskText(options.messages),
  );
  const offered = shortlist.offered;
  const messages: ChatMessage[] = [...options.messages];
  const steps: LoopResult['steps'] = [];

  // Nothing to choose from is not a failure and does not need a menu: the model
  // is asked the question it was always going to be asked.
  if (offered.length > 0) {
    messages.push({ role: 'system', content: preamble(offered) });
  }
  logger.debug('capabilities offered to the model', {
    considered: shortlist.considered,
    offered: offered.length,
    families: shortlist.families,
    ids: offered.map((capability) => capability.id),
  });

  let exhausted = false;
  for (let step = 1; step <= maxSteps; step += 1) {
    if (Date.now() >= deadline) {
      exhausted = true;
      break;
    }

    // Recheck before spending a model call as well as before using its choice.
    // PAUSE ALL stops planning itself, and a permission read must fail closed.
    const before = await options.goalPlan?.checkpoint();
    if (before && (before.paused || !before.enabled)) {
      return { answer: '', steps, exhausted: false, shortlist, halted: 'STOPPED',
        reason: before.paused ? 'Everything is paused.' : 'The goal or its capability loop is no longer enabled.' };
    }
    if (options.goalPlan && Date.now() >= deadline) { exhausted = true; break; }

    const raw = await options.generate(messages);
    const turn = parseTurn(raw);

    // A slow model cannot spend the remaining budget and then start a remote
    // action. No extra final model call belongs to an exhausted goal plan.
    if (options.goalPlan && Date.now() >= deadline) {
      exhausted = true;
      break;
    }

    const current = await options.goalPlan?.checkpoint();
    if (current && (current.paused || !current.enabled)) {
      return { answer: '', steps, exhausted: false, shortlist, halted: 'STOPPED',
        reason: current.paused ? 'Everything is paused.' : 'The goal or its capability loop is no longer enabled.' };
    }
    if (options.goalPlan && Date.now() >= deadline) { exhausted = true; break; }

    if (turn.kind === 'answer') {
      return { answer: turn.text, steps, exhausted: false, shortlist };
    }

    if (turn.kind === 'malformed') {
      // Told once, plainly, and then it is a step like any other. A model that
      // cannot write the call after being shown the error twice is not going to
      // on the third attempt, and the budget is what stops that being infinite.
      messages.push({ role: 'assistant', content: raw });
      messages.push({ role: 'system', content: `That was not a usable capability call: ${turn.reason}` });
      if (step === maxSteps) exhausted = true;
      continue;
    }

    const wasOffered = offered.some(capability => capability.id === turn.call.id);
    if (wasOffered && current && current.autonomy !== 'ACT') {
      const parsed = getCapability(turn.call.id)?.input.safeParse(turn.call.input);
      const detail = 'Proposed for the owner; this agent is below ACT.';
      const stoppedStep = { capabilityId: turn.call.id, outcome: 'PROPOSED',
        detail, durationMs: 0, output: null, input: parsed?.success ? parsed.data : null };
      steps.push(stoppedStep);
      await options.goalPlan!.onStep(stoppedStep, step);
      return { answer: '', steps, exhausted: false, shortlist, halted: 'PROPOSED', reason: detail };
    }

    // A model can name something absent from its menu. Record the refusal
    // through the same path as an invocation without running readiness or code.
    const parsed = !wasOffered ? getCapability(turn.call.id)?.input.safeParse(turn.call.input) : undefined;
    const result: InvocationResult = !wasOffered ? {
      capabilityId: turn.call.id,
      outcome: 'REFUSED',
      detail: "That capability was not offered on this turn's menu.",
      durationMs: 0,
      input: parsed?.success ? parsed.data : null,
      output: null,
    } : await invokeCapability({
      call: turn.call,
      context: {
        agentId: options.agentId,
        jobId: options.jobId,
        accountId: options.accountId,
        config: (current?.configs ?? options.configs)?.get(turn.call.id) ?? {},
        audience,
        origin: audience === 'OWNER' ? (options.origin ?? null) : null,
        logger,
      },
      permission: {
        stored: (current?.permissions ?? options.permissions).get(turn.call.id) ?? null,
        paused: current?.paused ?? options.paused,
      },
      ...(options.goalPlan ? { budgetMs: Math.max(0, deadline - Date.now()) } : {}),
    });

    steps.push({
      capabilityId: result.capabilityId,
      outcome: result.outcome,
      detail: result.detail,
      durationMs: result.durationMs,
      output: result.output,
      input: result.input,
    });

    // Recorded before the model is told, so a crash between the two leaves
    // evidence that it happened rather than evidence that it did not.
    await capabilityInvocations
      .recordInvocation({
        agentId: options.agentId,
        jobId: options.jobId,
        accountId: options.accountId,
        capabilityId: result.capabilityId,
        step,
        outcome: result.outcome,
        detail: result.detail,
        input: result.input,
        output: result.output,
        durationMs: result.durationMs,
      })
      .catch((error: unknown) => {
        // A failed audit write must not take the job with it, but it is a real
        // problem: the loop is only safe because it is observable.
        logger.error('capability invocation could not be recorded', {
          capabilityId: result.capabilityId,
          message: error instanceof Error ? error.message : String(error),
        });
      });

    if (options.goalPlan) {
      await options.goalPlan.onStep(steps[steps.length - 1]!, step);
      // Retrying a denied step cannot restore a grant. A new wake must not
      // revive this plan either; its owner records the terminal result.
      if (result.outcome !== 'SUCCEEDED') {
        if (result.outcome === 'TIMED_OUT' && Date.now() >= deadline) {
          return { answer: '', steps, exhausted: true, shortlist,
            reason: 'The plan ended because its time budget was exhausted.' };
        }
        return { answer: '', steps, exhausted: false, shortlist, halted: 'STOPPED', reason: result.detail };
      }
    }

    messages.push({ role: 'assistant', content: raw });
    messages.push({ role: 'system', content: describeResult(result) });

    if (step === maxSteps) exhausted = true;
  }

  if (options.goalPlan) {
    return { answer: '', steps, exhausted, shortlist,
      reason: Date.now() >= deadline ? 'The plan ended because its time budget was exhausted.'
        : 'The plan ended because its step budget was exhausted.' };
  }

  // Out of steps or out of time. The model gets one last turn with everything
  // it gathered and no menu, because offering capabilities it cannot use is how
  // a final answer becomes another call.
  messages.push({
    role: 'system',
    content:
      'You have no more lookups available. Answer with what you have. ' +
      'If something is still unknown, say so plainly rather than guessing it.',
  });
  const finalRaw = await options.generate(messages);
  const finalTurn = parseTurn(finalRaw);
  const answer = finalTurn.kind === 'answer' ? finalTurn.text : stripCalls(finalRaw);
  return { answer, steps, exhausted, shortlist };
}

function preamble(offered: AnyCapability[]): string {
  return [
    'Capabilities you may use before answering:',
    '',
    renderMenu(offered, (c) => zodToDescription(c.input)),
    '',
    renderInstructions(),
  ].join('\n');
}

/**
 * What the model is told about a result.
 *
 * A refusal reads as a fact about the world rather than an error, because that
 * is what it is: the owner switched something off, and the model's job is to
 * answer anyway. Wording it as a failure invites an apology in the reply.
 */
function describeResult(result: {
  capabilityId: string;
  outcome: string;
  detail: string;
  output: unknown;
}): string {
  if (result.outcome !== 'SUCCEEDED') {
    return `${result.capabilityId} did not run: ${result.detail}`;
  }
  return `${result.capabilityId} returned:\n${JSON.stringify(result.output)}`;
}

/** Last resort: a model that answered with a call in it still said something. */
function stripCalls(text: string): string {
  return text.replace(/<use-capability>[\s\S]*?<\/use-capability>/g, '').trim();
}
