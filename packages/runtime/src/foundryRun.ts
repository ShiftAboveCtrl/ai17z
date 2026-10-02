/**
 * A Foundry run, advanced a stage at a time.
 *
 * The run is a research run in the Research Fabric's table, claimed under a
 * lease by the worker. Each stage commits what it found before the next
 * starts, so a restart resumes at the stage after the last one committed, and
 * every stage is safe to repeat: gathering records observations that dedupe
 * into the same objects, and proposing upserts items by key without touching
 * one the owner already decided.
 *
 * Everything that needs a browser (reading X, searching, reading a mirror) is
 * handed in as a dependency. The worker supplies real ones; tests supply fakes.
 * The run never needs more than the platform: every secondary source is
 * optional, and a run whose only source was X completes and says so.
 */
import {
  FOUNDRY_STAGE_LABELS,
  FOUNDRY_STAGES,
  FoundryBrief,
  gradeEvidence,
  gradeTeachesVoice,
  type FoundrySection,
  type FoundryStage,
  type ResearchObservation,
} from '@xbam/shared/contracts';
import { createLogger, errorMessage } from '@xbam/shared';
import { foundry as foundryRepo, research as researchRepo, type ResearchRunRow } from '@xbam/database';
import { analyseCorpus, compileFoundry, type DiscoveredSource, type FoundryCorpusItem } from './foundry';
import { currentAgent } from './foundryApply';
import { gather, type FabricSource, type GatherReport } from './researchFabric';

const log = createLogger('foundry');

export interface FoundryProfile {
  handle: string;
  displayName: string | null;
  bio: string | null;
  website: string | null;
}

export interface FoundryDeps {
  workerId: string;
  /** How long a stage may hold the run before another worker may take it. */
  leaseMs: number;
  /** The platform itself. Null when no X account is connected to read through. */
  platform: FabricSource | null;
  /** Search engines, for posts the platform did not surface and for project sources. */
  searchIndex: FabricSource | null;
  /** Optional mirrors. Each may be unavailable; none is ever required. */
  mirrors: FabricSource[];
  resolveProfile(handle: string): Promise<FoundryProfile | null>;
  /** A web search, for finding a project's own documentation and repository. */
  search(query: string): Promise<{ title: string; snippet: string; url: string | null }[]>;
  /** Reads one post on the platform, to confirm a copy found elsewhere. */
  confirmPost(statusId: string): Promise<ResearchObservation | null>;
}

/** Stages whose proposals are written, and the sections each writes. */
const WRITES: Partial<Record<FoundryStage, FoundrySection[]>> = {
  VOICE: ['IDENTITY', 'STYLE'],
  TOPICS: ['TOPICS'],
  BELIEFS: ['BELIEFS'],
  KNOWLEDGE: ['KNOWLEDGE', 'PERSONA_SOURCES', 'RADAR', 'CAPABILITIES'],
  SAFETY: ['MUST_NEVER', 'INSTRUCTIONS', 'AUTONOMY', 'LANGUAGE', 'LEARNING'],
  TESTS: ['TESTS'],
};

/** How many copies found only on a mirror or in a search result are checked against X. */
const CONFIRM_LIMIT = 40;

/** The stage after the last one committed. */
export function nextStage(run: Pick<ResearchRunRow, 'stageLog'>): FoundryStage | null {
  const done = new Set(run.stageLog.map((entry) => entry.stage));
  return FOUNDRY_STAGES.find((stage) => !done.has(stage)) ?? null;
}

/** How many times a run may come back for a timeline X would not show, before it says so and stops. */
export const MAX_X_ATTEMPTS = 5;

interface FoundryPlan {
  handle: string | null;
  projects: string[];
  profile: FoundryProfile | null;
  discovered: DiscoveredSource[];
  gaps: string[];
  coverage: { family: string; state: string; detail: string; observed: number }[];
}

function planOf(run: ResearchRunRow): FoundryPlan {
  const plan = run.plan as Partial<FoundryPlan>;
  return {
    handle: plan.handle ?? null,
    projects: plan.projects ?? [],
    profile: plan.profile ?? null,
    discovered: plan.discovered ?? [],
    gaps: plan.gaps ?? [],
    coverage: plan.coverage ?? [],
  };
}

