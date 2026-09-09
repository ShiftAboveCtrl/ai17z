import { z } from 'zod';
import type { CapabilityCategory, CapabilityEffect, CapabilityRisk } from '@xbam/shared/contracts';
import { defineCapability, type Capability } from './capability';
import type { ToolDefinition } from './contract';

/**
 * The result shape every adapted tool answers with.
 *
 * `ToolDefinition` predates capabilities and has an input schema but no output
 * schema, because nothing ever consumed its result -- there was no loop. The
 * shape it returns is `ToolResult`, so that is what the adapted capability
 * declares. Honest rather than aspirational: a wider claim here would be a
 * schema that says more than the implementation does.
 */
const ToolShape = z.object({
  ok: z.boolean(),
  output: z.string(),
  data: z.unknown().optional(),
});

interface Placement {
  category: CapabilityCategory;
  effect: CapabilityEffect;
  risk: CapabilityRisk;
  timeoutMs: number;
}

/**
 * Lifts an existing tool into the capability registry.
 *
 * The three built-in tools were correct implementations with nothing to call
 * them. Rewriting them as capabilities would have meant two copies of each for
 * as long as the old contract survived, and the interface's Tools section reads
 * the old rows. So they are adapted instead, keep their keys, and keep their
 * per-agent switch.
 */
export function capabilityFromTool(
  tool: ToolDefinition<never>,
  placement: Placement,
): Capability<never, z.infer<typeof ToolShape>> {
  return defineCapability({
    id: tool.key,
    name: tool.name,
    description: tool.description,
    category: placement.category,
    effect: placement.effect,
    risk: placement.risk,
    input: tool.inputSchema as z.ZodType<never, z.ZodTypeDef, unknown>,
    output: ToolShape,
    modelCallable: true,
    timeoutMs: placement.timeoutMs,
    async run(input, ctx) {
      const result = await tool.execute(input, {
        agentId: ctx.agentId,
        jobId: ctx.jobId,
        config: ctx.config,
        logger: ctx.logger,
      });
      return { ok: result.ok, output: result.output, data: result.data };
    },
  });
}
