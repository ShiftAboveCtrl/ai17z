import { asksAboutTheAgent, createLogger, spokenQuestion, textStandsAlone } from '@xbam/shared';
import { content as contentRepo, type IdeaRow } from '@xbam/database';

const log = createLogger('content');

/**
 * Where an agent's own posts come from.
 *
 * An agent told to post daily has to post something, and the obvious
 * implementation is "it is 9am, invent a thought". That produces exactly the
 * content nobody wants: generic, untethered, indistinguishable from every other
 * scheduled account.
 *
 * Ideas come from things that actually happened. A scheduled post picks one up
 * rather than starting from nothing, and an agent with an empty backlog posts
 * nothing at all, which is the correct outcome.
 */

/** A question somebody asked that the agent could not answer at the time. */
const UNANSWERED = /\?\s*$/;


/**
 * Whether a question somebody asked could be the subject of a post.
 *
 * Two rules, both learned from a real backlog of twenty-seven captured ideas of
 * which eighteen could never have become a post:
 *
 *   it has to stand on its own -- "what's your thoughts on this?" and "Is the
 *   dex paid?" were captured verbatim, and neither means anything away from the
 *   thread it was asked in
 *
 *   it has to be about something rather than about the agent -- "how are you
 *   feeling?", "why is your website link broken?", "when are you gonna get a
 *   listing?" are conversation and support, not topics anybody else was
 *   wondering about
 */
function couldBeAPost(question: string, topics: readonly string[]): boolean {
  if (!textStandsAlone(question)) return false;
  if (asksAboutTheAgent(question)) return false;
  /*
    And it has to be about something this agent talks about. "How many SOL to
    get this mf into the family?" stood alone and was not about the agent, and
    became a post about the entry fee. A question worth answering for everybody
    names a subject the agent has something to say on.
  */
  const lower = question.toLowerCase();
  return topics.some((topic) =>
    topic
      .toLowerCase()
      .split(/[^a-z0-9$]+/)
      .filter((w) => w.length >= 4)
      .some((w) => lower.includes(w)),
  );
}

export interface HarvestInput {
  agentId: string;
  jobId: string | null;
  /** What the other person said. */
  incoming: string;
  /** What the agent replied. */
  outgoing: string;
  handle: string | null;
  /** What this agent talks about, from its persona. A question outside these is not a post. */
  topics?: readonly string[];
}


/**
 * Notices whether an exchange left something worth saying later.
 *
 * Deliberately conservative: most conversations produce no idea at all, and a
 * backlog padded with everything the agent has ever discussed is the same
 * problem as an empty one.
 */
export async function harvestIdeas(input: HarvestInput): Promise<IdeaRow[]> {
  const captured: IdeaRow[] = [];

  const add = async (kind: string, summary: string, score: number) => {
    const trimmed = summary.trim();
    if (trimmed.length < 20) return;
    if (await contentRepo.similarExists(input.agentId, trimmed)) return;
    captured.push(
      await contentRepo.addIdea({
        agentId: input.agentId,
        kind,
        summary: trimmed,
        source: 'conversation',
        sourceJobId: input.jobId,
        sourceHandle: input.handle,
        score,
      }),
    );
  };

  // A question the agent answered well is a question other people have too --
  // provided it is a question at all away from the thread it was asked in, and
  // provided it is about something rather than about the agent.
  //
  // The handle it was addressed to and the line breaks the client inserted are
  // stripped, because an idea is a note to self and not a screenshot of
  // somebody's tweet. It also made the duplicate check useless: the same
  // question asked twice never compared equal.
  const question = spokenQuestion(input.incoming);
  if (UNANSWERED.test(question) && input.outgoing.length > 60 && couldBeAPost(question, input.topics ?? [])) {
    await add(
      'educational',
      `Somebody asked: ${question.slice(0, 200)}`,
      // Worth saying again, but not urgent.
      60,
    );
  }

  /*
    A position the agent stated in a reply is no longer turned into a post.

    It used to be: the stance a reply matched became "Say more about <subject>:
    <the reply>", scored a flat 70, and the posting engine wrote it up. On
    ai17z-main that was most of what the account posted. The subjects were
    sentence openers ("Good", "Better", "The Telegram"), the summary was the
    reply itself, so each post restated something the agent had just told one
    person, and a conversation about one feature became three near-identical
    posts in two days. A post is something new to say to everybody; an echo
    of a reply is neither.
  */

  if (captured.length > 0) {
    log.info('captured content ideas', { agentId: input.agentId, count: captured.length });
  }
  return captured;
}

export interface ContentBrief {
  idea: IdeaRow;
  /** The instruction handed to generation in place of an incoming message. */
  brief: string;
}

/**
 * Picks up the best idea and turns it into something to write from.
 *
 * Returns null when the backlog is empty, and the caller is expected to post
 * nothing rather than invent something. An agent with nothing to say saying
 * nothing is the correct behaviour.
 */
export async function nextPost(agentId: string): Promise<ContentBrief | null> {
  const idea = await contentRepo.claimBestIdea(agentId);
  if (!idea) return null;

  const lines = [
    'Write a post of your own. Nobody has asked you anything; this is something you wanted to say.',
    '',
    'THE IDEA',
    idea.summary,
  ];
  if (idea.detail) lines.push(idea.detail);

  if (idea.source === 'conversation' && idea.sourceHandle) {
    // Where it came from matters: a thought that started in a conversation
    // should not read as though it is still addressed to that person.
    lines.push(
      '',
      `This came out of a conversation with @${idea.sourceHandle}. Write it as a standalone post, not as a reply to them, and do not name them.`,
    );
  }

  lines.push('', 'Write it the way you write. Do not announce that it is a thought or a reflection.');
  return { idea, brief: lines.join('\n') };
}

/** Puts an idea back when a post was not made after all. */
export async function releaseIdea(agentId: string, id: string): Promise<void> {
  await contentRepo.resolveIdea(agentId, id, 'unused');
}

export async function markIdeaUsed(agentId: string, id: string, jobId: string | null): Promise<void> {
  await contentRepo.resolveIdea(agentId, id, 'used', jobId);
}
