import { z } from 'zod';
import type { ToolDefinition } from '../contract';

const Input = z.object({
  timezone: z.string().max(64).default('UTC'),
});

/** Trivial, deterministic, and genuinely useful: agents otherwise have no clock. */
export const timeNowTool: ToolDefinition<z.infer<typeof Input>> = {
  key: 'time.now',
  name: 'Current time',
  description: 'Returns the current date and time in a given IANA timezone.',
  kind: 'BUILTIN',
  inputSchema: Input,
  safeByDefault: true,
  async execute(input) {
    try {
      const formatted = new Intl.DateTimeFormat('en-GB', {
        timeZone: input.timezone,
        dateStyle: 'full',
        timeStyle: 'short',
      }).format(new Date());
      return { ok: true, output: formatted, data: { iso: new Date().toISOString(), timezone: input.timezone } };
    } catch {
      return { ok: false, output: `Unknown timezone: ${input.timezone}` };
    }
  },
};
