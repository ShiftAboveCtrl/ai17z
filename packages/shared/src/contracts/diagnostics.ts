import { z } from 'zod';

/**
 * What an agent may know about its own runtime.
 *
 * An agent asked "why aren't you replying to mentions?" should be able to
 * answer, and answering needs facts it does not otherwise have. The risk is
 * obvious: whatever reaches this shape can reach a prompt, and whatever reaches
 * a prompt can be published.
 *
 * So the safety is structural rather than procedural. There is no field here a
 * secret fits in. Everything is an enum, a boolean, a count, a timestamp, or a
 * short sentence written by this codebase -- never a value read from
 * configuration, never a URL with credentials in it, never a provider's raw
 * error body. A future field that could carry one has to be added deliberately,
 * and the test that walks this whole document looking for key-shaped strings
 * will fail when it is.
 *
 * The rule that follows from that: build this from stored state, and never by
 * handing the agent a query interface. "Unrestricted application internals with
 * a filter on top" is a filter somebody will get wrong once.
 */

/** How a part of the system is doing, in the four words a person would use. */
export const HEALTH_STATES = ['HEALTHY', 'DEGRADED', 'FAILING', 'OFF', 'UNKNOWN'] as const;
export const HealthState = z.enum(HEALTH_STATES);
export type HealthState = (typeof HEALTH_STATES)[number];

/** One named part, and when it last did its job. */
export const ComponentHealth = z.object({
  /** What a person would call it: "Mention search", "Notifications". */
  name: z.string().max(80),
  state: HealthState,
  /**
   * One sentence, written here. Never a provider's error body: those carry
   * request URLs, and request URLs carry keys.
   */
  detail: z.string().max(300),
  /** When it last worked, which is different from when it last ran. */
  lastSucceededAt: z.string().nullable().default(null),
  /** How long it has been failing, when it is. */
  failingForMinutes: z.number().int().nullable().default(null),
});
export type ComponentHealth = z.infer<typeof ComponentHealth>;

/**
 * A failure the agent is allowed to describe.
 *
 * The classification and the count, never the message. A raw error can contain
 * anything, including the request it came from.
 */
export const FailureSummary = z.object({
  /** The error class the pipeline assigned: a name this codebase chose. */
  reason: z.string().max(80),
  count: z.number().int(),
  lastAt: z.string().nullable().default(null),
});
export type FailureSummary = z.infer<typeof FailureSummary>;

export const AgentDiagnostics = z.object({
  /** Whether the agent is running at all, and what state it is in. */
  agent: z.object({
    state: z.string().max(40),
    /** ACTIVE and able to work, as opposed to merely not paused. */
    canWork: z.boolean(),
    /** Why not, when it cannot. */
    reason: z.string().max(300).nullable().default(null),
  }),
  /** The connected account, by handle only. No cookies, no session material. */
  account: z.object({
    connected: z.boolean(),
    handle: z.string().max(80).nullable().default(null),
    status: z.string().max(40).nullable().default(null),
    lastPolledAt: z.string().nullable().default(null),
  }),
  /** Whether anything is running that can do the work. */
  worker: ComponentHealth,
  /** Model providers, by label and state. Never a key, never an endpoint. */
  providers: z.array(ComponentHealth).max(20),
  /** Which roles have a model behind them. */
  models: z.array(
    z.object({
      role: z.string().max(40),
      configured: z.boolean(),
      /** The model's public name, which is not a secret and is worth saying. */
      model: z.string().max(120).nullable().default(null),
    }),
  ).max(20),
  /** The four tabs, each by role. */
  browser: z.array(ComponentHealth).max(8),
  /** Each radar monitor, separately, because that is how they fail. */
  radar: z.array(ComponentHealth).max(20),
  tools: z.array(ComponentHealth).max(30),
  knowledge: z.array(ComponentHealth).max(30),
  /** The three "is it actually working" timestamps. */
  lastSuccess: z.object({
    poll: z.string().nullable().default(null),
    generation: z.string().nullable().default(null),
    action: z.string().nullable().default(null),
  }),
  /** Classified, counted, and never quoted. */
  recentFailures: z.array(FailureSummary).max(20),
  collectedAt: z.string(),
});
export type AgentDiagnostics = z.infer<typeof AgentDiagnostics>;

/**
 * The one tool a new agent is permitted without being asked.
 *
 * Every other tool needs two switches -- enabled for the agent, and permitted
 * by the policy -- and that is right for anything that can reach the network or
 * be pointed at something. This one takes no input, reaches nothing, and reads
 * only the document above, which has nowhere to put a secret. There is
 * therefore nothing for a hostile message to steer, and requiring two switches
 * would be friction with no safety behind it.
 *
 * Granted when a new agent is created and its owner supplied no policy of their
 * own. A policy somebody wrote is a decision and is stored exactly as given.
 */
export const SELF_DIAGNOSTICS_TOOL = 'agent.diagnostics';
