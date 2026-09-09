
import { MediaInventory } from '@xbam/shared/contracts';

import { createLogger } from '@xbam/shared';
import {
  jobs as jobsRepo,
  observability,
} from '@xbam/database';

import { getChannelAdapter } from '@xbam/channels';

import { hasVisionModel } from '../mediaResolve';

import {
  researchModelFor,
  searchWithProvider,
  whyUnavailable,
} from '../xIntelligence';
import {
  research,
  whatToResearch,
} from '../research';
import { planLookups } from '../plan';

import type { JobBundle } from '../loadJob';

import { capResearch } from '../spending';
import { adapterContext } from '../channelContext';

/**
 * Looking something up, when the answer depends on something current.
 *
 * Not part of an ordinary reply: searching before every message is slow,
 * expensive and no better at answering "nice one". What comes back is evidence
 * with a source attached, never knowledge -- an agent that launders a search
 * result into its own voice states a wrong one as confidently as a right one.
 */

const log = createLogger('steps');

export async function stepResearch(bundle: JobBundle): Promise<void> {
  const { job } = bundle;
  const context = job.resolvedContext;
  if (!context) return;

  const inventory = MediaInventory.safeParse((context.meta as { inventory?: unknown })?.inventory);
  const links = inventory.success ? inventory.data.links : [];
  const hasMedia = inventory.success && (inventory.data.media.length > 0 || Boolean(inventory.data.quoted));

  // Whether the post being replied to is one of ours. The branch resolver
  // already worked this out; research had no way to ask, so a reply to the
  // agent made the agent's own last sentence the subject of a web search.
  const parentIsOwn = context.conversation?.parent?.isSelf ?? false;

  const byRules = whatToResearch({
    incoming: context.incomingText,
    parent: context.parentText,
    parentIsOwn,
    links,
    hasUnreadMedia: hasMedia,
  });

  // The rules are right about both ends of the range and blind in the middle,
  // where the question is what a sentence means rather than what it matches.
  // A cheap model settles it when one is configured; when one is not, or it is
  // slow, or it answers badly, the rules stand.
  const plan = await planLookups(bundle.agent.id, job.id, {
    incoming: context.incomingText,
    // Same reason as the rules above: the classifier is choosing what to look
    // up, and our own last reply is not something to look up. It would read a
    // confident sentence written in this agent's voice as a claim about the
    // world worth checking, which is how a model ends up researching itself.
    parent: parentIsOwn ? null : context.parentText,
    hasMedia,
    links,
    deterministic: byRules,
  });
  // The owner's cap on how many lookups one message may cause.
  //
  // Applied after the plan rather than inside it: whoever decided what was
  // worth looking up put the most important first, so trimming the tail keeps
  // the best of a plan that was too ambitious rather than discarding it.
  const researchCap = bundle.policy.budget.maxResearchCallsPerEvent;
  const lookups = capResearch(plan.lookups, researchCap);
  if (plan.lookups.length > lookups.length) {
    log.info('trimmed the research plan to the configured limit', {
      jobId: job.id,
      planned: plan.lookups.length,
      allowed: researchCap,
    });
  }

  // The answer is in the picture and the agent cannot see pictures.
  //
  // This is the quietest way for a reply to be wrong: everything succeeds, the
  // model writes something plausible about a screenshot nobody looked at, and
  // the only trace of the problem is one skipped media row. Somebody asked
  // "what did he roundtrip on?" under a trade screenshot and got an answer
  // assembled out of three articles about waking up at 3am.
  if (plan.needsImage && !(await hasVisionModel(bundle.agent.id))) {
    await observability.emitTrace({
      jobId: job.id,
      agentId: bundle.agent.id,
      type: 'MEDIA_RESOLVED',
      level: 'warn',
      message:
        'Answering this depends on the attached image, and this agent has no vision model. ' +
        'The reply will say it could not see it. Set a vision model under Intelligence.',
      data: { needsImage: true, visionConfigured: false },
    });
  }

  if (lookups.length === 0) {
    await observability.emitTrace({
      jobId: job.id,
      agentId: bundle.agent.id,
      type: 'RESEARCH_DONE',
      message:
        plan.decidedBy === 'model'
          ? 'Nothing here needed looking up; the model was asked and said so.'
          : 'Nothing here needed looking up.',
      data: { lookups: 0, decidedBy: plan.decidedBy, fellBackBecause: plan.fellBackBecause ?? null },
    });
    return;
  }

  // Searching needs a browser, which the channel owns. A channel without one
  // simply cannot, and the result says so rather than pretending it tried.
  const adapter = getChannelAdapter(job.channel);
  const search = adapter.lookUp
    ? async (query: string) => {
        const ctx = await adapterContext(bundle);
        const kind = lookups.find((l) => l.query === query)?.kind === 'link' ? 'link' : 'search';
        const found = await adapter.lookUp!(ctx, { query, kind });
        return found.map((item) => ({
          kind: kind as 'search' | 'link',
          query,
          source: kind === 'link' ? 'The page they linked' : 'Web search',
          title: item.title,
          summary: item.snippet,
          url: item.url,
          retrievedAt: new Date().toISOString(),
        }));
      }
    : undefined;

  // Which token was meant is usually settled a post earlier than the ticker
  // appears: somebody says "everything on Solana pumped" and then asks about
  // "$DOG". The quoted post counts too, and so does our own knowledge of which
  // addresses this agent was given, which is what decides a question about its
  // own token rather than a lookalike using the same three letters.
  const tokenContext = [
    context.incomingText,
    parentIsOwn ? null : context.parentText,
    context.conversation?.quote?.text,
  ]
    .filter(Boolean)
    .join('\n');

  const result = await research(lookups, {
    search,
    tokenContext,
    knownAddresses: bundle.policy.output.verifiedAddresses,
    sources: bundle.policy.tools.research,
  });

  // Search the provider runs on its own side, reaching X's own index.
  //
  // After the ordinary lookups rather than instead of them: this is the source
  // the browser cannot reach, not a replacement for the ones it can. It runs at
  // most once per event whatever the plan asked for, because each call is
  // billed on the owner's key and one question about the conversation is what
  // this is actually good at -- a query per lookup would multiply the bill to
  // answer the same thing.
  if (bundle.policy.tools.research.xIntelligence) {
    const configured = await researchModelFor(bundle.agent.id);
    if (!configured) {
      // Said, not skipped. A source the owner switched on and that never runs
      // is worse than one they left off, because they think it is working.
      const why = await whyUnavailable(bundle.agent.id);
      result.failed.push({ query: lookups[0]!.query, reason: why ?? 'Provider-side search is not available.' });
    } else {
      const provider = await searchWithProvider({
        credentialId: configured.credentialId,
        model: configured.model,
        // The conversation's own question, so the model derives its own
        // queries -- which is the thing it is better at than our rules.
        question: lookups.map((l) => l.query).join('\n'),
        tools: { xSearch: {} },
      });
      result.findings.push(...provider.findings);
      result.failed.push(...provider.failed);

      await observability.emitTrace({
        jobId: job.id,
        agentId: bundle.agent.id,
        type: 'RESEARCH_DONE',
        // A search that was asked for and did not run is a warning, because the
        // reply is about to be written without it.
        level: provider.usage.xSearch + provider.usage.webSearch > 0 ? 'info' : 'warn',
        message: provider.note,
        data: {
          provider: 'server-side',
          model: configured.model,
          // The counts the provider bills on, which is the only evidence a
          // search happened. Its prose is not.
          usage: provider.usage,
          findings: provider.findings.length,
        },
      });
    }
  }

  await jobsRepo.updateJob(job.id, {
    resolvedContext: { ...context, meta: { ...context.meta, research: result } },
  });
  bundle.job.resolvedContext = { ...context, meta: { ...context.meta, research: result } };

  await observability.emitTrace({
    jobId: job.id,
    agentId: bundle.agent.id,
    type: 'RESEARCH_DONE',
    level: result.findings.length === 0 && result.failed.length > 0 ? 'warn' : 'info',
    message: result.note,
    data: {
      // The reasons, not only the count: "looked up 2 things" tells nobody
      // whether it looked up the right two.
      // Which decided, as well as what: a plan and a pattern match look
      // identical once they are both a list of queries.
      decidedBy: plan.decidedBy,
      fellBackBecause: plan.fellBackBecause ?? null,
      lookups: lookups.map((l) => ({ kind: l.kind, query: l.query.slice(0, 80), reason: l.reason })),
      findings: result.findings.map((f) => ({ source: f.source, title: f.title.slice(0, 100), url: f.url })),
      failed: result.failed,
    },
  });
}
