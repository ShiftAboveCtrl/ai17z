import type { InvocationOutcome } from '@xbam/shared/contracts';
import type { CapabilityContext } from './capability';
import { getCapability } from './capabilityRegistry';
import { resolvePermission, type PermissionInputs } from './permissions';
import type { CapabilityCall } from './protocol';

export interface InvocationResult {
  capabilityId: string;
  outcome: InvocationOutcome;
  /** Validated input, or null when it never got that far. */
  input: unknown;
  /** Validated output, or null on anything but success. */
  output: unknown;
  /** One sentence, for the model, the trace and the owner alike. */
  detail: string;
  durationMs: number;
}

export interface InvokeOptions {
  call: CapabilityCall;
  context: Omit<CapabilityContext, 'signal'>;
  /** Everything the permission answer needs except the capability itself. */
  permission: Omit<PermissionInputs, 'capability' | 'readiness'>;
}

/**
 * Runs one capability, or explains why it did not.
 *
 * Every refusal is a result rather than a thrown error, because the model is
 * about to be told what happened and "you may not use that" is a fact it can
 * act on. Throwing here would end the job over a choice the model is allowed
 * to make badly.
 *
 * The order is fixed and each step is the reason the next one is safe:
 *
 *   1. is it a capability at all -- an id the model invented never reaches
 *      permission checks, so a typo cannot be mistaken for a denial
 *   2. is it model-callable -- runtime-driven capabilities are not a menu
 *   3. does the input parse -- an implementation never sees an approximation
 *   4. may it run -- the owner's answer, including PAUSE ALL
 *   5. run it, bounded by its own timeout
 *   6. does the output parse -- a result nothing can consume is a failure here
 *      rather than a surprise three layers up
 */
export async function invokeCapability(options: InvokeOptions): Promise<InvocationResult> {
  const started = Date.now();
  const { call, context } = options;
  const done = (outcome: InvocationOutcome, detail: string, extra?: { input?: unknown; output?: unknown }) => ({
    capabilityId: call.id,
    outcome,
    input: extra?.input ?? null,
    output: extra?.output ?? null,
    detail,
    durationMs: Date.now() - started,
  });

  const capability = getCapability(call.id);
  if (!capability) {
    return done('REFUSED', `There is no capability called "${call.id}".`);
  }
  if (!capability.modelCallable) {
    return done('REFUSED', `${capability.name} is not something you can choose.`);
  }

  const parsedInput = capability.input.safeParse(call.input);
  if (!parsedInput.success) {
    const first = parsedInput.error.issues[0];
    const where = first?.path.length ? ` at "${first.path.join('.')}"` : '';
    return done('REFUSED', `The input for ${capability.id} was wrong${where}: ${first?.message ?? 'invalid'}.`);
  }

  const readiness = capability.readiness ? await capability.readiness(context).catch(() => undefined) : undefined;
  const decision = resolvePermission({ ...options.permission, capability, readiness });
  if (!decision.allowed) {
    return done('REFUSED', decision.why, { input: parsedInput.data });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), capability.timeoutMs);
  try {
    const raw = await capability.run(parsedInput.data as never, { ...context, signal: controller.signal });
    const parsedOutput = capability.output.safeParse(raw);
    if (!parsedOutput.success) {
      return done('FAILED', `${capability.id} returned something that did not match its own result shape.`, {
        input: parsedInput.data,
      });
    }
    return done('SUCCEEDED', `${capability.name} answered.`, {
      input: parsedInput.data,
      output: parsedOutput.data,
    });
  } catch (error) {
    const aborted = controller.signal.aborted;
    const message = error instanceof Error ? error.message : String(error);
    return done(
      aborted ? 'TIMED_OUT' : 'FAILED',
      aborted ? `${capability.name} took longer than ${capability.timeoutMs}ms and was abandoned.` : message,
      { input: parsedInput.data },
    );
  } finally {
    clearTimeout(timer);
  }
}
