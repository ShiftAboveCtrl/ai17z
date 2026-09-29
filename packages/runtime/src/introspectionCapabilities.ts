/**
 * What an agent can find out about itself, when its owner asks.
 *
 * Asked "why didn't you answer that?" or "what's broken?", a model with no way
 * to look writes a plausible story, and a plausible story about infrastructure
 * or policy is worse than none because the owner acts on it. Every capability
 * here reads rows the runtime already wrote and returns them with a sentence,
 * so what the agent says about itself is what AI17Z recorded.
 *
 * ## Owner only
 *
 * All of these are `audience: 'OWNER'`: never offered in a public
 * conversation and refused if one names them. An agent that would explain its
 * silence to a stranger has told them how to get past it.
 *
 * ## Conclusions, never reasoning
 *
 * No model's chain of thought is stored anywhere in AI17Z, so there is none to
 * return. "Why" is answered from the trace: what the agent saw, the decision a
 * gate recorded and the reason it gave, what the model was handed, what the
 * validator did and what happened after. Anything not recorded is named as
 * not recorded rather than filled in.
 *
 * ## Read only
 *
 * Nothing here changes anything. An owner who wants a belief changed or a
 * Plugin switched off is pointed at the screen that does it.
 */
import { z } from 'zod';
import {
  accounts as accountsRepo,
  agents as agentsRepo,
  deliberation as deliberationRepo,
  introspection,
  knowledge as knowledgeRepo,
  relationships as relationshipsRepo,
  stances as stancesRepo,
} from '@xbam/database';
import { defineCapability, registerCapability, collectDiagnostics, type AnyCapability } from '@xbam/tools';
import type { ComponentHealth } from '@xbam/shared/contracts';
import { explainRehearsal } from './rehearse';
import { describeLearning } from './learning';

const DAY_MS = 86_400_000;

const Days = z.number().int().min(1).max(90).default(7).describe('How many days back to look. Defaults to seven.');

function since(days: number, now = Date.now()): string {
  return new Date(now - days * DAY_MS).toISOString();
}

/** Where in the app the owner fixes something, so an answer can point there. */
function linkFor(agentId: string, area: string): string {
  const base = `/agents/${agentId}`;
  const paths: Record<string, string> = {
    radar: '/settings#radar',
    browser: '/settings#browser',
    accounts: '/settings#accounts',
    providers: '/settings#providers',
    models: `${base}#intelligence`,
    knowledge: `${base}#knowledge`,
    beliefs: `${base}#beliefs`,
    capabilities: '/plugins',
    learning: `${base}#learned`,
    policy: `${base}#policies`,
    jobs: '/activity',
  };
  return paths[area] ?? base;
}

/** A reference to one post: its status id, from a URL or as given. */
export function statusIdOf(ref: string): string {
  const trimmed = ref.trim();
  const fromUrl = /\/status(?:es)?\/(\d{5,25})/.exec(trimmed);
  if (fromUrl) return fromUrl[1]!;
  return trimmed;
}

// ── State ────────────────────────────────────────────────────────────────────

