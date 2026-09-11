import type { z } from 'zod';
import type { Logger } from '@xbam/shared';

export interface ToolContext {
  agentId: string;
  jobId: string | null;
  /**
   * Per-agent configuration from `agent_tools.config`.
   *
   * Correct here and **not** the same as `CapabilityContext.config`, which
   * looks identical and comes from `agent_capability_permissions.config`.
   * Tools and capabilities are separate catalogues with separate per-agent
   * rows: `agent_tools.tool_id` is a foreign key into the built-in tool table,
   * which capability ids were never in. Saying so because the two fields are
   * one word apart, and a capability once carried this file's sentence while
   * reading nothing at all -- see migration 0069.
   */
  config: Record<string, unknown>;
  logger: Logger;
}

export interface ToolResult {
  ok: boolean;
  /** Compact text handed back to the model. */
  output: string;
  data?: unknown;
}

export interface ToolDefinition<TInput = unknown> {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly kind: 'BUILTIN' | 'HTTP' | 'CUSTOM';
  readonly inputSchema: z.ZodType<TInput, z.ZodTypeDef, unknown>;
  /**
   * Tools are opt-in per agent. A tool that can reach the network must default
   * to disabled and require explicit configuration before it will run.
   */
  readonly safeByDefault: boolean;
  execute(input: TInput, ctx: ToolContext): Promise<ToolResult>;
}
