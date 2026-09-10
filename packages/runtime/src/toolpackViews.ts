import { defaultPermission, type CapabilityPermission, type CapabilityView } from '@xbam/shared/contracts';
import { NotFoundError } from '@xbam/shared';
import { TOOLPACKS, capabilitiesInPack, packFor } from '@xbam/tools';
import { capabilityViews, setCapabilityPermission } from './capabilityViews';

/**
 * What a pack looks like to somebody deciding about it.
 *
 * Computed every time from the permissions underneath, never stored. A pack
 * with its own row would be a second answer to "may this agent do that", and
 * the day the two disagreed the screen would say one thing while the runtime
 * did another.
 */

/** ON, OFF, or a pack an owner has taken apart in Advanced. */
export const PACK_STATES = ['ON', 'OFF', 'MIXED'] as const;
export type PackState = (typeof PACK_STATES)[number];

export interface ToolpackView {
  id: string;
  name: string;
  summary: string;
  state: PackState;
  /** How many of its capabilities could run right now. */
  ready: number;
  /** How many need something the installation has not got. */
  needsSetup: number;
  total: number;
  /**
   * The one-line answer under the name: "5 sources ready", or what is missing.
   *
   * Written here rather than in the screen so the API and the interface cannot
   * drift into describing the same state differently.
   */
  detail: string;
  capabilities: CapabilityView[];
}

/**
 * Whether a capability is at least as permitted as it would be by default.
 *
 * The comparison a pack's state rests on. A read that is ALLOWED is on; one an
 * owner switched off is not, and that makes the pack MIXED rather than quietly
 * showing ON while something inside it is refused.
 */
function atLeastDefault(current: CapabilityPermission, fallback: CapabilityPermission): boolean {
  const rank: Record<CapabilityPermission, number> = { DISABLED: 0, OWNER_APPROVAL: 1, ALLOWED: 2 };
  return rank[current] >= rank[fallback];
}

export async function toolpackViews(input: {
  agentId: string;
  accountId: string | null;
  paused: boolean;
}): Promise<{ packs: ToolpackView[]; ungrouped: CapabilityView[] }> {
  const views = await capabilityViews(input);
  const byId = new Map(views.map((view) => [view.id, view]));

  const packs: ToolpackView[] = [];
  for (const pack of TOOLPACKS) {
    const members = capabilitiesInPack(pack.id)
      .map((capability) => byId.get(capability.id))
      .filter((view): view is CapabilityView => Boolean(view));
    if (members.length === 0) continue;

    const on = members.filter((view) =>
      atLeastDefault(view.permission, defaultPermission(view.effect, view.risk)),
    ).length;
    const off = members.filter((view) => view.permission === 'DISABLED').length;
    const state: PackState = on === members.length ? 'ON' : off === members.length ? 'OFF' : 'MIXED';

    const ready = members.filter((view) => view.status === 'AVAILABLE').length;
    const needsSetup = members.filter((view) => view.status === 'UNAVAILABLE').length;

    packs.push({
      id: pack.id,
      name: pack.name,
      summary: pack.summary,
      state,
      ready,
      needsSetup,
      total: members.length,
      detail:
        state === 'OFF'
          ? 'Off.'
          : needsSetup > 0
            ? `${ready} of ${members.length} ready. ${needsSetup} need something this installation has not got.`
            : `${ready} of ${members.length} ready.`,
      capabilities: members,
    });
  }

  const ungrouped = views.filter((view) => packFor(view.id) === null);
  return { packs, ungrouped };
}

/**
 * Turns a pack on or off, by writing the permissions it stands for.
 *
 * On means **each capability's own default** -- reads allowed, writes off or
 * asking -- not everything allowed. "Let my agent look at chains" is not
 * consent to let it act, and a pack that swept a write to ALLOWED would be
 * making a decision the owner did not.
 *
 * Off means DISABLED, which is unambiguous in the other direction.
 */
export async function setToolpack(input: {
  agentId: string;
  packId: string;
  on: boolean;
}): Promise<{ changed: string[] }> {
  const pack = TOOLPACKS.find((entry) => entry.id === input.packId);
  if (!pack) throw new NotFoundError('That toolpack');

  const members = capabilitiesInPack(input.packId);
  if (members.length === 0) throw new NotFoundError('Anything in that toolpack');

  const changed: string[] = [];
  for (const capability of members) {
    const permission: CapabilityPermission = input.on
      ? defaultPermission(capability.effect, capability.risk)
      : 'DISABLED';
    await setCapabilityPermission({ agentId: input.agentId, capabilityId: capability.id, permission });
    changed.push(capability.id);
  }
  return { changed };
}