const selfState = defineCapability({
  id: 'agent.self_state',
  name: 'Own setup and state',
  description:
    'Reads who this agent is set up to be right now: persona version, autonomy, connected accounts, ' +
    'how much it remembers and knows, its beliefs, goals and people. Use it when the owner asks about your setup or state.',
  category: 'ANALYTICS',
  effect: 'READ',
  risk: 'LOW',
  audience: 'OWNER',
  input: z.object({}),
  output: z.object({
    name: z.string(),
    state: z.string(),
    personaVersion: z.number().nullable(),
    identity: z.string().nullable(),
    topics: z.array(z.string()),
    autonomy: z.string().nullable(),
    thinking: z.boolean(),
    accounts: z.array(z.object({ handle: z.string().nullable(), channel: z.string(), status: z.string(), acts: z.string() })),
    memories: z.record(z.number()),
    knowledgeSources: z.number(),
    beliefs: z.number(),
    activeGoals: z.number(),
    people: z.record(z.number()),
    detail: z.string(),
  }),
  modelCallable: true,
  timeoutMs: 10_000,
  async run(_input, ctx) {
    const agent = await agentsRepo.requireAgent(ctx.agentId);
    const [persona, links, memories, sources, stances, goals, people, wake] = await Promise.all([
      agentsRepo.getActivePersona(agent.id),
      accountsRepo.listAgentAccounts(agent.id),
      agentsRepo.countMemoriesByScope(agent.id),
      knowledgeRepo.listSources(agent.id),
      stancesRepo.listActive(agent.id, 200),
      deliberationRepo.listGoals(agent.id, { status: 'ACTIVE', limit: 50 }),
      relationshipsRepo.counts(agent.id),
      deliberationRepo.getWake(agent.id),
    ]);
    return {
      name: agent.name,
      state: agent.state,
      personaVersion: persona?.version ?? null,
      identity: persona?.identityKind ?? null,
      topics: persona?.topics.slice(0, 12) ?? [],
      autonomy: wake?.autonomy ?? null,
      thinking: Boolean(wake?.enabled),
      accounts: links.map((l) => ({ handle: l.handle ?? null, channel: l.channel, status: l.status, acts: l.actionType })),
      memories: memories as Record<string, number>,
      knowledgeSources: sources.length,
      beliefs: stances.length,
      activeGoals: goals.length,
      people: people as Record<string, number>,
      detail:
        links.length === 0
          ? 'No account is connected, so this agent cannot read or act anywhere yet.'
          : 'Counts are what is stored now. Nothing here is estimated.',
    };
  },
});

// ── Health ───────────────────────────────────────────────────────────────────

/** The four words an owner is told, from the five the diagnostics use. */
function verdictOf(state: ComponentHealth['state']): 'HEALTHY' | 'DEGRADED' | 'BLOCKED' | 'NOT_CONFIGURED' | 'UNKNOWN' {
  if (state === 'HEALTHY') return 'HEALTHY';
  if (state === 'DEGRADED') return 'DEGRADED';
  if (state === 'FAILING') return 'BLOCKED';
  // Switched off or never set up is not a fault, and saying it is one is how an
  // owner ends up chasing something that was never meant to run.
  if (state === 'OFF') return 'NOT_CONFIGURED';
  return 'UNKNOWN';
}

const HEALTH_AREAS = ['ALL', 'BROWSER', 'X', 'RADAR', 'KNOWLEDGE', 'CAPABILITIES', 'PROVIDERS', 'JOBS'] as const;

