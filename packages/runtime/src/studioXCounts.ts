import { z } from 'zod';
import { accounts, query } from '@xbam/database';

const Reading = z.object({
  value: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  readAt: z.iso.datetime().nullable(),
}).strict().refine((r) => r.value === null || r.readAt !== null, 'A measured count needs its read time');

/** Mirrored by Studio. No identities, post URLs or performance fields. */
export const XCounts = z.object({
  consented: z.boolean(), followers: Reading, posts: Reading,
  likes: Reading, replies: Reading, reposts: Reading,
}).strict();

/**
 * Reuse observations already collected by the canonical X reading layer.
 * This sender never reads X, so preview, publish and renewal spend no reads.
 * Exactly one enabled X account must belong to the owner and agent. Profile
 * identity must match its immutable id; handles alone cannot survive renames.
 */
export async function storedHomeXCounts(agentId: string, ownerId: string): Promise<z.infer<typeof XCounts>> {
  const empty = () => ({ value: null, readAt: null });
  const absent = { consented: true, followers: empty(), posts: empty(), likes: empty(), replies: empty(), reposts: empty() };
  const links = (await accounts.listAgentAccounts(agentId)).filter((a) => a.channel === 'x' && a.enabled && a.accountEnabled);
  if (links.length !== 1) return absent;
  const account = await accounts.getAccount(links[0]!.accountId);
  if (!account || account.ownerId !== ownerId) return absent;
  const [profile] = account.remoteAccountId ? await query<{ followers: number | null; posts: number | null; observed_at: Date }>(
    `SELECT followers, posts, observed_at FROM x_account_observations
      WHERE owner_user_id=$1 AND user_id=$2 AND outcome='OK'
      ORDER BY observed_at DESC LIMIT 1`, [ownerId, account.remoteAccountId]) : [];
  // The radar already measures the account's own audience without a timeline.
  // Keep that reading's date; it says nothing about the total number of posts.
  const [audience] = await query<{ followers: number | null; observed_at: Date }>(
    `SELECT followers, observed_at FROM account_analytics WHERE agent_id=$1 AND account_id=$2
      ORDER BY observed_at DESC, id DESC LIMIT 1`, [agentId, account.id]);
  const followerSource = audience && (!profile || new Date(audience.observed_at).getTime() > new Date(profile.observed_at).getTime()) ? audience : profile;
  // One actual published post, not a sum that turns unmeasured posts into zeros.
  // Its action and event prove that this was neither a dry run nor a rehearsal.
  const [post] = await query<{ likes: number | null; replies: number | null; reposts: number | null; observed_at: Date }>(
    `SELECT p.likes, p.replies, p.reposts, p.observed_at FROM post_analytics p
      JOIN actions a ON a.id=p.action_id AND a.agent_id=p.agent_id AND a.account_id=p.account_id
      JOIN jobs j ON j.id=a.job_id JOIN events e ON e.id=j.event_id
      WHERE p.agent_id=$1 AND p.account_id=$2 AND p.channel='x'
        AND a.channel='x' AND a.status='EXECUTED' AND a.dry_run=false AND a.type IN ('POST','REPLY')
        AND a.remote_action_id=p.remote_post_id
        AND COALESCE(e.payload->>'rehearsal','false') <> 'true'
        AND COALESCE(e.payload->>'origin','') <> 'rehearsal'
      ORDER BY p.observed_at DESC, p.id DESC LIMIT 1`, [agentId, account.id]);
  const reading = (value: number | null | undefined, at: Date | undefined) => ({ value: value ?? null, readAt: at ? new Date(at).toISOString() : null });
  return XCounts.parse({ consented: true,
    followers: reading(followerSource?.followers, followerSource?.observed_at), posts: reading(profile?.posts, profile?.observed_at),
    likes: reading(post?.likes, post?.observed_at), replies: reading(post?.replies, post?.observed_at), reposts: reading(post?.reposts, post?.observed_at) });
}
