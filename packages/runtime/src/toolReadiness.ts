/**
 * Why a tool will or will not run, said in full.
 *
 * "Blocked by policy" is the least useful sentence an interface can produce. It
 * names no policy, no setting and no way forward, and the person reading it has
 * already done the one thing they knew to do -- switched the tool on -- and been
 * told it is switched on and also not working.
 *
 * Two independent gates decide this, which is the reason for the confusion:
 * `agent_tools.enabled` says the owner wants this tool, and
 * `policy.tools.allowed` says the agent's versioned policy permits it. Both are
 * deliberate and neither implies the other. So the answer has to name which one
 * is unsatisfied, which setting holds it, and what changing it would do.
 */

export type ToolState =
  /** Switched on and permitted: the model will be told about it. */
  | 'READY'
  /** Switched on by the owner, not permitted by the policy. */
  | 'BLOCKED'
  /** Not switched on for this agent. */
  | 'OFF';

export interface ToolVerdict {
  key: string;
  state: ToolState;
  /** One sentence, for somebody who has not read the architecture. */
  summary: string;
  /** The setting that decides it, named as the interface names it. */
  setting: string;
  /** What to do, or null when there is nothing to do. */
  fix: string | null;
  /**
   * Whether this can be put right without leaving the simple view.
   *
   * A fix that requires finding Advanced Mode is a fix most people will not
   * make, so the interface needs to know which kind this is.
   */
  fixableInEasyMode: boolean;
  /**
   * The exact change, so a button can apply it without widening anything else.
   * Never "allow all tools": that is how a diagnostic becomes a security hole.
   */
  grant: { addToolToPolicyAllowlist: string } | { enableForAgent: string } | null;
}

export interface ToolFacts {
  key: string;
  name?: string;
  /** Whether the owner has switched it on for this agent. */
  enabled: boolean;
}

/**
 * Whether a tool will actually be offered to the model, and why not.
 *
 * `allowed` is `policy.tools.allowed` -- the versioned list on the agent's
 * policy, which is what the runtime consults when it builds the tool catalogue
 * for a generation.
 */
export function toolReadiness(tool: ToolFacts, allowed: readonly string[]): ToolVerdict {
  const permitted = allowed.includes(tool.key);
  const label = tool.name ?? tool.key;

  if (!tool.enabled) {
    return {
      key: tool.key,
      state: 'OFF',
      summary: permitted
        ? `${label} is permitted by the policy but switched off for this agent.`
        : `${label} is switched off for this agent.`,
      setting: 'Tools, the switch on this tool',
      fix: `Switch ${label} on.`,
      fixableInEasyMode: true,
      grant: { enableForAgent: tool.key },
    };
  }

  if (!permitted) {
    return {
      key: tool.key,
      state: 'BLOCKED',
      // The specific thing somebody needs to hear: it is on, and something
      // else is stopping it, and that something has a name and a location.
      summary: `${label} is switched on, but this agent's policy does not permit it.`,
      setting: 'Policies, the tool allowlist (policy.tools.allowed)',
      fix: `Add "${tool.key}" to the tool allowlist on this agent's policy.`,
      fixableInEasyMode: false,
      grant: { addToolToPolicyAllowlist: tool.key },
    };
  }

  return {
    key: tool.key,
    state: 'READY',
    summary: `${label} is available to this agent.`,
    setting: 'Tools, and the policy allowlist',
    fix: null,
    fixableInEasyMode: true,
    grant: null,
  };
}

/**
 * What will happen if this tool is switched on right now.
 *
 * Asked before the switch rather than discovered afterwards in the middle of a
 * conversation, which is where this was previously found out.
 */
export function preflightEnabling(tool: ToolFacts, allowed: readonly string[]): {
  willRun: boolean;
  warning: string | null;
  grant: ToolVerdict['grant'];
} {
  if (allowed.includes(tool.key)) {
    return { willRun: true, warning: null, grant: null };
  }
  return {
    willRun: false,
    warning:
      `Switching this on is not enough on its own: "${tool.key}" is not on this agent's policy allowlist, ` +
      'so the model will never be told the tool exists. Allow it on the policy as well.',
    grant: { addToolToPolicyAllowlist: tool.key },
  };
}

/**
 * Apply one grant, and nothing else.
 *
 * Deliberately returns a new allowlist rather than a whole policy: the caller
 * writes a new policy version around it, and this cannot accidentally widen
 * anything it was not asked about. A quick fix that turns on every tool to make
 * one work is not a fix.
 */
export function withToolAllowed(allowed: readonly string[], key: string): string[] {
  return allowed.includes(key) ? [...allowed] : [...allowed, key];
}