const healthReport = defineCapability({
  id: 'agent.health_report',
  name: "What's broken or working",
  description:
    "Checks this agent's real health: browser and X session, Social Radar sources, knowledge sources, capabilities, " +
    "model providers and failed jobs. Each part is healthy, degraded, blocked or not configured. Use it when asked what's broken, " +
    'what is wrong, whether something is working, or about errors and failures.',
  category: 'ANALYTICS',
  effect: 'READ',
  risk: 'LOW',
  audience: 'OWNER',
  input: z.object({ area: z.enum(HEALTH_AREAS).default('ALL'), days: Days }),
  output: z.object({
    canWork: z.boolean(),
    summary: z.string(),
    parts: z.array(
      z.object({ area: z.string(), name: z.string(), verdict: z.string(), detail: z.string(), fixAt: z.string() }),
    ),
    failures: z.array(
      z.object({ status: z.string(), errorClass: z.string().nullable(), count: z.number(), lastError: z.string().nullable(), lastAt: z.string(), jobId: z.string() }),
    ),
    missingModelRoles: z.array(z.string()),
  }),
  modelCallable: true,
  timeoutMs: 20_000,
  async run(input, ctx) {
    const [d, failures] = await Promise.all([
      collectDiagnostics(ctx.agentId),
      input.area === 'ALL' || input.area === 'JOBS' ? introspection.jobFailures(ctx.agentId, since(input.days)) : Promise.resolve([]),
    ]);
    const groups: { area: string; key: string; parts: ComponentHealth[] }[] = [
      { area: 'BROWSER', key: 'browser', parts: d.browser },
      { area: 'X', key: 'accounts', parts: [{ name: 'X account', state: d.account.connected ? 'HEALTHY' : d.account.status ? 'FAILING' : 'OFF', detail: d.account.connected ? `@${d.account.handle} is connected.` : `Account ${d.account.status?.toLowerCase() ?? 'not connected'}.`, lastSucceededAt: d.account.lastPolledAt, failingForMinutes: null }] },
      { area: 'RADAR', key: 'radar', parts: d.radar },
      { area: 'KNOWLEDGE', key: 'knowledge', parts: d.knowledge },
      { area: 'CAPABILITIES', key: 'capabilities', parts: d.tools },
      { area: 'PROVIDERS', key: 'providers', parts: [...d.providers, d.worker] },
    ];
    const parts = groups
      .filter((g) => input.area === 'ALL' || g.area === input.area)
      .flatMap((g) =>
        g.parts.map((p) => ({
          area: g.area,
          name: p.name,
          verdict: verdictOf(p.state),
          detail: p.detail,
          fixAt: linkFor(ctx.agentId, g.key),
        })),
      );
    const bad = parts.filter((p) => p.verdict === 'BLOCKED' || p.verdict === 'DEGRADED');
    return {
      canWork: d.agent.canWork,
      summary: !d.agent.canWork
        ? `Not working: ${d.agent.reason ?? d.agent.state}.`
        : bad.length === 0 && failures.length === 0
          ? 'Nothing is failing. Parts that are not configured are listed as such, which is not a fault.'
          : `${bad.length} part${bad.length === 1 ? '' : 's'} degraded or blocked, ${failures.length} kind${failures.length === 1 ? '' : 's'} of failed work in ${input.days} days.`,
      parts,
      failures: failures.map((f) => ({
        status: f.status,
        errorClass: f.errorClass,
        count: f.count,
        lastError: f.lastError?.slice(0, 300) ?? null,
        lastAt: new Date(f.lastAt).toISOString(),
        jobId: f.lastJobId,
      })),
      // Diagnostics list only roles that have a row, so no primary row at all
      // is the missing role that matters most and would otherwise go unsaid.
      missingModelRoles: [
        ...(d.models.some((m) => m.role === 'primary') ? [] : ['primary']),
        ...d.models.filter((m) => !m.configured).map((m) => m.role),
      ],
    };
  },
});

// ── Activity and growth ──────────────────────────────────────────────────────

const recentActivity = defineCapability({
  id: 'agent.recent_activity',
  name: 'What it did recently',
  description:
    'Lists what this agent actually published and was sent over recent days: replies, posts, likes, who it talked to, ' +
    'and its last few published messages. Use it when asked what you did, have been doing, or posted.',
  category: 'ANALYTICS',
  effect: 'READ',
  risk: 'LOW',
  audience: 'OWNER',
  input: z.object({ days: Days }),
  output: z.object({
    since: z.string(),
    published: z.array(z.object({ type: z.string(), count: z.number() })),
    received: z.array(z.object({ type: z.string(), count: z.number() })),
    distinctPeople: z.number(),
    last: z.array(z.object({ type: z.string(), text: z.string().nullable(), to: z.string().nullable(), url: z.string().nullable(), at: z.string().nullable(), actionId: z.string() })),
    detail: z.string(),
  }),
  modelCallable: true,
  timeoutMs: 10_000,
  async run(input, ctx) {
    const [counts, last] = await Promise.all([
      introspection.activitySince(ctx.agentId, since(input.days)),
      introspection.recentActions(ctx.agentId, 6),
    ]);
    const total = counts.published.reduce((a, b) => a + b.count, 0);
    return {
      since: counts.since,
      published: counts.published,
      received: counts.inbound,
      distinctPeople: counts.distinctPeople,
      last: last.map((a) => ({
        type: a.type,
        text: a.text?.slice(0, 280) ?? null,
        to: a.inReplyTo,
        url: a.url,
        at: a.executedAt ? new Date(a.executedAt).toISOString() : null,
        actionId: a.id,
      })),
      detail:
        total === 0
          ? `Nothing was published in the last ${input.days} days. Rehearsals and dry runs are not counted.`
          : `${total} things published in the last ${input.days} days. Rehearsals and dry runs are not counted.`,
    };
  },
});

