import type { z } from 'zod';
import type { Logger } from '@xbam/shared';

export interface ToolContext {
  agentId: string;
  jobId: string | null;
  /** Per-agent configuration from `agent_tools.config`. */
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
