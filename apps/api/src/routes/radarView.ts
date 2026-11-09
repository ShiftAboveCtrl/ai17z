import { BadRequestError } from '@xbam/shared';
import type { RadarSourceRow } from '@xbam/database';
import { radarSourceProvenance, type RadarSourceProvenance } from '@xbam/shared/contracts';

/**
 * What the radar screen is given about one source, and nothing more.
 *
 * A Studio risk source keeps the binding id and the watch id in its config and
 * in its target, and a playbook source keeps the agent and pin ids. The screen
 * has no use for any of them: it needs to know where the source came from,
 * which `provenance` says, and how it is doing. So a linked source's target is
 * withheld and its config is cut down to the three settings the screen shows,
 * and the row itself is a whitelist rather than the database row minus a few
 * fields, so a column added later is not published by default.
 */
export interface RadarSourceView {
  id: string;
  provenance: RadarSourceProvenance;
  kind: RadarSourceRow['kind'];
  target: string | null;
  label: string;
  enabled: boolean;
  status: RadarSourceRow['status'];
  lastPollAt: string | null;
  lastSuccessAt: string | null;
  lastResultAt: string | null;
  lastError: string | null;
  idleReason: string | null;
  consecutiveFailures: number;
  nextPollAt: string | null;
  config: { intervalSeconds?: number; mayTrigger?: boolean; watches?: NonNullable<RadarSourceRow['config']['watches']> };
}

export function radarSourceView(source: RadarSourceRow): RadarSourceView {
  const provenance = radarSourceProvenance(source.config);
  const linked = provenance !== 'OWNER';
  const { intervalSeconds, mayTrigger, watches } = source.config;
  return {
    id: source.id,
    provenance,
    kind: source.kind,
    target: linked ? null : source.target,
    label: source.label,
    enabled: source.enabled,
    status: source.status,
    lastPollAt: source.lastPollAt,
    lastSuccessAt: source.lastSuccessAt,
    lastResultAt: source.lastResultAt,
    lastError: source.lastError,
    idleReason: source.idleReason,
    consecutiveFailures: source.consecutiveFailures,
    nextPollAt: source.nextPollAt,
    config: { ...(intervalSeconds !== undefined && { intervalSeconds }), ...(mayTrigger !== undefined && { mayTrigger }), ...(watches !== undefined && { watches }) },
  };
}

/**
 * Refuses to change or remove a source that a sync recreates.
 *
 * Switching it off or deleting it would look like it worked until the next
 * tick, which turns it back on, so the refusal says where the setting really
 * lives instead.
 */
export function refuseLinkedSourceChange(source: Pick<RadarSourceRow, 'config'>): void {
  const provenance = radarSourceProvenance(source.config);
  if (provenance === 'STUDIO_RISK_WATCH') {
    throw new BadRequestError('This source follows your Studio risk watch link. Change the watch in Studio, or turn the Studio risk watches switch off for this agent.');
  }
  if (provenance === 'PLAYBOOK') {
    throw new BadRequestError('This source follows the playbook linked to this agent and turns itself back on at every sync. Import a different playbook for the agent to change it.');
  }
}
