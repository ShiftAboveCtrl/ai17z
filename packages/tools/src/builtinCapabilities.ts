import { capabilityFromTool } from './fromToolDefinition';
import { registerCapability } from './capabilityRegistry';
import { timeNowTool } from './builtin/timeNow';
import { memorySearchTool } from './builtin/memorySearch';
import { selfDiagnosticsTool } from './builtin/selfDiagnostics';
import { xAccountReadTool } from './builtin/xAccountRead';
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
 * `x.account.read` is the one that is different in kind, and it is placed
 * carefully. It leaves the machine: it reads a public X profile through the
 * browser, as the owner's signed-in session, which costs a real request to
 * somebody else's service. So it is RESEARCH rather than READ, and MEDIUM
 * rather than LOW -- not because reading a public page is risky, but because
 * "allowed by default" should mean "nobody needs to think about this", and an
 * agent reaching out to X on its own is a thing an owner should decide once,
 * deliberately, rather than discover.
 *
 * Its effect is still READ, and structurally cannot be anything else: it calls
 * the X intelligence layer, which has no write in it. Following, liking and
 * messaging belong to the engagement pipeline behind its policies and
 * approvals, and no capability here may route around that.
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
  {
    tool: xAccountReadTool as ToolDefinition<never>,
    // Long enough for a cold browser to open a profile and read a screenful,
    // short enough that a stuck read does not hold a reply open.
    placement: { category: 'RESEARCH', effect: 'READ', risk: 'MEDIUM', timeoutMs: 90_000 },
  },
] as const;

/** Registers the built-ins. Called once at bootstrap, before any job runs. */
export function registerBuiltinCapabilities(): void {
  for (const { tool, placement } of PLACEMENTS) {
    registerCapability(capabilityFromTool(tool, { ...placement }));
  }
}
