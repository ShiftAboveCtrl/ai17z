import type { z } from 'zod';
import type { Logger } from '@xbam/shared';
import type {
  CapabilityCategory,
  CapabilityEffect,
  CapabilityRisk,
  CapabilityStatus,
} from '@xbam/shared/contracts';

/**
 * What a capability is given when it runs.
 *
 * Deliberately narrow. A capability gets the agent it belongs to, the job it is
 * part of when there is one, its own per-agent configuration and a logger --
 * and nothing else. It cannot reach the pipeline, the policy, or another
 * capability, because a capability that can call the runtime back is a second
 * control plane and there is already one.
 */
export interface CapabilityContext {
  agentId: string;
  jobId: string | null;
  accountId: string | null;
  /**
   * Named settings for this capability and this agent, or `{}`.
   *
   * From `agent_capability_permissions.config`, beside the owner's decision
   * about whether the capability may run at all. It said `agent_tools.config`
   * for as long as capabilities have existed, and that was never where it came
   * from -- nothing wrote such a row, and the only caller of the loop did not
   * pass configs at all, so this arrived empty however it was filled in.
   */
  config: Record<string, unknown>;
  logger: Logger;
  /** Cancelled when the invocation's own timeout expires. */
  signal: AbortSignal;
}

/**
 * One thing an agent can do, declared once.
 *
 * The change-cost target for adding a capability is: declare it here,
 * implement `run`, register it, test it. Nothing in the loop, the permission
 * model, the audit trail or the interface should need editing -- those all read
 * the declaration.
 *
 * Both schemas are required and both are enforced. The input schema is what
 * stops a model's approximation of an argument reaching an implementation; the
 * output schema is what stops an implementation's shape becoming the model's
 * problem. A capability whose output cannot be described is a capability whose
 * result nothing else can consume.
 */
export interface Capability<TInput = unknown, TOutput = unknown> {
  readonly id: string;
  readonly name: string;
  /**
   * What it does, written for the model.
   *
   * This is the text the model reads when choosing, so it says what the
   * capability answers rather than how it is implemented.
   */
  readonly description: string;
  readonly category: CapabilityCategory;
  readonly effect: CapabilityEffect;
  readonly risk: CapabilityRisk;
  readonly input: z.ZodType<TInput, z.ZodTypeDef, unknown>;
  readonly output: z.ZodType<TOutput, z.ZodTypeDef, unknown>;
  /**
   * Whether the model may choose this, as opposed to the runtime driving it.
   *
   * Not everything useful should be model-callable. The research step decides
   * what to look up from the shape of the question and does it before the
   * prompt is assembled; handing the same thing to the model as a choice would
   * be a second way to do one job.
   */
  readonly modelCallable: boolean;
  /** How long one invocation may take before it is abandoned. */
  readonly timeoutMs: number;
  /**
   * Whether this capability can run right now, and why not when it cannot.
   *
   * Optional: a capability that is always available says nothing. One that
   * needs a browser, a provider role or a connected account answers here, so
   * the interface can show a reason instead of an empty switch.
   */
  readiness?(ctx: Omit<CapabilityContext, 'signal'>): Promise<{ status: CapabilityStatus; why?: string }>;
  run(input: TInput, ctx: CapabilityContext): Promise<TOutput>;
}

/** Anything registrable, with its two schemas erased. */
export type AnyCapability = Capability<never, unknown>;

/**
 * Declares a capability with its types intact.
 *
 * A plain object literal loses the relationship between the schemas and `run`,
 * so this exists only to keep `run`'s argument inferred from `input`.
 */
export function defineCapability<TInput, TOutput>(
  capability: Capability<TInput, TOutput>,
): Capability<TInput, TOutput> {
  return capability;
}
