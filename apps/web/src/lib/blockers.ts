import type { Blocker } from '@xbam/shared/contracts';

/**
 * Where to send somebody to fix a blocker.
 *
 * The agent page selects an area from the hash, so a section anchor is enough.
 * Capabilities are granted on the account, which is why they share a
 * destination. A worker that is not running is not on any agent's page.
 */
export function blockerHref(blocker: Blocker, agentId: string | null): string | null {
  switch (blocker.where) {
    case 'account':
    case 'capabilities':
      return agentId ? `/agents/${agentId}#accounts` : null;
    case 'models':
      return agentId ? `/agents/${agentId}#intelligence` : null;
    case 'persona':
      return agentId ? `/agents/${agentId}#identity` : null;
    case 'worker':
      return '/health';
    default:
      // A fault in AI17Z itself. There is nowhere useful to send anybody, and
      // a link to the agent page pretending otherwise is worse than none.
      return null;
  }
}
