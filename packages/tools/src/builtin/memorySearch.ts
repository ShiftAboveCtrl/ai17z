import { z } from 'zod';
import { memories as memoriesRepo } from '@xbam/database';
import { MEMORY_SCOPES } from '@xbam/shared/contracts';
import { truncate } from '@xbam/shared';
import type { ToolDefinition } from '../contract';

const Input = z.object({
  query: z.string().trim().min(1).max(400),
  scope: z.enum(MEMORY_SCOPES).optional(),
  limit: z.number().int().min(1).max(20).default(5),
});

/** Lets an agent look things up in its own memory beyond what retrieval selected. */
export const memorySearchTool: ToolDefinition<z.infer<typeof Input>> = {
  key: 'memory.search',
  name: 'Search memory',
  description: 'Searches this agent stored memories for a phrase.',
  kind: 'BUILTIN',
  inputSchema: Input,
  safeByDefault: true,
  async execute(input, ctx) {
    const { items } = await memoriesRepo.searchMemories({
      agentId: ctx.agentId,
      search: input.query,
      scopes: input.scope ? [input.scope] : undefined,
      limit: input.limit,
    });
    if (items.length === 0) return { ok: true, output: 'No matching memories.', data: { count: 0 } };
    const lines = items.map((m) => `[${m.scope}] ${truncate(m.content, 200)}`);
    return { ok: true, output: lines.join('\n'), data: { count: items.length } };
  },
};
