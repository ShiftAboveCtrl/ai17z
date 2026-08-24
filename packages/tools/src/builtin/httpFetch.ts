import { z } from 'zod';
import { truncate } from '@xbam/shared';
import type { ToolDefinition } from '../contract';

const Input = z.object({
  url: z.string().url().max(2_000),
});

const MAX_BYTES = 200_000;

/**
 * Fetches a URL and returns its text.
 *
 * Disabled by default and inert until the operator configures an explicit host
 * allowlist on the agent tool. An agent that can fetch arbitrary URLs is an
 * agent that can be steered by whatever it fetches, so the allowlist is the
 * feature, not a formality.
 */
export const httpFetchTool: ToolDefinition<z.infer<typeof Input>> = {
  key: 'http.fetch',
  name: 'Fetch URL',
  description: 'Fetches the text of an allowlisted URL.',
  kind: 'HTTP',
  inputSchema: Input,
  safeByDefault: false,
  async execute(input, ctx) {
    const allowlist = Array.isArray(ctx.config.allowedHosts) ? (ctx.config.allowedHosts as string[]) : [];
    if (allowlist.length === 0) {
      return { ok: false, output: 'This tool has no allowed hosts configured, so it will not fetch anything.' };
    }
    let host: string;
    try {
      const parsed = new URL(input.url);
      if (parsed.protocol !== 'https:') return { ok: false, output: 'Only https URLs are permitted.' };
      host = parsed.hostname.toLowerCase();
    } catch {
      return { ok: false, output: 'That is not a valid URL.' };
    }
    const permitted = allowlist.some((entry) => {
      const clean = entry.trim().toLowerCase();
      return host === clean || host.endsWith(`.${clean}`);
    });
    if (!permitted) return { ok: false, output: `Host ${host} is not in the allowlist for this agent.` };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(input.url, { signal: controller.signal, redirect: 'follow' });
      if (!response.ok) return { ok: false, output: `Request failed with status ${response.status}.` };
      const text = (await response.text()).slice(0, MAX_BYTES);
      const stripped = text
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      return { ok: true, output: truncate(stripped, 8_000), data: { host, bytes: text.length } };
    } catch (error) {
      return { ok: false, output: `Fetch failed: ${(error as Error).message}` };
    } finally {
      clearTimeout(timer);
    }
  },
};
