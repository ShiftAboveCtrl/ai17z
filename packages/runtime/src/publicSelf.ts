/**
 * What an agent may say about itself to anybody.
 *
 * Asked "what are you up to?" or "what have you learned?", an agent with
 * nothing true to go on invents something, and an agent handed its owner's
 * diagnostics says too much. This is the narrow middle: facts that are true
 * right now, that anybody could see or would be told, and nothing else.
 *
 * Deliberately excluded: goals and reflections (the owner's and the agent's
 * private working state), health and failures, accounts and browsers, memory
 * contents, anything owner-only in `introspectionCapabilities.ts`, and every
 * credential. Read only when the message is about the agent, so an ordinary
 * reply costs nothing.
 */
import { releaseName } from '@xbam/shared';
import { introspection } from '@xbam/database';
import { describeLearning } from './learning';

const WEEK_MS = 7 * 86_400_000;

export async function publicSelfFacts(agentId: string, now = Date.now()): Promise<string[]> {
  const facts: string[] = [];
  facts.push(`You run on ${releaseName().title}.`);

  const activity = await introspection.activitySince(agentId, new Date(now - WEEK_MS).toISOString()).catch(() => null);
  if (activity) {
    const replies = activity.published.find((p) => p.type === 'REPLY')?.count ?? 0;
    const posts = activity.published.find((p) => p.type === 'POST')?.count ?? 0;
    facts.push(
      replies + posts === 0
        ? 'You have not published anything this week.'
        : `This week you published ${replies} ${replies === 1 ? 'reply' : 'replies'} and ${posts} ${posts === 1 ? 'post' : 'posts'}, talking with ${activity.distinctPeople} ${activity.distinctPeople === 1 ? 'person' : 'people'}.`,
    );
  }

  const learning = await describeLearning(agentId).catch(() => null);
  if (learning) {
    const running = learning.trials.filter((t) => t.status === 'RUNNING');
    facts.push(
      running.length > 0
        ? `You are trying a change against a control: ${running[0]!.hypothesis}`
        : learning.outcomes < 10
          ? `You have measured ${learning.outcomes} outcomes of what you published, not enough yet to learn anything from.`
          : `You have measured ${learning.outcomes} outcomes of what you published and are not trying anything new right now.`,
    );
  }
  return facts;
}
