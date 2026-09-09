import { ops } from '@xbam/database';
import { createLogger } from '@xbam/shared';
import type { ToolDefinition } from './contract';
import { timeNowTool } from './builtin/timeNow';
import { memorySearchTool } from './builtin/memorySearch';
import { selfDiagnosticsTool } from './builtin/selfDiagnostics';

const log = createLogger('tools');

/*
  The catalogue, which is also what the tools screen offers.

  `httpFetchTool` is deliberately absent. Nothing in AI17Z calls a tool: the
  model never chooses one, and looking things up is a pipeline step that drives
  the browser and the market API directly. A row for it was a switch, an
  allowlist and an editor for something that could never run -- labelled
  "nothing calls it", which is honest and is still a control that does nothing.
  Migration 0062 removes the row that was already synced. Adding it back here
  is what would return it, and it should only happen alongside a real loop.
*/
const TOOLS: ToolDefinition<never>[] = [
  timeNowTool as ToolDefinition<never>,
  memorySearchTool as ToolDefinition<never>,
  selfDiagnosticsTool as ToolDefinition<never>,
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

