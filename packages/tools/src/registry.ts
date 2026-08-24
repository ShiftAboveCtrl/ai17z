import { ops } from '@xbam/database';
import { createLogger } from '@xbam/shared';
import type { ToolDefinition } from './contract';
import { timeNowTool } from './builtin/timeNow';
import { memorySearchTool } from './builtin/memorySearch';
import { httpFetchTool } from './builtin/httpFetch';

const log = createLogger('tools');

const TOOLS: ToolDefinition<never>[] = [
  timeNowTool as ToolDefinition<never>,
  memorySearchTool as ToolDefinition<never>,
  httpFetchTool as ToolDefinition<never>,
];

export function listToolDefinitions(): ToolDefinition<never>[] {
  return TOOLS;
}

export function getToolDefinition(key: string): ToolDefinition<never> | null {
  return TOOLS.find((tool) => tool.key === key) ?? null;
}

/** Registers the built-in catalogue so the UI can enable tools per agent. */
export async function syncToolCatalogue(): Promise<void> {
  for (const tool of TOOLS) {
    await ops.upsertTool({
      key: tool.key,
      name: tool.name,
      description: tool.description,
      kind: tool.kind,
      inputSchema: { safeByDefault: tool.safeByDefault },
    });
  }
  log.info('tool catalogue synced', { count: TOOLS.length });
}

/** One-line descriptions for the TOOLS prompt layer. */
export function describeTools(keys: readonly string[]): string[] {
  return keys
    .map((key) => getToolDefinition(key))
    .filter((tool): tool is ToolDefinition<never> => Boolean(tool))
    .map((tool) => `${tool.key}: ${tool.description}`);
}
