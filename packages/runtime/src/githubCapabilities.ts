import { z } from 'zod';
import { agents as agentsRepo, repoSources } from '@xbam/database';
import { defineCapability, registerCapability } from '@xbam/tools';

/**
 * What a project did, as something a model may ask about.
 *
 * The watcher already follows repositories and records what they did. These are
 * the reads that let an agent answer a question about one -- "what shipped in
 * the last release", "is that issue fixed", "what changed this week" -- from
 * the record rather than from whatever it happened to notice.
 *
 * ## Answered from what was recorded, never from a fresh request
 *
 * Every capability here reads `repo_events`. None of them calls GitHub. That is
 * the important line and it buys three things:
 *
 *   - a model cannot make an agent hammer somebody else's API by asking the
 *     same question in a loop;
 *   - every answer carries the URL the fact came from, because the row does;
 *   - what an agent can say about a project is exactly what an owner can see on
 *     the screen, rather than a larger, invisible set.
 *
 * An owner who wants an agent to know about a repository adds the watch. The
 * agent cannot add one itself, and nothing here would let it.
 *
 * ## Read only, permanently
 *
 * No push, no merge, no comment, no release, no issue. Not by configuration and
 * not by argument: the repository layer has no write in it, so there is nothing
 * for a capability to call even if one were written.
 */

/** Bounded, because an unbounded answer is a prompt nobody sized. */
const MAX_ITEMS = 25;

const RepoName = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/, 'Give it as owner/name.')
  .describe('The repository, as owner/name.');

/** One recorded event, in the shape a model reads best. */
const RepoEvent = z.object({
  repo: z.string(),
  kind: z.string(),
  id: z.string(),
  title: z.string(),
  url: z.string(),
  state: z.string().nullable(),
  at: z.string().nullable(),
});

/**
 * Which watches this agent may read.
 *
 * Its own and the installation's. An agent may never read a watch belonging to
 * a different agent, which is the same boundary every other per-agent read has.
 */
async function watchedBy(agentId: string): Promise<{ ownerId: string; repos: string[] } | null> {
  const agent = await agentsRepo.getAgent(agentId);
  if (!agent) return null;
  const sources = await repoSources.listRepos(agent.ownerId, agentId);
  return { ownerId: agent.ownerId, repos: sources.map((source) => source.repo.toLowerCase()) };
}

const readActivity = defineCapability({
  id: 'github.read_activity',
  name: 'What a watched project did',
  description:
    'Lists what a repository AI17Z watches has recently done — releases, merged changes, issues — with a link for each. ' +
    'Use it when somebody asks what changed, what shipped, or whether something is fixed.',
  category: 'RESEARCH',
  effect: 'READ',
  risk: 'LOW',
  input: z.object({
    repo: RepoName.optional().describe('Leave out to see everything this agent follows.'),
    kind: z.enum(['RELEASE', 'COMMIT', 'PULL_REQUEST', 'ISSUE', 'WORKFLOW']).optional(),
    limit: z.number().int().min(1).max(MAX_ITEMS).default(10),
  }),
  output: z.object({
    events: z.array(RepoEvent),
    watching: z.array(z.string()),
    /** Said plainly when there is nothing, so the model does not invent some. */
    detail: z.string(),
  }),
  modelCallable: true,
  timeoutMs: 10_000,
  async run(input, ctx) {
    const watched = await watchedBy(ctx.agentId);
    if (!watched || watched.repos.length === 0) {
      return {
        events: [],
        watching: [],
        detail: 'This agent does not follow any repository, so it knows nothing about what any project has done.',
      };
    }
    /*
      A name nobody follows is an unanswered question, never a quiet project.

      The empty list here says the question did not match, and a reader that
      takes it for a measurement reports that a busy repository has done
      nothing. Measured on the installed product: asked what had been happening
      in the ai17z repository, the model guessed `ai17z/ai17z`, was told
      correctly that this agent follows `shiftabovectrl/ai17z` instead, and
      answered that the events list "came back empty" while 156 recorded events
      sat under the name it had just been given.

      So the sentence names what to ask for instead. It is the same rule the X
      reading layer states as "absent is never zero", one layer up: the caller
      here is a model, and what it acts on is this sentence.
    */
    if (input.repo && !watched.repos.includes(input.repo.toLowerCase())) {
      const instead = watched.repos.join(', ');
      return {
        events: [],
        watching: watched.repos,
        detail:
          `This agent does not follow ${input.repo}, so nothing here is about it and none of this is a count of ` +
          `its activity. It follows ${instead}. Ask again for ${watched.repos[0]} if that is the one meant.`,
      };
    }

    const rows = await repoSources.recentRepoEvents({
      ownerUserId: watched.ownerId,
      agentId: ctx.agentId,
      limit: MAX_ITEMS * 2,
    });
    const events = rows
      .filter((row) => (input.repo ? row.repo.toLowerCase() === input.repo.toLowerCase() : true))
      .filter((row) => (input.kind ? row.kind === input.kind : true))
      .slice(0, input.limit)
      .map((row) => ({
        repo: row.repo,
        kind: row.kind,
        id: row.remoteId,
        title: row.title,
        url: row.url,
        state: row.state,
        at: row.occurredAt,
      }));

    return {
      events,
      watching: watched.repos,
      detail:
        events.length > 0
          ? `${events.length} thing${events.length === 1 ? '' : 's'} AI17Z recorded from ${input.repo ?? 'the projects this agent follows'}.`
          : 'Nothing has been recorded for that yet. Say so rather than guessing what happened.',
    };
  },
});

