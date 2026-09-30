/**
 * Re-judging what an agent learned on its own, by the rules it learns by now.
 *
 * Learning rules improve, and what was learned under the old ones stays. On
 * ai17z-main every learned stance was a sentence opener ("Being", "What",
 * "Better") or a handle, held at up to 0.92 confidence with somebody's whole
 * reply as its summary, and those stances were what the posting engine kept
 * writing up. Fixing the rule stops new ones; this retires the old ones.
 *
 * Nothing is deleted. A stance is RETIRED, which keeps it and its evidence and
 * takes it out of every prompt, and each retirement leaves an audit row with
 * the reason and what the stance said. Anything the owner pinned or wrote is
 * never touched. Dry by default: `apply` has to be asked for.
 */
import { content as contentRepo, ops, stances as stancesRepo } from '@xbam/database';
import { candidateSubjects } from './stance';

export interface ReviewedStance {
  id: string;
  subject: string;
  summary: string;
  reason: string;
}

export interface LearnedStateReview {
  stances: { kept: number; retire: ReviewedStance[] };
  ideas: { discard: { id: string; summary: string; reason: string }[] };
  applied: boolean;
}

/** Why today's rules would not have learned this stance, or null if they would. */
export function whyNotLearnable(subject: string, excerpts: readonly string[], selfNames: readonly string[]): string | null {
  const key = subject.toLowerCase();
  const selves = selfNames.map((n) => n.toLowerCase().replace(/^@/, '')).filter((n) => n.length >= 3);
  if (selves.some((self) => key === self || key.includes(self))) return 'It is a position about the agent itself.';
  for (const excerpt of excerpts) {
    if (new RegExp(`@${subject.replace(/[^A-Za-z0-9_]/g, '')}\\b`, 'i').test(excerpt)) return 'The subject is a person the agent was replying to.';
  }
  const stillFound = excerpts.some((excerpt) => candidateSubjects(excerpt).some((s) => s.toLowerCase() === key));
  return stillFound ? null : 'The subject is a word that opened a sentence, not something a position can be about.';
}

/** Ideas that only exist because a reply was echoed back as a post. */
const ECHO_IDEA = /^Say more about /;

export async function reviewLearnedState(input: {
  agentId: string;
  selfNames: readonly string[];
  apply?: boolean;
  actorUserId?: string | null;
}): Promise<LearnedStateReview> {
  const retire: ReviewedStance[] = [];
  let kept = 0;
  for (const stance of await stancesRepo.listActive(input.agentId, 500)) {
    if (stance.pinned) {
      kept += 1;
      continue;
    }
    const evidence = await stancesRepo.listEvidence(stance.id, 20);
    // A stance with no evidence of something the agent said was put there by
    // somebody, the owner or the Foundry, and is theirs to change.
    const said = evidence.filter((e) => e.kind === 'said');
    if (said.length === 0) {
      kept += 1;
      continue;
    }
    const reason = whyNotLearnable(stance.subject, said.map((e) => e.excerpt), input.selfNames);
    if (reason) retire.push({ id: stance.id, subject: stance.subject, summary: stance.summary, reason });
    else kept += 1;
  }

  const discard = (await contentRepo.listIdeas(input.agentId, 'unused'))
    .filter((idea) => ECHO_IDEA.test(idea.summary))
    .map((idea) => ({ id: idea.id, summary: idea.summary, reason: 'An echo of one of its own replies, not something new to say.' }));

  if (input.apply) {
    for (const stance of retire) {
      await stancesRepo.update(stance.id, { status: 'RETIRED' });
      await ops.audit({
        actorUserId: input.actorUserId ?? null,
        action: 'agent.stance.retired',
        entityType: 'agent',
        entityId: input.agentId,
        data: { agentId: input.agentId, stanceId: stance.id, subject: stance.subject, summary: stance.summary, reason: stance.reason },
      });
    }
    for (const idea of discard) {
      await contentRepo.resolveIdea(input.agentId, idea.id, 'discarded');
    }
    if (discard.length > 0) {
      await ops.audit({
        actorUserId: input.actorUserId ?? null,
        action: 'agent.ideas.discarded',
        entityType: 'agent',
        entityId: input.agentId,
        data: { agentId: input.agentId, count: discard.length, reason: discard[0]!.reason },
      });
    }
  }
  return { stances: { kept, retire }, ideas: { discard }, applied: Boolean(input.apply) };
}
