import { z } from 'zod';
import type { AgentDiagnostics, ComponentHealth } from '@xbam/shared/contracts';
import type { ToolDefinition } from '../contract';
import { collectDiagnostics } from '../diagnostics';

const Input = z.object({});

/** "11 minutes", "2 hours", or nothing when there is nothing to say. */
function forHowLong(minutes: number | null): string {
  if (minutes === null) return '';
  if (minutes < 60) return ` for ${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  return ` for about ${hours} hour${hours === 1 ? '' : 's'}`;
}

/** One line per part, and only the parts worth a line. */
function lines(title: string, parts: ComponentHealth[]): string[] {
  if (parts.length === 0) return [];
  const broken = parts.filter((p) => p.state === 'FAILING' || p.state === 'DEGRADED');
  const working = parts.filter((p) => p.state === 'HEALTHY');
  const off = parts.filter((p) => p.state === 'OFF');

  const out: string[] = [];
  for (const part of broken) {
    out.push(`- ${part.name}: ${part.state.toLowerCase()}${forHowLong(part.failingForMinutes)}. ${part.detail}`);
  }
  // What still works matters as much as what does not: "notifications are down
  // but search is still finding mentions" is the useful answer, and half of it
  // is the half that is fine.
  if (working.length > 0) out.push(`- Working: ${working.map((p) => p.name).join(', ')}.`);
  if (off.length > 0) out.push(`- Switched off: ${off.map((p) => p.name).join(', ')}.`);
  return out.length > 0 ? [`${title}:`, ...out] : [];
}

/** The document as something a model can read in a few lines. */
export function summariseDiagnostics(d: AgentDiagnostics): string {
  const out: string[] = [];

  out.push(
    d.agent.canWork
      ? `This agent is ${d.agent.state.toLowerCase()} and able to work.`
      : `This agent is not working: ${d.agent.reason ?? d.agent.state}`,
  );
  out.push(
    d.account.connected
      ? `Account @${d.account.handle} is connected.`
      : `Account ${d.account.handle ? `@${d.account.handle} ` : ''}is ${d.account.status?.toLowerCase() ?? 'not connected'}.`,
  );
  if (d.worker.state !== 'HEALTHY') out.push(`Worker: ${d.worker.detail}`);

  out.push(...lines('Discovery', d.radar));
  out.push(...lines('Browser', d.browser));
  out.push(...lines('Model providers', d.providers));
  out.push(...lines('Tools', d.tools));
  out.push(...lines('Knowledge', d.knowledge));

  const missingRoles = d.models.filter((m) => !m.configured).map((m) => m.role);
  if (missingRoles.length > 0) out.push(`No model is set for: ${missingRoles.join(', ')}.`);

  if (d.lastSuccess.poll) out.push(`Last successful poll: ${d.lastSuccess.poll}.`);
  if (d.lastSuccess.action) out.push(`Last action actually sent: ${d.lastSuccess.action}.`);
  else out.push('Nothing has been sent yet.');

  if (d.recentFailures.length > 0) {
    const worst = d.recentFailures.slice(0, 3).map((f) => `${f.reason} (${f.count})`);
    out.push(`Recent failures in the last day: ${worst.join(', ')}.`);
  }

  return out.join('\n');
}

/**
 * What this agent can find out about its own runtime.
 *
 * Asked "why aren't you replying to mentions?", an agent without this can only
 * guess, and a model that guesses about infrastructure invents a confident and
 * wrong answer. With it, it can say which monitor stopped, how long ago, and
 * what is still working.
 *
 * Safe by default, and it is worth being precise about why: this reads a
 * document that has nowhere to put a secret. It takes no input, reaches no
 * network, and cannot be pointed at anything -- so there is nothing for a
 * hostile message to steer. Contrast `http.fetch`, which is off by default
 * because its whole job is to go where it is told.
 */
export const selfDiagnosticsTool: ToolDefinition<z.infer<typeof Input>> = {
  key: 'agent.diagnostics',
  name: 'Own status',
  description: "Reads this agent's own runtime health: account, discovery, browser, models, tools and recent failures.",
  kind: 'BUILTIN',
  inputSchema: Input,
  safeByDefault: true,
  async execute(_input, ctx) {
    const diagnostics = await collectDiagnostics(ctx.agentId);
    return { ok: true, output: summariseDiagnostics(diagnostics), data: diagnostics };
  },
};
