import { z } from 'zod';
import { accounts as accountsRepo, agents as agentsRepo } from '@xbam/database';
import { truncate } from '@xbam/shared';
import type { ToolDefinition } from '../contract';

const Input = z.object({
  handle: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .describe('The X account to read, with or without the @.'),
  posts: z
    .number()
    .int()
    .min(0)
    .max(40)
    .default(12)
    .describe('How many of their recent posts to read. 0 for the profile only.'),
});

/**
 * Looking up a public X account, for an agent that needs to know who it is
 * talking to.
 *
 * ## Why this is worth being a capability at all
 *
 * An agent asked "who is @someone and what do they care about" cannot answer
 * from a training set: the account may not have existed then, and what somebody
 * posts about changes. Without this the model either says it does not know, or
 * -- much worse -- writes a confident description of a person it has never
 * read. Giving it a way to actually look is what makes the first answer
 * unnecessary and the second unforgivable.
 *
 * ## What it is honest about
 *
 * **AI17Z does the reading, not the model.** The output says so in those words.
 * A model handed data it did not fetch will happily narrate having fetched it,
 * and "I checked their timeline" from something that checked nothing is exactly
 * the kind of claim this codebase refuses elsewhere -- see the rule that an
 * agent never says it searched X unless a search ran.
 *
 * Every answer carries when it was read and which reader produced it, because a
 * profile read ten minutes ago and one read now are different evidence, and a
 * partial read is a smaller claim than a complete one.
 *
 * ## Read-only, and that is structural
 *
 * There is no follow, like, reply or message here, and there is no way to add
 * one: this calls the X intelligence layer, and that layer has no write in it.
 * Acting on X belongs to the engagement pipeline, behind its policies,
 * approvals and audit trail. A capability that could act would route around
 * every one of them, and the fact that other tools in this space expose
 * following and liking is not a reason to.
 */
export const xAccountReadTool: ToolDefinition<z.infer<typeof Input>> = {
  // `family.verb_noun`, which is the shape the registry enforces and the
  // shape a family is offered as a group by. Not `x.account.read`: that is
  // three segments, and the registry refuses it.
  key: 'x.read_account',
  name: 'Read an X account',
  description:
    'Looks up a public X account and its recent posts, so the agent can say who somebody is from what they actually wrote rather than from memory.',
  kind: 'BUILTIN',
  inputSchema: Input,
  // Reading a public profile changes nothing and costs one browser read. It is
  // safe in the sense this flag means: it cannot act, and it cannot be turned
  // into acting.
  safeByDefault: true,

  async execute(input, ctx) {
    const { xIntelligence } = await import('@xbam/channels');
    const { buildChannelContext } = await import('@xbam/runtime');

    // Reading X needs a session, and the session belongs to an account. The
    // agent's own account does the reading; it reads a public profile, so
    // whose session it is does not change the answer.
    const agent = await agentsRepo.getAgent(ctx.agentId);
    if (!agent) return { ok: false, output: 'This agent no longer exists.' };
    const owned = await accountsRepo.listAccounts(agent.ownerId);
    const reader = owned.find((a) => a.channel === 'x' && a.enabled);
    if (!reader) {
      return {
        ok: false,
        output:
          'AI17Z reads X through a signed-in browser and no X account is connected, so it could not look this up.',
      };
    }
    const channel = await buildChannelContext(reader, ctx.jobId);

    const resolved = await xIntelligence.resolveUser(input.handle, { channel });
    if (resolved.outcome !== 'OK' || !resolved.data) {
      // The refusal in its own words. A protected account, a missing one and a
      // browser that needs signing in are different facts, and an agent told
      // "could not read that" will guess which.
      return { ok: false, output: resolved.detail || `AI17Z could not read @${input.handle}.` };
    }
    const user = resolved.data;

    const lines: string[] = [];
    lines.push(`AI17Z read @${user.handle}${user.displayName ? ` (${user.displayName})` : ''} on X just now.`);
    if (user.bio) lines.push(`Their bio: ${truncate(user.bio, 280)}`);
    const counts = [
      user.followers === null ? null : `${user.followers.toLocaleString()} followers`,
      user.following === null ? null : `following ${user.following.toLocaleString()}`,
      user.posts === null ? null : `${user.posts.toLocaleString()} posts`,
    ].filter(Boolean);
    if (counts.length > 0) lines.push(counts.join(', ') + '.');
    if (user.location) lines.push(`Location on their profile: ${user.location}`);

    let collected = 0;
    if (input.posts > 0 && user.userId) {
      const timeline = await xIntelligence.getUserPosts(
        { userId: user.userId, handle: user.handle, limit: input.posts, includeReplies: true, includeReposts: false },
        { channel },
      );
      if (timeline.outcome === 'OK' && timeline.data.length > 0) {
        collected = timeline.data.length;
        lines.push('', `Their ${collected} most recent posts, as AI17Z read them:`);
        for (const post of timeline.data) {
          const when = post.createdAt ? ` (${post.createdAt})` : '';
          lines.push(`- ${truncate(post.text.replace(/\s+/g, ' '), 220)}${when}`);
        }
      } else if (timeline.outcome !== 'OK') {
        // Said rather than omitted: an agent that does not know the posts were
        // unreadable will treat their absence as the account being quiet.
        lines.push('', `Their posts could not be read: ${timeline.detail}`);
      }
    }

    lines.push(
      '',
      `Read by AI17Z at ${resolved.provenance.collectedAt}. This is what the account says publicly, not a judgement about the person.`,
    );

    return {
      ok: true,
      output: lines.join('\n'),
      data: {
        userId: user.userId || null,
        handle: user.handle,
        followers: user.followers,
        following: user.following,
        postsRead: collected,
        // Carried so a trace can answer "where did this come from" without
        // re-reading the output text.
        backend: resolved.provenance.backend,
        collectedAt: resolved.provenance.collectedAt,
      },
    };
  },
};