const readRelease = defineCapability({
  id: 'github.read_release',
  name: 'What was in a release',
  description:
    'Reads one release of a watched repository and returns its notes, so the agent can say what actually shipped ' +
    'rather than describing a version it has not read.',
  category: 'RESEARCH',
  effect: 'READ',
  risk: 'LOW',
  input: z.object({
    repo: RepoName,
    /** A tag, or nothing for the newest. */
    tag: z.string().trim().max(100).optional().describe('The tag. Leave out for the most recent release.'),
  }),
  output: z.object({
    found: z.boolean(),
    repo: z.string(),
    tag: z.string().nullable(),
    title: z.string(),
    /** The release notes as published. Never a summary of them written here. */
    notes: z.string(),
    url: z.string(),
    at: z.string().nullable(),
    detail: z.string(),
  }),
  modelCallable: true,
  timeoutMs: 10_000,
  async run(input, ctx) {
    const watched = await watchedBy(ctx.agentId);
    const empty = { found: false, repo: input.repo, tag: null, title: '', notes: '', url: '', at: null };
    if (!watched || !watched.repos.includes(input.repo.toLowerCase())) {
      return { ...empty, detail: `This agent does not follow ${input.repo}, so it has not read its releases.` };
    }

    const rows = await repoSources.recentRepoEvents({ ownerUserId: watched.ownerId, agentId: ctx.agentId, limit: 200 });
    const releases = rows.filter(
      (row) => row.kind === 'RELEASE' && row.repo.toLowerCase() === input.repo.toLowerCase(),
    );
    const found = input.tag ? releases.find((row) => row.remoteId === input.tag) : releases[0];
    if (!found) {
      // Said rather than approximated. An agent that answers about a release it
      // has not read invents a changelog, and a plausible invented changelog is
      // worse than an admission.
      return {
        ...empty,
        detail: input.tag
          ? `AI17Z has not recorded a release tagged ${input.tag} for ${input.repo}.`
          : `AI17Z has not recorded any release for ${input.repo}.`,
      };
    }

    return {
      found: true,
      repo: found.repo,
      tag: found.remoteId,
      title: found.title,
      notes: found.body,
      url: found.url,
      at: found.occurredAt,
      detail: `Release notes as published. Do not describe anything that is not in them.`,
    };
  },
});

/**
 * Registered from the runtime rather than from the tools package, for the same
 * reason X's capabilities are: these need the agent row to know whose watches
 * they may read, which is database work the tools package does not do.
 */
export function registerGithubCapabilities(): void {
  registerCapability(readActivity);
  registerCapability(readRelease);
}