/** A project's official documentation and repository, from what a search and the owner offered. */
export function classifyDiscovered(input: {
  project: string;
  results: { title: string; url: string | null }[];
  ownerUrls: string[];
  profileWebsite: string | null;
}): DiscoveredSource[] {
  const slug = input.project.toLowerCase().replace(/[^a-z0-9]/g, '');
  const out: DiscoveredSource[] = [];
  const seen = new Set<string>();
  const add = (url: string, title: string, official: boolean, why: string) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return;
    }
    if (u.protocol !== 'https:') return;
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const path = u.pathname.replace(/\/+$/, '');
    const repo = host === 'github.com' ? path.split('/').filter(Boolean).slice(0, 2) : null;
    const kind: DiscoveredSource['kind'] =
      repo && repo.length === 2 ? 'GITHUB_REPOSITORY' : /^docs?\.|^developers?\.|\.gitbook\.io$/.test(host) || /\/docs?(\/|$)/.test(path) ? 'DOCUMENTATION_SITE' : 'URL';
    const location = kind === 'GITHUB_REPOSITORY' ? `https://github.com/${repo![0]}/${repo![1]}` : `${u.origin}${path || '/'}`;
    const key = location.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const generation = `${path} ${title}`.match(/\b[vV](\d{1,2})\b/)?.[0]?.toUpperCase() ?? null;
    out.push({ kind, location, title: title || location, project: input.project, generation, official, why });
  };

  for (const url of input.ownerUrls) add(url, url, true, 'You gave this address.');
  // The persona's own site is official for the project it names, and only that
  // one: linking to pons.example says nothing about any other project.
  if (input.profileWebsite && slug.length >= 3 && input.profileWebsite.toLowerCase().replace(/[^a-z0-9.]/g, '').includes(slug)) {
    add(input.profileWebsite, input.profileWebsite, true, 'The persona links to it from their own profile.');
  }
  for (const result of input.results) {
    if (!result.url) continue;
    const lower = result.url.toLowerCase();
    // Official means on the project's own domain or under its own GitHub
    // organisation. A result about the project on somebody else's site is
    // commentary, and commentary is not a source for its facts.
    const onOwnDomain = slug.length >= 3 && (() => {
      try {
        const u = new URL(result.url!);
        const host = u.hostname.toLowerCase();
        if (host === 'github.com') return (u.pathname.split('/')[1] ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').includes(slug);
        return host.replace(/[^a-z0-9.]/g, '').split('.').some((label) => label.includes(slug));
      } catch {
        return false;
      }
    })();
    if (!onOwnDomain) continue;
    add(result.url, result.title, true, lower.includes('github.com') ? `${input.project}'s own GitHub organisation.` : `On ${input.project}'s own domain.`);
  }
  // Documentation and repositories first; a plain page only when nothing better was found.
  const rank = { DOCUMENTATION_SITE: 0, GITHUB_REPOSITORY: 1, URL: 2 } as const;
  return out.sort((a, b) => rank[a.kind] - rank[b.kind]).slice(0, 4);
}

/** What the run read by the persona, as the compiler wants it. */
async function corpusOf(run: ResearchRunRow, handle: string | null, use: 'TEACHING' | 'TO_CONFIRM' = 'TEACHING'): Promise<FoundryCorpusItem[]> {
  if (!handle) return [];
  const evidence = await researchRepo.runEvidence(run.id, { author: handle, kinds: ['POST', 'REPLY', 'QUOTE'], limit: 2_000 });
  /*
    A voice is learned only from writing somebody can stand behind: grade A
    (read on X) or B (a whole mirror copy by the right author that a second
    source also saw). One mirror's unchecked word stays visible as evidence and
    teaches nothing; a copy by somebody else never reaches here, because the
    evidence is already filtered to the author.
  */
  const teaching =
    use === 'TO_CONFIRM'
      ? // Everything unchecked or disputed is worth reading on X: that is what settles it.
        evidence
      : evidence.filter((e) =>
          gradeTeachesVoice(
            gradeEvidence({
              families: e.families,
              disagreeing: e.disagreeingFamilies,
              bestTier: e.bestTier,
              bestCompleteness: e.completeness,
              confirmedOnPlatform: e.confirmedOnPlatform,
              author: e.author,
              expectedAuthor: handle,
            }).grade,
          ),
        );
  return teaching.map((e) => ({
    id: e.id,
    objectId: e.id,
    text: e.content,
    kind: e.kind === 'REPLY' ? 'reply' : e.kind === 'QUOTE' ? 'quote' : 'post',
    lang: e.language,
    createdAt: e.publishedAt,
    url: e.canonicalUrl,
    family: e.bestFamily,
    tier: e.bestTier,
    confirmed: e.confirmedOnPlatform,
  }));
}

/**
 * Advances a claimed run through every remaining stage, committing each.
 *
 * Returns when the run is READY, when a stage was refused because the lease
 * moved to somebody else, or when a stage failed in a way worth retrying later.
 */
