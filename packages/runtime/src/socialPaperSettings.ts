import { agents, capabilityPermissions, ops, trading } from '@xbam/database';
import { NotFoundError, ValidationError } from '@xbam/shared';
import { SocialPaperConfig, isSocialPaperMandate } from './paperCapabilities';

async function owned(agentId: string, ownerId: string): Promise<void> {
  if ((await agents.getAgent(agentId))?.ownerId !== ownerId) throw new NotFoundError('Agent');
}

export async function socialPaperSettings(agentId: string, ownerId: string) {
  await owned(agentId, ownerId);
  const row = (await capabilityPermissions.listForAgent(agentId)).find((p) => p.capability_id === 'paper.trade');
  return { config: row?.config ?? null, permission: row?.permission ?? 'DISABLED' };
}

/** Owner control plane only. This pins an existing paper mandate and cannot create or widen one. */
export async function configureSocialPaper(agentId: string, ownerId: string, raw: unknown) {
  await owned(agentId, ownerId);
  const parsed = SocialPaperConfig.safeParse(raw);
  if (!parsed.success) throw new ValidationError(`Paper setup is incomplete: ${parsed.error.issues[0]?.message ?? 'invalid settings'}.`);
  const config = parsed.data;
  const mandate = await trading.liveMandate(agentId);
  if (!isSocialPaperMandate(mandate, config.mandateId, agentId) || mandate.ownerId !== ownerId) throw new ValidationError('Pin a current PAPER mandate written by this owner, with owner approval and no protective exits.');
  const quote = config.quoteAsset;
  if (BigInt(config.maxInBase) > BigInt(mandate.maxPerTrade) || !mandate.venues.includes(config.venue)
    || quote.kind !== 'ONCHAIN' || !mandate.networks.includes(quote.network)) throw new ValidationError('The paper size, pool venue and quote asset must stay inside the pinned mandate.');
  const current = await socialPaperSettings(agentId, ownerId);
  await capabilityPermissions.setConfig({ agentId, capabilityId: 'paper.trade', permission: current.permission, config });
  await ops.audit({ actorUserId: ownerId, action: 'paper.configured', entityType: 'agent', entityId: agentId, data: { mandateId: config.mandateId } });
  return socialPaperSettings(agentId, ownerId);
}
