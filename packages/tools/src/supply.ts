/**
 * What each tool actually contributes to a reply.
 *
 * This file exists because of a defect worth stating plainly: the prompt used
 * to carry a block headed TOOLS AVAILABLE, listing every tool that was switched
 * on and permitted, and **nothing in AI17Z could call one**. There is no
 * tool-call loop -- no parsing of a tool call out of a model's answer, no
 * execution, no result fed back. The list was a menu in a restaurant with no
 * kitchen.
 *
 * That is worse than a missing feature. A model told it has a capability uses
 * it: it writes "let me check that" or answers as though it had looked
 * something up, and the reply goes out sounding like it consulted something it
 * never consulted. The same class of problem as an unread image, and this
 * codebase already refuses to let that pass silently.
 *
 * The honest model, and the one that matches how AI17Z actually works: the
 * runtime does the looking-up and hands the facts to the prompt. Memories are
 * retrieved and rendered into their own layer. Research runs as a pipeline step
 * before generation. Diagnostics are folded into the support layer. Nothing is
 * "called" by the model, and nothing needs to be.
 *
 * So a tool that is on contributes a **fact**, not an offer. `time.now` becomes
 * the current date and time, stated. A tool whose contribution already arrives
 * through another layer contributes nothing here rather than being listed twice.
 * And a tool nothing supplies is named as such on the tools screen instead of
 * being advertised to the model.
 */

/** Which tools have something behind them, and where it comes from. */
export type ToolSupply =
  /** The runtime states this in the prompt, from this file. */
  | 'RUNTIME_SUPPLIES'
  /** It arrives through a different prompt layer; listing it again is noise. */
  | 'ANOTHER_LAYER'
  /** Nothing calls it. Said out loud rather than advertised to the model. */
  | 'NOTHING_CALLS_IT';

export const TOOL_SUPPLY: Record<string, { supply: ToolSupply; says: string }> = {
  'time.now': {
    supply: 'RUNTIME_SUPPLIES',
    says: 'The date and time are stated in the prompt, so the agent knows what "yesterday" means.',
  },
  'memory.search': {
    supply: 'ANOTHER_LAYER',
    says: 'Memories are retrieved before the prompt is built and arrive in their own section.',
  },
  'agent.diagnostics': {
    supply: 'ANOTHER_LAYER',
    says: 'Its own health is included when support mode is on, so it can say why it is not replying.',
  },
  'http.fetch': {
    supply: 'NOTHING_CALLS_IT',
    says: 'Nothing in AI17Z calls this yet. Looking things up is a pipeline step that uses the browser and market data directly, and it does not go through here.',
  },
};

/** What a tool contributes, for the tools screen. Unknown keys are honest about being unknown. */
export function toolSupply(key: string): { supply: ToolSupply; says: string } {
  return (
    TOOL_SUPPLY[key] ?? {
      supply: 'NOTHING_CALLS_IT',
      says: 'Nothing in AI17Z calls this yet.',
    }
  );
}

export interface SupplyInput {
  /** Tools that are switched on for this agent and permitted by its policy. */
  keys: readonly string[];
  /** The agent's working timezone, for the clock. */
  timezone: string;
  /** Injectable so a test is not at the mercy of the machine's clock. */
  now?: Date;
}

/**
 * The facts the enabled tools contribute, as whole sentences.
 *
 * Sentences rather than a list of names, because the model reads this and a
 * name is not a fact. Empty when nothing is enabled, which renders no block at
 * all -- better than an empty heading.
 */
export function suppliedFacts(input: SupplyInput): string[] {
  const facts: string[] = [];
  const now = input.now ?? new Date();

  if (input.keys.includes('time.now')) {
    let stated: string;
    try {
      stated = new Intl.DateTimeFormat('en-GB', {
        timeZone: input.timezone,
        dateStyle: 'full',
        timeStyle: 'short',
      }).format(now);
    } catch {
      // An unusable timezone fails open to UTC rather than leaving the agent
      // with no clock, which is the same rule cadence applies to quiet hours.
      stated = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', dateStyle: 'full', timeStyle: 'short' }).format(now);
    }
    facts.push(`It is currently ${stated}.`);
  }

  return facts;
}