export async function advanceFoundryRun(run: ResearchRunRow, deps: FoundryDeps): Promise<'READY' | 'LOST_LEASE' | 'DEFERRED' | 'FAILED'> {
  const brief = FoundryBrief.parse(run.brief);
  let current = run;
  const commit = async (stage: FoundryStage, detail: string, extra: { plan?: FoundryPlan; status?: 'READY' | 'FAILED' } = {}) => {
    const ok = await researchRepo.commitStage(current.id, deps.workerId, {
      stage,
      detail,
      ...(extra.plan ? { plan: extra.plan as unknown as Record<string, unknown> } : {}),
      ...(extra.status ? { status: extra.status } : {}),
      extendMs: deps.leaseMs,
    });
    if (ok) current = (await researchRepo.getRun(current.id))!;
    return ok;
  };

  for (let stage = nextStage(current); stage; stage = nextStage(current)) {
    const plan = planOf(current);
    const label = FOUNDRY_STAGE_LABELS[stage];
    try {
      if (stage === 'UNDERSTANDING') {
        const next: FoundryPlan = { ...plan, handle: brief.handle, projects: brief.projects };
        const what = [brief.handle ? `persona @${brief.handle}` : null, brief.projects.length ? `knowledge of ${brief.projects.join(', ')}` : null].filter(Boolean).join(' and ');
        if (!(await commit(stage, `${label}: ${what || 'nothing to research was named'}.`, { plan: next }))) return 'LOST_LEASE';
        continue;
      }

      if (stage === 'FINDING_SOURCES') {
        const profile = brief.handle ? await deps.resolveProfile(brief.handle).catch(() => null) : null;
        const discovered: DiscoveredSource[] = [];
        for (const project of brief.projects) {
          const results = [
            ...(await deps.search(`${project} documentation`).catch(() => [])),
            ...(await deps.search(`${project} github`).catch(() => [])),
          ];
          discovered.push(...classifyDiscovered({ project, results, ownerUrls: brief.urls, profileWebsite: profile?.website ?? null }));
        }
        // Owner-given addresses count even with no project named.
        if (brief.projects.length === 0 && brief.urls.length > 0) {
          discovered.push(...classifyDiscovered({ project: brief.handle ?? 'the project', results: [], ownerUrls: brief.urls, profileWebsite: null }));
        }
        const gaps = [...plan.gaps];
        if (brief.handle && !profile) gaps.push(`@${brief.handle} could not be looked up on X, so the persona is built from what else could be read.`);
        const detail = `${label}: ${profile ? `found @${profile.handle}` : brief.handle ? `could not look up @${brief.handle}` : 'no persona named'}; ${discovered.length} official source${discovered.length === 1 ? '' : 's'} for ${brief.projects.join(', ') || 'the addresses given'}.`;
        if (!(await commit(stage, detail, { plan: { ...plan, profile, discovered, gaps } }))) return 'LOST_LEASE';
        continue;
      }

      if (stage === 'READING_X' || stage === 'SECONDARY_SOURCES') {
        const sources =
          stage === 'READING_X'
            ? deps.platform
              ? [deps.platform]
              : []
            : [...(deps.searchIndex ? [deps.searchIndex] : []), ...(brief.useMirrors ? deps.mirrors : [])];
        let report: GatherReport = { families: [], observed: 0, newObjects: 0, requests: 0, incomplete: false, gaps: [] };
        if (plan.handle && sources.length > 0) {
          report = await gather({
            ownerId: current.ownerId,
            runId: current.id,
            request: { purpose: 'PERSONA', handle: plan.handle, limit: stage === 'READING_X' ? 400 : 150 },
            sources,
          });
        }
        // An account that cannot be read at all ends the run with that reason.
        // Building a persona from whatever else turned up would present
        // mirrors and search snippets as somebody's voice.
        const refused = report.families.find((f) => f.family === 'X' && f.fatal);
        if (stage === 'READING_X' && refused) {
          if (!(await commit(stage, `${label}: ${refused.fatal} Nothing was proposed.`, { status: 'FAILED' }))) return 'LOST_LEASE';
          return 'FAILED';
        }
        // The platform resting, or failing for the moment, is a reason to wait,
        // never a reason to build a persona without it. Bounded: a timeline X
        // will not show after several tries an hour apart is reported, not
        // waited on for ever.
        const resting = report.families.find((f) => f.family === 'X' && f.retryAfterMs);
        if (stage === 'READING_X' && resting) {
          if (current.attempts >= MAX_X_ATTEMPTS) {
            const said = `${label}: X would not show @${plan.handle}'s timeline after ${current.attempts} tries (${resting.detail}). Nothing was proposed.`;
            if (!(await commit(stage, said, { status: 'FAILED' }))) return 'LOST_LEASE';
            return 'FAILED';
          }
          await researchRepo.deferRun(current.id, deps.workerId, Math.max(60_000, resting.retryAfterMs!), `Waiting for X: ${resting.detail}`);
          return 'DEFERRED';
        }
        const coverage = [...plan.coverage, ...report.families.map((f) => ({ family: f.family, state: f.state, detail: f.detail, observed: f.observed }))];
        const gaps = [...plan.gaps, ...report.gaps];
        if (stage === 'READING_X' && !deps.platform && plan.handle) gaps.push('No X account is connected to read through, so the persona rests on secondary sources only.');
        const detail =
          stage === 'READING_X'
            ? `${label}: ${report.observed} post${report.observed === 1 ? '' : 's'} and replies read.`
            : `${label}: ${report.newObjects} more found${report.families.filter((f) => f.state !== 'AVAILABLE' && f.state !== 'DEGRADED').map((f) => `; ${f.label} unavailable`).join('')}.`;
        if (!(await commit(stage, detail, { plan: { ...plan, coverage, gaps } }))) return 'LOST_LEASE';
        continue;
      }

      if (stage === 'DEDUPLICATING') {
        const corpus = await corpusOf(current, plan.handle, 'TO_CONFIRM');
        const unconfirmed = corpus.filter((c) => !c.confirmed && c.url);
        let confirmed = 0;
        let missing = 0;
        for (const item of unconfirmed.slice(0, CONFIRM_LIMIT)) {
          const statusId = item.url!.match(/status\/(\d{10,25})/)?.[1];
          if (!statusId) continue;
          const reading = await deps.confirmPost(statusId).catch(() => null);
          if (reading) {
            await researchRepo.recordObservation(current.ownerId, current.id, reading);
            confirmed += 1;
          } else missing += 1;
        }
        const detail = `${label}: ${corpus.length} distinct posts; ${confirmed} copies found elsewhere confirmed on X${missing ? `, ${missing} not found there (kept as secondary evidence only)` : ''}.`;
        if (!(await commit(stage, detail))) return 'LOST_LEASE';
        continue;
      }

      if (stage === 'READY') {
        if (!(await commit(stage, 'Ready for review.', { status: 'READY' }))) return 'LOST_LEASE';
        return 'READY';
      }

      // VOICE through TESTS: compile once, write this stage's sections.
      if (!current.agentId) throw new Error('This run is not attached to an agent.');
      const corpus = await corpusOf(current, plan.handle);
      const agent = await currentAgent(current.agentId);
      const analysis = analyseCorpus(corpus);
      const items = compileFoundry(
        { brief, profile: plan.profile ? { handle: plan.profile.handle, displayName: plan.profile.displayName, bio: plan.profile.bio } : null, corpus, discovered: plan.discovered, current: agent, mode: current.kind === 'FOUNDRY_IMPROVE' ? 'IMPROVE' : 'SETUP' },
        analysis,
      );
      const sections = WRITES[stage] ?? [];
      const mine = items.filter((item) => sections.includes(item.section));
      for (const item of mine) await foundryRepo.upsertItem(current.id, item);
      const detail =
        stage === 'VOICE'
          ? `${label}: ${analysis.voice.statements.length} measurements from ${corpus.length} items.`
          : stage === 'TOPICS'
            ? `${label}: ${analysis.core.map((t) => t.label).slice(0, 6).join(', ') || 'no clear subjects yet'}.`
            : stage === 'BELIEFS'
              ? `${label}: ${analysis.beliefs.length} position${analysis.beliefs.length === 1 ? '' : 's'} with enough evidence to propose.`
              : `${label}: ${mine.length} item${mine.length === 1 ? '' : 's'}.`;
      if (!(await commit(stage, detail))) return 'LOST_LEASE';
    } catch (error) {
      const message = errorMessage(error);
      log.warn('a Foundry stage failed', { runId: current.id, stage, message });
      if (current.attempts >= 4) {
        await researchRepo.commitStage(current.id, deps.workerId, { stage, detail: `${label} failed: ${message}`, status: 'FAILED', lastError: message });
        return 'FAILED';
      }
      await researchRepo.deferRun(current.id, deps.workerId, 60_000 * current.attempts, `${label} failed: ${message}`);
      return 'DEFERRED';
    }
  }
  return 'READY';
}