const growthSummary = defineCapability({
  id: 'agent.growth_summary',
  name: 'How it has grown',
  description:
    'Measures how this agent has grown over a stated window: interactions, distinct people, conversations that continued, ' +
    'how people are known, reply and post outcomes, trials the learner ran and owner rejections. ' +
    'Use it when asked how you have grown, progressed or improved.',
  category: 'ANALYTICS',
  effect: 'READ',
  risk: 'LOW',
  audience: 'OWNER',
  input: z.object({ days: Days }),
  output: z.object({
    window: z.string(),
    published: z.number(),
    distinctPeople: z.number(),
    conversationsContinued: z.number(),
    people: z.record(z.number()),
    outcomes: z.object({ measured: z.number(), views: z.number().nullable(), likes: z.number(), replies: z.number(), reposts: z.number() }),
    trialsInWindow: z.array(z.object({ hypothesis: z.string(), status: z.string(), verdict: z.string().nullable() })),
    ownerRejections: z.number(),
    detail: z.string(),
  }),
  modelCallable: true,
  timeoutMs: 15_000,
  async run(input, ctx) {
    const from = since(input.days);
    const [activity, outcomes, people, learning, decisions] = await Promise.all([
      introspection.activitySince(ctx.agentId, from),
      introspection.outcomesSince(ctx.agentId, from),
      relationshipsRepo.counts(ctx.agentId),
      describeLearning(ctx.agentId),
      introspection.ownerDecisions(ctx.agentId, from, 100),
    ]);
    const published = activity.published.reduce((a, b) => a + b.count, 0);
    return {
      window: `the last ${input.days} days, since ${from.slice(0, 10)}`,
      published,
      distinctPeople: activity.distinctPeople,
      conversationsContinued: activity.conversationsContinued,
      people: people as Record<string, number>,
      outcomes,
      trialsInWindow: learning.trials
        .filter((t) => t.startedAt >= from || (t.decidedAt ?? '') >= from)
        .map((t) => ({ hypothesis: t.hypothesis, status: t.status, verdict: t.verdict })),
      ownerRejections: decisions.filter((d) => d.decision === 'REJECTED').length,
      detail:
        'Measurements only. Nothing here says why a number moved, so do not offer a cause the data does not show. ' +
        (outcomes.views === null ? 'No view counts were read in this window; that is not the same as zero views.' : ''),
    };
  },
});

// ── Learning ─────────────────────────────────────────────────────────────────

const learningStatus = defineCapability({
  id: 'agent.learning_status',
  name: 'What it is learning',
  description:
    'Reads what this agent is learning from its own outcomes: how many were measured, the choices it can adjust, ' +
    'the hypotheses being tried against a control, and whether each was kept, reverted or is still pending. ' +
    'Use it when asked what you are learning, testing or have learned.',
  category: 'ANALYTICS',
  effect: 'READ',
  risk: 'LOW',
  audience: 'OWNER',
  input: z.object({}),
  output: z.object({
    measuredOutcomes: z.number(),
    enoughEvidence: z.boolean(),
    choices: z.array(
      z.object({ dimension: z.string(), current: z.string().nullable(), status: z.string().nullable(), evidence: z.number(), kept: z.number(), reverted: z.number() }),
    ),
    trials: z.array(z.object({ dimension: z.string(), option: z.string(), hypothesis: z.string(), status: z.string(), verdict: z.string().nullable(), startedAt: z.string() })),
    controlShare: z.string(),
    detail: z.string(),
  }),
  modelCallable: true,
  timeoutMs: 10_000,
  async run(_input, ctx) {
    const view = await describeLearning(ctx.agentId);
    const choices = view.choices.map((c) => ({
      dimension: c.dimension,
      current: c.current?.label ?? null,
      status: c.current?.status ?? null,
      evidence: c.options.reduce((a, o) => a + o.evidence, 0),
      kept: c.kept,
      reverted: c.reverted,
    }));
    const enough = view.trials.length > 0 || choices.some((c) => c.evidence >= 10);
    return {
      measuredOutcomes: view.outcomes,
      enoughEvidence: enough,
      choices,
      trials: view.trials.slice(0, 10).map((t) => ({
        dimension: t.dimension,
        option: t.label,
        hypothesis: t.hypothesis,
        status: t.status,
        verdict: t.verdict,
        startedAt: t.startedAt,
      })),
      controlShare: 'While a trial runs, one decision in five keeps the old behaviour as the control.',
      detail: enough
        ? 'Only choices inside every rule are learned: never identity, safety, permissions, do-not-contact or owner limits.'
        : `Only ${view.outcomes} outcomes measured so far, which is not enough evidence to start a trial. Say so plainly.`,
    };
  },
});

