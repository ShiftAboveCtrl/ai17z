import { capabilityInvocations } from '@xbam/database';
import { createLogger, type Logger } from '@xbam/shared';
import type { ChatMessage } from '@xbam/shared/contracts';
import { defaultPermission, type CapabilityPermission } from '@xbam/shared/contracts';
import {
  invokeCapability,
  listModelCallable,
  parseTurn,
  renderInstructions,
  renderMenu,
  type AnyCapability,
} from '@xbam/tools';
import { zodToDescription } from './capabilityInputShape';

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
  /** What the owner configured, by capability id. Absent means the default. */
  permissions: Map<string, CapabilityPermission>;
  paused: boolean;
  /** Per-agent capability configuration, by capability id. */
  configs?: Map<string, Record<string, unknown>>;
  maxSteps?: number;
  budgetMs?: number;
  logger?: Logger;
}

export interface LoopResult {
  /** What the model finally wrote, with no capability call in it. */
  answer: string;
  steps: {
    capabilityId: string;
    outcome: string;
    detail: string;
    durationMs: number;
  }[];
  /** True when the loop stopped because it ran out of steps or time. */
  exhausted: boolean;
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
  const offered = listModelCallable().filter((capability) => {
    const stored = options.permissions.get(capability.id) ?? null;
    return (stored ?? defaultPermission(capability.effect, capability.risk)) !== 'DISABLED';
  });
  const messages: ChatMessage[] = [...options.messages];
  const steps: LoopResult['steps'] = [];

  // Nothing to choose from is not a failure and does not need a menu: the model
  // is asked the question it was always going to be asked.
  if (offered.length > 0) {
    messages.push({ role: 'system', content: preamble(offered) });
  }

  let exhausted = false;
  for (let step = 1; step <= maxSteps; step += 1) {
    if (Date.now() >= deadline) {
      exhausted = true;
      break;
    }

    const raw = await options.generate(messages);
    const turn = parseTurn(raw);

    if (turn.kind === 'answer') {
      return { answer: turn.text, steps, exhausted: false };
    }

    if (turn.kind === 'malformed') {
      // Told once, plainly, and then it is a step like any other. A model that
      // cannot write the call after being shown the error twice is not going to
      // on the third attempt, and the budget is what stops that being infinite.
      messages.push({ role: 'assistant', content: raw });
      messages.push({ role: 'system', content: `That was not a usable capability call: ${turn.reason}` });
      continue;
    }

    const result = await invokeCapability({
      call: turn.call,
      context: {
        agentId: options.agentId,
        jobId: options.jobId,
        accountId: options.accountId,
        config: options.configs?.get(turn.call.id) ?? {},
        logger,
      },
      permission: {
        stored: options.permissions.get(turn.call.id) ?? null,
        paused: options.paused,
      },
    });

    steps.push({
      capabilityId: result.capabilityId,
      outcome: result.outcome,
      detail: result.detail,
      durationMs: result.durationMs,
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

    messages.push({ role: 'assistant', content: raw });
    messages.push({ role: 'system', content: describeResult(result) });

    if (step === maxSteps) exhausted = true;
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
  return { answer, steps, exhausted };
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
