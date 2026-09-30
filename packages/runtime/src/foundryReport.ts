/**
 * What a Foundry run found and what came of it, as the owner reads it.
 *
 * Concrete counts and sentences, never a score. "Readiness 87" says nothing a
 * person can act on; "no official source was found for Pons" does.
 */
import {
  FOUNDRY_SECTION_LABELS,
  FOUNDRY_STAGE_LABELS,
  FOUNDRY_STAGES,
  type FoundrySection,
  type FoundryStage,
} from '@xbam/shared/contracts';
import { foundry as foundryRepo, research as researchRepo, workers as workersRepo, STANDARD_WORK } from '@xbam/database';

export interface FoundryRunView {
  id: string;
  agentId: string | null;
  kind: string;
  status: string;
  brief: Record<string, unknown>;
  /** Why a queued run has not started, when something is holding it. */
  waitingFor: string | null;
  stages: { stage: FoundryStage; label: string; state: 'DONE' | 'RUNNING' | 'WAITING'; detail: string | null; at: string | null }[];
  lastError: string | null;
  createdAt: string;
  finishedAt: string | null;
}

/** The run as a list of stages, each done, running or waiting, with what it said. */
/**
 * Why a queued run has not started, in a sentence, or null when nothing is
 * holding it. A run waiting for memory to clear or for a browser worker to
 * exist is not broken, and an owner told only "queued" cannot tell which.
 */
async function waitingFor(): Promise<string | null> {
  if (!(await workersRepo.browserWorkerPresent().catch(() => true))) {
    return 'No worker with a browser is running, and research reads X through one. Start AI17Z on the machine with Chrome and it begins.';
  }
  const tools = await workersRepo.toolAvailability().catch(() => ({}) as Record<string, { available: boolean; detail: string }>);
  const standard = tools[STANDARD_WORK];
  if (standard && !standard.available) return `${standard.detail} Research starts then; nothing is lost by waiting.`;
  return null;
}

export async function foundryRunView(runId: string): Promise<FoundryRunView | null> {
  const run = await researchRepo.getRun(runId);
  if (!run) return null;
  const log = new Map(run.stageLog.map((e) => [e.stage, e]));
  const firstUndone = FOUNDRY_STAGES.find((s) => !log.has(s));
  return {
    id: run.id,
    agentId: run.agentId,
    kind: run.kind,
    status: run.status,
    brief: run.brief,
    stages: FOUNDRY_STAGES.map((stage) => {
      const entry = log.get(stage);
      return {
        stage,
        label: FOUNDRY_STAGE_LABELS[stage],
        // Only a claimed run is doing a stage. A queued one is waiting for a
        // worker, and saying "Understanding the request" would claim work that
        // has not started.
        state: entry ? 'DONE' : stage === firstUndone && run.status === 'RUNNING' ? 'RUNNING' : 'WAITING',
        detail: entry?.detail ?? null,
        at: entry?.at ?? null,
      };
    }),
    lastError: run.lastError,
    waitingFor: run.status === 'QUEUED' ? await waitingFor() : null,
    createdAt: run.createdAt,
    finishedAt: run.finishedAt,
  };
}

export interface FoundryReport {
  sources: { family: string; state: string; detail: string; observed: number }[];
  corpus: { total: number; posts: number; replies: number; quotes: number; confirmed: number; from: string | null; to: string | null };
  sections: { section: FoundrySection; label: string; proposed: number; accepted: number; edited: number; rejected: number; applied: number }[];
  topics: string[];
  beliefs: string[];
  knowledge: string[];
  radar: string[];
  capabilities: string[];
  autonomy: string | null;
  tests: number;
  /** What research could not settle, in sentences. */
  uncertainty: string[];
  applied: { at: string; accepted: number; rejected: number }[];
}

/** The setup report: sources, coverage, what was accepted, and what remains uncertain. */
export async function foundryReport(runId: string): Promise<FoundryReport | null> {
  const run = await researchRepo.getRun(runId);
  if (!run) return null;
  const plan = run.plan as { handle?: string | null; coverage?: FoundryReport['sources']; gaps?: string[] };
  const items = await foundryRepo.listItems(run.id);
  const evidence = plan.handle ? await researchRepo.runEvidence(run.id, { author: plan.handle, kinds: ['POST', 'REPLY', 'QUOTE'], limit: 5_000 }) : [];
  const dates = evidence.map((e) => e.publishedAt).filter((d): d is string => Boolean(d)).sort();
  const taken = (i: (typeof items)[number]) => i.status === 'ACCEPTED' || i.status === 'EDITED' || i.status === 'APPLIED';
  const value = (i: (typeof items)[number]) => (i.status === 'EDITED' ? i.ownerValue : i.proposedValue) as Record<string, unknown> | string | string[];

  const sections = (Object.keys(FOUNDRY_SECTION_LABELS) as FoundrySection[])
    .map((section) => {
      const mine = items.filter((i) => i.section === section);
      return {
        section,
        label: FOUNDRY_SECTION_LABELS[section],
        proposed: mine.length,
        accepted: mine.filter((i) => i.status === 'ACCEPTED').length,
        edited: mine.filter((i) => i.status === 'EDITED').length,
        rejected: mine.filter((i) => i.status === 'REJECTED').length,
        applied: mine.filter((i) => i.status === 'APPLIED').length,
      };
    })
    .filter((s) => s.proposed > 0);

  const topicsItem = items.find((i) => i.itemKey === 'topics' && taken(i));
  const uncertainty = [...(plan.gaps ?? [])];
  if (evidence.length > 0 && evidence.length < 40) uncertainty.push(`Only ${evidence.length} posts could be read, so the voice rests on a small sample.`);
  for (const item of items.filter((i) => i.confidence < 0.5 && i.status === 'PROPOSED')) uncertainty.push(`${item.title}: ${item.rationale}`);
  for (const gap of items.filter((i) => i.itemKey.startsWith('knowledge-gap:'))) uncertainty.push(gap.title);

  const applications = await foundryRepo.applicationsFor(run.id);
  const autonomy = items.find((i) => i.itemKey === 'automation' && taken(i));
  return {
    sources: plan.coverage ?? [],
    corpus: {
      total: evidence.length,
      posts: evidence.filter((e) => e.kind === 'POST').length,
      replies: evidence.filter((e) => e.kind === 'REPLY').length,
      quotes: evidence.filter((e) => e.kind === 'QUOTE').length,
      confirmed: evidence.filter((e) => e.confirmedOnPlatform).length,
      from: dates[0] ?? null,
      to: dates.at(-1) ?? null,
    },
    sections,
    topics: topicsItem ? (value(topicsItem) as string[]) : [],
    beliefs: items.filter((i) => i.section === 'BELIEFS' && taken(i)).map((i) => i.title),
    knowledge: items.filter((i) => i.section === 'KNOWLEDGE' && taken(i)).map((i) => i.title),
    radar: items.filter((i) => i.section === 'RADAR' && taken(i)).map((i) => i.title),
    capabilities: items.filter((i) => i.section === 'CAPABILITIES' && taken(i)).map((i) => i.title),
    autonomy: autonomy ? autonomy.title : null,
    tests: items.filter((i) => i.section === 'TESTS' && taken(i)).length,
    uncertainty: [...new Set(uncertainty)].slice(0, 20),
    applied: applications.map((a) => ({ at: a.createdAt, accepted: a.accepted, rejected: a.rejected })),
  };
}