// ── Goals, reflections, beliefs, people ──────────────────────────────────────

const currentGoals = defineCapability({
  id: 'agent.current_goals',
  name: 'Its goals',
  description: 'Lists the goals this agent is holding, their progress and why each exists. Use it when asked about your goals or what you are working towards.',
  category: 'ANALYTICS',
  effect: 'READ',
  risk: 'LOW',
  audience: 'OWNER',
  input: z.object({}),
  output: z.object({
    goals: z.array(z.object({ summary: z.string(), reason: z.string(), origin: z.string(), progress: z.number(), pinned: z.boolean(), since: z.string() })),
    detail: z.string(),
  }),
  modelCallable: true,
  timeoutMs: 10_000,
  async run(_input, ctx) {
    const goals = await deliberationRepo.listGoals(ctx.agentId, { status: 'ACTIVE', limit: 20 });
    return {
      goals: goals.map((g) => ({ summary: g.summary, reason: g.reason, origin: g.origin, progress: g.progress, pinned: g.pinned, since: g.createdAt })),
      detail: goals.length === 0 ? 'No goals are being held. Do not invent any.' : `${goals.length} active goals.`,
    };
  },
});

const recentReflections = defineCapability({
  id: 'agent.recent_reflections',
  name: 'What it has been thinking about',
  description:
    'Reads the conclusions this agent reached when it reflected recently and what is on its working set. ' +
    'Conclusions only, never reasoning. Use it when asked what you have been thinking about or noticed.',
  category: 'ANALYTICS',
  effect: 'READ',
  risk: 'LOW',
  audience: 'OWNER',
  input: z.object({}),
  output: z.object({
    reflections: z.array(z.object({ kind: z.string(), summary: z.string(), at: z.string() })),
    onItsMind: z.array(z.object({ kind: z.string(), summary: z.string(), confidence: z.number() })),
    detail: z.string(),
  }),
  modelCallable: true,
  timeoutMs: 10_000,
  async run(_input, ctx) {
    const [reflections, live] = await Promise.all([
      deliberationRepo.recentReflections(ctx.agentId, 8),
      deliberationRepo.liveItems(ctx.agentId),
    ]);
    return {
      reflections: reflections.map((r) => ({ kind: r.kind, summary: r.summary, at: r.createdAt })),
      onItsMind: live
        .slice(0, 10)
        .map((i) => ({ kind: i.kind, summary: i.summary, confidence: i.confidence })),
      detail: reflections.length === 0 ? 'It has not reflected yet, so there is nothing to report.' : 'A reflection is a stored conclusion, not a transcript.',
    };
  },
});

