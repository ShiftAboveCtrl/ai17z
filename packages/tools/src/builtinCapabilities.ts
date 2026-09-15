import { capabilityFromTool } from './fromToolDefinition';
import { registerCapability } from './capabilityRegistry';
import { timeNowTool } from './builtin/timeNow';
import { memorySearchTool } from './builtin/memorySearch';
import { selfDiagnosticsTool } from './builtin/selfDiagnostics';
import type { ToolDefinition } from './contract';

/**
 * Where the built-in tools sit in the capability vocabulary.
 *
 * The first three are reads that never leave the machine, so all three are LOW
 * risk and allowed by default. That is the whole point of the default rule: an
 * agent that can check the clock without being asked is useful, and there is
 * nothing to decide about a clock.
 *
 * `self.diagnostics` is worth pausing on. It reads AI17Z's own health, which is
 * not private in the way a DM is, but it is the machine's business rather than
 * the conversation's -- so it is RESEARCH rather than READ, and it exists so an
 * agent asked "are you working?" can answer from fact.
 *
 * There was a fourth here, `x.read_account`, which read a public X profile
 * through the browser. It is gone, and not because reading a profile stopped
 * being useful: `x.read_profile` in the runtime does the same job, through the
 * same X intelligence layer, and returns a typed `XProfile` instead of a block
 * of text. Two model-callable capabilities that read one thing means a model
 * that sometimes picks the worse one and an owner looking at two switches for
 * a single decision. What it had that the other did not -- reading more than a
 * handful of their posts -- moved across as an argument.
 */
const PLACEMENTS = [
  {
    tool: timeNowTool as ToolDefinition<never>,
    placement: { category: 'READ', effect: 'READ', risk: 'LOW', timeoutMs: 2_000 },
  },
  {
    tool: memorySearchTool as ToolDefinition<never>,
    placement: { category: 'READ', effect: 'READ', risk: 'LOW', timeoutMs: 10_000 },
  },
  {
    tool: selfDiagnosticsTool as ToolDefinition<never>,
    placement: { category: 'RESEARCH', effect: 'READ', risk: 'LOW', timeoutMs: 15_000 },
  },
] as const;

/** Registers the built-ins. Called once at bootstrap, before any job runs. */
export function registerBuiltinCapabilities(): void {
  for (const { tool, placement } of PLACEMENTS) {
    registerCapability(capabilityFromTool(tool, { ...placement }));
  }
}
