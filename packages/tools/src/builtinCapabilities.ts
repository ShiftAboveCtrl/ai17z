import { capabilityFromTool } from './fromToolDefinition';
import { registerCapability } from './capabilityRegistry';
import { timeNowTool } from './builtin/timeNow';
import { memorySearchTool } from './builtin/memorySearch';
import { selfDiagnosticsTool } from './builtin/selfDiagnostics';
import type { ToolDefinition } from './contract';

/**
 * Where the three built-in tools sit in the capability vocabulary.
 *
 * All three are reads and none of them leaves the machine, so all three are
 * LOW risk and allowed by default. That is the whole point of the default rule:
 * an agent that can check the clock without being asked is useful, and there is
 * nothing to decide about a clock.
 *
 * `self.diagnostics` is the one worth pausing on. It reads AI17Z's own health,
 * which is not private in the way a DM is, but it is the machine's business
 * rather than the conversation's -- so it is RESEARCH rather than READ, and it
 * exists so an agent asked "are you working?" can answer from fact.
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
