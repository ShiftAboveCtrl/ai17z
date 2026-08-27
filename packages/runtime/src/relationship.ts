import type { RelationshipContext, RelationshipVoice } from '@xbam/shared/contracts';
import { relationships as relationshipsRepo, type RelationshipRow } from '@xbam/database';

/**
 * What the agent knows about the person it is replying to.
 *
 * The failure this addresses is an agent that answers a regular the same way it
 * answers a stranger: explaining what they already know, and never referring to
 * anything the two of them have actually discussed.
 *
 * What is assembled here is deliberately small and readable. Handing a model a
 * table of interaction counts produces replies that sound like they came out of
 * a CRM, so this produces sentences instead.
 */

/** "You have spoken 6 times, most recently 2 days ago." */
export function historyLine(row: RelationshipRow, now = new Date()): string {
  const exchanges = Math.min(row.inboundCount, row.outboundCount);
  const since = now.getTime() - new Date(row.lastInteractionAt).getTime();
  const days = Math.floor(since / 86_400_000);
  const hours = Math.floor(since / 3_600_000);

  const when =
    days >= 2 ? `${days} days ago` : hours >= 2 ? `${hours} hours ago` : days === 1 ? 'yesterday' : 'earlier today';

  if (exchanges === 0) {
    // Mentioned the agent without ever being answered. Worth distinguishing:
    // it is not a conversation and should not be treated as one.
    return row.inboundCount > 1
      ? `They have mentioned you ${row.inboundCount} times and you have not replied before.`
      : 'You have not spoken before.';
  }
  if (exchanges === 1) return `You have exchanged messages once, ${when}.`;
  return `You have exchanged messages ${exchanges} times, most recently ${when}.`;
}

export interface LoadRelationshipInput {
  agentId: string;
  channel: string;
  handle: string | null;
  remoteUserId?: string | null;
  voice: RelationshipVoice;
}

/**
 * Loads the relationship and decides what to say about it.
 *
 * A callback is only offered when the agent knows the person well enough for
 * one to land, and only when it is rested. A shared joke repeated every time is
 * not continuity, it is a tic.
 */
export async function loadRelationshipContext(
  input: LoadRelationshipInput,
): Promise<{ context: RelationshipContext; row: RelationshipRow | null; callbackId: string | null }> {
  const handle = (input.handle ?? '').replace(/^@+/, '');
  if (!handle) {
    return {
      context: { known: false, handle: 'someone', familiarity: 'NEW', historyLine: '', topics: [], summary: null, ownerNote: null, disposition: 'NEUTRAL', callback: null },
      row: null,
      callbackId: null,
    };
  }

  const row = await relationshipsRepo.find({
    agentId: input.agentId,
    channel: input.channel,
    handle,
    remoteUserId: input.remoteUserId ?? null,
  });

  if (!row) {
    return {
      context: {
        known: false,
        handle,
        familiarity: 'NEW',
        historyLine: 'You have not spoken before.',
        topics: [],
        summary: null,
        ownerNote: null,
        disposition: 'NEUTRAL',
        callback: null,
      },
      row: null,
      callbackId: null,
    };
  }

  const order = ['NEW', 'KNOWN', 'FAMILIAR', 'REGULAR'];
  const familiarEnough = order.indexOf(row.familiarity) >= order.indexOf(input.voice.callbacksAllowedFrom);
  const callback = familiarEnough ? await relationshipsRepo.dueCallback(row.id) : null;

  return {
    context: {
      known: true,
      handle: row.handle,
      familiarity: row.familiarity,
      historyLine: historyLine(row),
      topics: row.topics.slice(0, 6),
      summary: row.summary || null,
      ownerNote: row.ownerNote || null,
      disposition: row.disposition,
      callback: callback ? { label: callback.label, detail: callback.detail } : null,
    },
    row,
    callbackId: callback?.id ?? null,
  };
}

/**
 * Records that an exchange happened, in both directions.
 *
 * Called after a reply is executed rather than when the event arrives, because
 * an inbound message the agent never answered is not an exchange, and counting
 * it as one is how somebody who repeatedly mentions an agent comes to look like
 * a regular.
 */
export async function recordExchange(input: {
  agentId: string;
  channel: string;
  handle: string | null;
  remoteUserId?: string | null;
  displayName?: string | null;
}): Promise<RelationshipRow | null> {
  const handle = (input.handle ?? '').replace(/^@+/, '');
  if (!handle) return null;

  await relationshipsRepo.recordInteraction({ ...input, handle, direction: 'INBOUND' });
  return relationshipsRepo.recordInteraction({ ...input, handle, direction: 'OUTBOUND' });
}