const explainBelief = defineCapability({
  id: 'agent.explain_belief',
  name: 'Why it holds a belief',
  description:
    'Explains one of this agent\'s beliefs or positions: what it holds, how firmly, whether the owner pinned it, ' +
    'the evidence behind it and how it changed. Use it when asked what you believe or think about a subject and why.',
  category: 'ANALYTICS',
  effect: 'READ',
  risk: 'LOW',
  audience: 'OWNER',
  input: z.object({ subject: z.string().trim().min(1).max(200).describe('The subject, in a few words.') }),
  output: z.object({
    found: z.boolean(),
    subject: z.string(),
    position: z.string().nullable(),
    summary: z.string().nullable(),
    confidence: z.number().nullable(),
    pinnedByOwner: z.boolean(),
    evidence: z.array(z.object({ kind: z.string(), excerpt: z.string(), url: z.string().nullable(), at: z.string() })),
    history: z.array(z.object({ position: z.string(), summary: z.string(), status: z.string(), at: z.string() })),
    detail: z.string(),
  }),
  modelCallable: true,
  timeoutMs: 10_000,
  async run(input, ctx) {
    const held = (await stancesRepo.active(ctx.agentId, input.subject)) ?? (await stancesRepo.relevantTo(ctx.agentId, input.subject, 1))[0] ?? null;
    if (!held) {
      return {
        found: false,
        subject: input.subject,
        position: null,
        summary: null,
        confidence: null,
        pinnedByOwner: false,
        evidence: [],
        history: [],
        detail: `No belief about ${input.subject} is recorded. Say so rather than stating one.`,
      };
    }
    const [evidence, history] = await Promise.all([
      stancesRepo.listEvidence(held.id, 8),
      stancesRepo.history(ctx.agentId, held.subject),
    ]);
    return {
      found: true,
      subject: held.subject,
      position: held.position,
      summary: held.summary,
      confidence: held.confidence,
      pinnedByOwner: held.pinned,
      evidence: evidence.map((e) => ({ kind: e.kind, excerpt: e.excerpt.slice(0, 280), url: e.remoteUrl, at: e.createdAt })),
      history: history.map((h) => ({ position: h.position, summary: h.summary, status: h.status, at: h.createdAt })),
      detail: evidence.length === 0 ? 'Held without recorded evidence: an assertion, and should be described as one.' : 'Every piece of evidence is something published or supplied.',
    };
  },
});

const relationshipSummary = defineCapability({
  id: 'agent.relationship_summary',
  name: 'Who it knows',
  description:
    'Reads what this agent knows about the people it talks to: how well it knows someone, how often you have spoken, ' +
    'what about, and anything the owner noted. Give a handle for one person, or nothing for an overview.',
  category: 'RELATIONSHIPS',
  effect: 'READ',
  risk: 'LOW',
  audience: 'OWNER',
  input: z.object({ handle: z.string().trim().max(80).optional() }),
  output: z.object({
    person: z
      .object({ handle: z.string(), familiarity: z.string(), interactions: z.number(), lastAt: z.string(), topics: z.array(z.string()), summary: z.string(), ownerNote: z.string(), disposition: z.string() })
      .nullable(),
    counts: z.record(z.number()),
    mostTalkedTo: z.array(z.object({ handle: z.string(), interactions: z.number(), familiarity: z.string() })),
    detail: z.string(),
  }),
  modelCallable: true,
  timeoutMs: 10_000,
  async run(input, ctx) {
    const counts = await relationshipsRepo.counts(ctx.agentId);
    const top = (await relationshipsRepo.listForAgent(ctx.agentId, { limit: 50 }))
      .sort((a, b) => b.interactionCount - a.interactionCount)
      .slice(0, 8);
    let person = null;
    if (input.handle) {
      const row = await relationshipsRepo.find({ agentId: ctx.agentId, channel: 'x', handle: input.handle.replace(/^@+/, '') });
      if (row) {
        person = {
          handle: row.handle,
          familiarity: row.familiarity,
          interactions: row.interactionCount,
          lastAt: row.lastInteractionAt,
          topics: row.topics,
          summary: row.summary,
          ownerNote: row.ownerNote,
          disposition: row.disposition,
        };
      }
    }
    return {
      person,
      counts: counts as Record<string, number>,
      mostTalkedTo: top.map((r) => ({ handle: r.handle, interactions: r.interactionCount, familiarity: r.familiarity })),
      detail:
        input.handle && !person
          ? `Nothing has been published between this agent and @${input.handle.replace(/^@+/, '')}, so there is no relationship to describe.`
          : 'Built only from what was actually published between you, never from their timeline.',
    };
  },
});

// ── Explaining what it did and did not do ────────────────────────────────────

const Explanation = z.object({
  found: z.boolean(),
  what: z.string(),
  status: z.string().nullable(),
  subject: z.object({ handle: z.string().nullable(), text: z.string(), url: z.string().nullable() }).nullable(),
  answer: z.string().nullable(),
  steps: z.array(z.object({ step: z.string(), outcome: z.string(), detail: z.string() })),
  notRecorded: z.array(z.string()),
  jobId: z.string().nullable(),
  detail: z.string(),
});
type Explanation = z.infer<typeof Explanation>;

async function explainJob(jobId: string, what: string): Promise<Explanation> {
  const x = await explainRehearsal(jobId);
  return {
    found: true,
    what,
    status: x.status,
    subject: { handle: x.subject.handle, text: x.subject.text.slice(0, 500), url: x.subject.url },
    answer: x.answer,
    // A real reply's stages, without the rehearsal-only stop.
    steps: x.stages
      .filter((s) => s.outcome !== 'SKIPPED' || s.key === 'lookups')
      .filter((s) => !(s.key === 'stop' && !x.dryRun))
      .map((s) => ({ step: s.name, outcome: s.outcome, detail: s.detail.slice(0, 400) })),
    notRecorded: x.gaps,
    jobId,
    detail:
      'Every step is a row AI17Z wrote at the time. There is no hidden reasoning to add: if something is not here, it was not recorded.',
  };
}

const RefInput = z.object({
  ref: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .describe('A link to the post, its status id, or an action or job id.'),
});

const explainAction = defineCapability({
  id: 'agent.explain_action',
  name: 'Why it replied or posted',
  description:
    'Explains why this agent replied, posted or acted, from what was recorded: how it found the post, whether it decided it was worth answering and why, ' +
    'what it remembered and looked up, what the checks did and what was sent. Give a link to the post or reply. ' +
    'Use it when asked why you replied, posted or did something.',
  category: 'ANALYTICS',
  effect: 'READ',
  risk: 'LOW',
  audience: 'OWNER',
  input: RefInput,
  output: Explanation,
  modelCallable: true,
  timeoutMs: 15_000,
  async run(input, ctx) {
    const id = statusIdOf(input.ref);
    const action = await introspection.actionForAgent(ctx.agentId, id);
    if (action) return explainJob(action.jobId, 'An action this agent published.');
    const event = await introspection.eventForAgent(ctx.agentId, id);
    const job = event?.jobs.find((j) => !j.dryRun);
    if (job) return explainJob(job.id, 'A post this agent was working on or answered.');
    return {
      found: false,
      what: 'Nothing this agent did matches that.',
      status: null,
      subject: null,
      answer: null,
      steps: [],
      notRecorded: [],
      jobId: null,
      detail: event
        ? 'The post was recorded, but this agent did nothing with it. Ask why it stayed silent instead.'
        : 'AI17Z has no record of that post for this agent. Say so; do not reconstruct what might have happened.',
    };
  },
});

const explainSilence = defineCapability({
  id: 'agent.explain_silence',
  name: "Why it didn't answer",
  description:
    "Explains why this agent did not reply to a post: whether it saw it, and if so the recorded reason it stayed silent " +
    '(not relevant, stale, a limit or cooldown, policy, do not contact, the owner turned it down, a failure). Give a link to the post. ' +
    "Use it when asked why you didn't answer, ignored something or stayed silent.",
  category: 'ANALYTICS',
  effect: 'READ',
  risk: 'LOW',
  audience: 'OWNER',
  input: RefInput,
  output: Explanation,
  modelCallable: true,
  timeoutMs: 15_000,
  async run(input, ctx) {
    const event = await introspection.eventForAgent(ctx.agentId, statusIdOf(input.ref));
    if (!event) {
      return {
        found: false,
        what: 'This agent never saw that post.',
        status: null,
        subject: null,
        answer: null,
        steps: [],
        notRecorded: ['No monitor, search or mention recorded this post for any account this agent uses.'],
        jobId: null,
        detail:
          'Not seeing a post is itself the answer: it was never found. Suggest checking Social Radar sources if it should have been.',
      };
    }
    const job = event.jobs.find((j) => !j.dryRun);
    if (!job) {
      return {
        found: true,
        what: 'Seen, and no work was created for this agent.',
        status: 'NOT_QUEUED',
        subject: { handle: event.authorHandle, text: event.text.slice(0, 500), url: event.url },
        answer: null,
        steps: [
          {
            step: 'Decided whether to consider it at all',
            outcome: 'DECIDED_AGAINST',
            detail: event.skipReason ?? 'The reason was not recorded: this post was seen before AI17Z kept reasons for posts it set aside.',
          },
        ],
        notRecorded: event.skipReason ? [] : ['Why it was set aside.'],
        jobId: null,
        detail: 'Silence is a valid outcome. Report the recorded reason; if none was recorded, say that rather than guessing one.',
      };
    }
    const explained = await explainJob(job.id, 'Seen, and considered.');
    return {
      ...explained,
      what:
        job.status === 'CANCELLED'
          ? 'Seen, considered, and it decided not to answer.'
          : job.status === 'EXECUTED'
            ? 'It did answer this.'
            : `Seen and considered; the work ended as ${job.status.toLowerCase().replace(/_/g, ' ')}.`,
    };
  },
});

// ── Owner decisions and changes ──────────────────────────────────────────────

const ownerDecisions = defineCapability({
  id: 'agent.owner_decisions',
  name: 'What the owner approved or rejected',
  description:
    'Lists what the owner approved, edited or rejected for this agent recently, with any note. ' +
    'Use it when asked what was approved, rejected or turned down.',
  category: 'ANALYTICS',
  effect: 'READ',
  risk: 'LOW',
  audience: 'OWNER',
  input: z.object({ days: Days }),
  output: z.object({
    decisions: z.array(z.object({ kind: z.string(), decision: z.string(), subject: z.string().nullable(), note: z.string().nullable(), at: z.string() })),
    detail: z.string(),
  }),
  modelCallable: true,
  timeoutMs: 10_000,
  async run(input, ctx) {
    const decisions = await introspection.ownerDecisions(ctx.agentId, since(input.days));
    return {
      decisions,
      detail: decisions.length === 0 ? `No owner decisions in the last ${input.days} days.` : `${decisions.length} decisions, newest first.`,
    };
  },
});

const recentChanges = defineCapability({
  id: 'agent.recent_changes',
  name: 'What changed in its setup',
  description:
    "Lists recent changes to this agent's setup: persona and policy versions and settings changed, with their notes. " +
    'Use it when asked what changed, what was updated or edited.',
  category: 'ANALYTICS',
  effect: 'READ',
  risk: 'LOW',
  audience: 'OWNER',
  input: z.object({ days: Days }),
  output: z.object({
    changes: z.array(z.object({ what: z.string(), version: z.number().nullable(), note: z.string().nullable(), at: z.string() })),
    detail: z.string(),
  }),
  modelCallable: true,
  timeoutMs: 10_000,
  async run(input, ctx) {
    const changes = await introspection.recentChanges(ctx.agentId, since(input.days));
    return {
      changes,
      detail: changes.length === 0 ? `Nothing about this agent's setup changed in the last ${input.days} days.` : `${changes.length} changes, newest first.`,
    };
  },
});

export const INTROSPECTION_CAPABILITIES = [
  selfState,
  healthReport,
  recentActivity,
  growthSummary,
  learningStatus,
  currentGoals,
  recentReflections,
  explainBelief,
  relationshipSummary,
  explainAction,
  explainSilence,
  ownerDecisions,
  recentChanges,
] as unknown as AnyCapability[];

/** Registered from the runtime, because each one reads the agent's own rows. */
export function registerIntrospectionCapabilities(): void {
  for (const capability of INTROSPECTION_CAPABILITIES) registerCapability(capability);
}
