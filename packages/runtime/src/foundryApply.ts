/**
 * Agent Foundry, the two ends that touch real settings: reading what an agent
 * is set to now, and applying what the owner accepted.
 *
 * Applying writes through the repositories the Advanced screens use. Persona
 * fields become one new persona version and policy fields one new policy
 * version, so an application is one step on each setting's history and can be
 * rolled back the way any other change can. Beliefs go through the stance
 * store, which supersedes rather than overwrites. Knowledge sources are
 * created and queued for the worker. Nothing is deleted.
 */
import {
  DEFAULT_POLICY,
  PersonaDraft,
  PolicyConfig,
  type FoundryEvidence,
  type RadarSourceKind,
  type StancePosition,
} from '@xbam/shared/contracts';
import { NotFoundError } from '@xbam/shared';
import {
  accounts as accountsRepo,
  agents as agentsRepo,
  foundry as foundryRepo,
  knowledge as knowledgeRepo,
  ops,
  personaSources,
  radar as radarRepo,
  research as researchRepo,
  stances as stancesRepo,
  type FoundryItemRow,
} from '@xbam/database';
import { syncPersonaSource } from '@xbam/persona';
import type { CurrentAgent } from './foundry';
import { setToolpack, toolpackViews } from './toolpackViews';

/** The account an agent reads and acts through, when it has one. */
export async function primaryAccountOf(agentId: string): Promise<string | null> {
  const links = await accountsRepo.listAgentAccounts(agentId);
  return links.find((l) => l.enabled)?.accountId ?? links[0]?.accountId ?? null;
}

/** What an agent is set to right now, in the shape the compiler compares against. */
export async function currentAgent(agentId: string): Promise<CurrentAgent> {
  const agent = await agentsRepo.requireAgent(agentId);
  const [persona, policy, stances, knowledge, sources, accountId] = await Promise.all([
    agentsRepo.getActivePersona(agentId),
    agentsRepo.getActivePolicy(agentId),
    stancesRepo.listActive(agentId, 100),
    knowledgeRepo.listSources(agentId),
    personaSources.listSources(agentId),
    primaryAccountOf(agentId),
  ]);
  const radar = accountId ? await radarRepo.listSources(accountId) : [];
  const packs = await toolpackViews({ agentId, accountId, paused: false }).catch(() => ({ packs: [] }));
  return {
    name: agent.name,
    persona: persona ? PersonaDraft.parse(persona) : null,
    policy: policy ? PolicyConfig.parse(policy.config) : null,
    stances: stances.map((s) => ({ id: s.id, subject: s.subject, position: s.position as StancePosition, summary: s.summary, pinned: Boolean(s.pinned) })),
    knowledge: knowledge.map((k) => ({
      name: k.name,
      kind: k.kind,
      location: k.location,
      generation: (k.labels?.generation as string | undefined) ?? null,
      lastError: k.lastError,
      indexedAt: k.indexedAt,
    })),
    personaSources: sources.map((s) => ({ kind: s.kind, handle: s.handle })),
    radar: radar.map((r) => ({ kind: r.kind, target: r.target, enabled: r.enabled })),
    toolpacks: packs.packs.map((p) => ({ id: p.id, on: p.state === 'ON' })),
  };
}

export interface FoundryApplyReport {
  runId: string;
  agentId: string;
  applied: { section: string; title: string; detail: string }[];
  skipped: { section: string; title: string; reason: string }[];
  rejected: number;
  personaVersion: number | null;
  policyVersion: number | null;
}

/** The value an item applies with: the owner's edit when there is one. */
const valueOf = (item: FoundryItemRow): unknown => (item.status === 'EDITED' ? item.ownerValue : item.proposedValue);
const record = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

/**
 * Applies what the owner accepted in a Foundry run.
 *
 * Idempotent over items: an item applies once and is then APPLIED, so pressing
 * apply twice changes nothing the second time.
 */
export async function applyFoundry(input: { runId: string; userId: string }): Promise<FoundryApplyReport> {
  const run = await researchRepo.getRun(input.runId);
  if (!run || !run.agentId) throw new NotFoundError('That Foundry run');
  const agentId = run.agentId;
  const items = await foundryRepo.listItems(run.id);
  const chosen = items.filter((i) => i.status === 'ACCEPTED' || i.status === 'EDITED');
  const report: FoundryApplyReport = {
    runId: run.id,
    agentId,
    applied: [],
    skipped: [],
    rejected: items.filter((i) => i.status === 'REJECTED').length,
    personaVersion: null,
    policyVersion: null,
  };
  const done: string[] = [];
  const ok = (item: FoundryItemRow, detail: string) => {
    report.applied.push({ section: item.section, title: item.title, detail });
    done.push(item.id);
  };
  const skip = (item: FoundryItemRow, reason: string) => report.skipped.push({ section: item.section, title: item.title, reason });

  // ── Persona: one new version for every persona field accepted ──
  const personaFields = chosen.filter((i) => ['IDENTITY', 'STYLE', 'MUST_NEVER', 'INSTRUCTIONS', 'TOPICS', 'LANGUAGE'].includes(i.section));
  if (personaFields.length > 0) {
    const active = await agentsRepo.getActivePersona(agentId);
    const agent = await agentsRepo.requireAgent(agentId);
    const draft: Record<string, unknown> = active ? { ...PersonaDraft.parse(active) } : { displayName: agent.name };
    for (const item of personaFields) {
      if (item.itemKey === 'unsupported-topics' || item.itemKey.startsWith('unsupported:')) {
        // Accepting "no evidence for this topic" means keep it; there is nothing to write.
        ok(item, 'Kept as it was.');
        continue;
      }
      draft[item.itemKey] = valueOf(item);
      ok(item, 'In the new persona version.');
    }
    draft.changeNote = `Agent Foundry: ${personaFields.length} change${personaFields.length === 1 ? '' : 's'} accepted from a research run.`;
    const saved = await agentsRepo.savePersonaVersion(agentId, PersonaDraft.parse(draft), input.userId);
    report.personaVersion = saved.version;
  }

  // ── Policy: one new version for autonomy and learning ──
  const policyFields = chosen.filter((i) => i.section === 'AUTONOMY' || i.section === 'LEARNING');
  if (policyFields.length > 0) {
    const active = await agentsRepo.getActivePolicy(agentId);
    const config = PolicyConfig.parse(active?.config ?? DEFAULT_POLICY);
    for (const item of policyFields) {
      const v = record(valueOf(item));
      if (item.itemKey === 'automation') {
        config.automation.mode = (v.mode as typeof config.automation.mode) ?? config.automation.mode;
        if (typeof v.dryRun === 'boolean') config.automation.dryRunDefault = v.dryRun;
      } else if (item.itemKey === 'engagement') {
        Object.assign(config.engagement, v);
      } else if (item.itemKey === 'outreach') {
        Object.assign(config.outreach, v);
      } else if (item.itemKey === 'learning') {
        config.learning.enabled = v.enabled !== false;
      }
      ok(item, 'In the new policy version.');
    }
    const saved = await agentsRepo.savePolicyVersion(agentId, PolicyConfig.parse(config), 'Agent Foundry', input.userId);
    report.policyVersion = saved.version;
  }

  // ── Beliefs ──
  for (const item of chosen.filter((i) => i.section === 'BELIEFS')) {
    const v = record(valueOf(item));
    if (Array.isArray(v.retire)) {
      // Retired, not deleted: "what did it used to think" is a fair question.
      const ids = (v.retire as { id?: string }[]).map((r) => r.id).filter((id): id is string => typeof id === 'string');
      for (const id of ids) {
        const stance = await stancesRepo.get(id);
        if (stance && stance.agentId === agentId && !stance.pinned) await stancesRepo.update(id, { status: 'RETIRED' });
      }
      ok(item, `Retired ${ids.length}.`);
      continue;
    }
    if (typeof v.subject !== 'string' || typeof v.position !== 'string') {
      skip(item, 'It no longer says what the belief is.');
      continue;
    }
    const evidence = (item.evidence ?? []) as FoundryEvidence[];
    const stance = await stancesRepo.assert({
      agentId,
      subject: v.subject,
      position: v.position as StancePosition,
      summary: String(v.summary ?? item.title),
      confidence: item.confidence,
      pinned: v.pinned === true,
      ...(evidence[0] ? { evidence: { kind: 'imported', excerpt: evidence[0].excerpt, remoteUrl: evidence[0].url } } : {}),
    });
    for (const more of evidence.slice(1, 6)) {
      await stancesRepo.addEvidence(stance.id, { kind: 'imported', excerpt: more.excerpt, remoteUrl: more.url });
    }
    ok(item, `${v.pinned === true ? 'Pinned' : 'Held'} with ${Math.min(6, evidence.length)} cited post${evidence.length === 1 ? '' : 's'}.`);
  }

  // ── Knowledge ──
  const haveKnowledge = await knowledgeRepo.listSources(agentId);
  for (const item of chosen.filter((i) => i.section === 'KNOWLEDGE')) {
    const v = record(valueOf(item));
    if (v.gap) {
      ok(item, 'Noted. Add a source for it on the Knowledge screen.');
      continue;
    }
    const location = String(v.location ?? '');
    const kind = String(v.kind ?? '');
    if (!location || !['DOCUMENTATION_SITE', 'GITHUB_REPOSITORY', 'URL'].includes(kind)) {
      skip(item, 'It does not say what to read.');
      continue;
    }
    if (haveKnowledge.some((k) => (k.location ?? '').toLowerCase() === location.toLowerCase())) {
      ok(item, 'Already attached.');
      continue;
    }
    let name = String(v.name ?? location).slice(0, 120);
    if (haveKnowledge.some((k) => k.name.toLowerCase() === name.toLowerCase())) name = `${name} (${haveKnowledge.length + 1})`.slice(0, 120);
    const created = await knowledgeRepo.createSource({
      agentId,
      name,
      kind: kind as 'DOCUMENTATION_SITE' | 'GITHUB_REPOSITORY' | 'URL',
      location,
      refreshIntervalMinutes: typeof v.refreshIntervalMinutes === 'number' ? v.refreshIntervalMinutes : null,
      labels: record(v.labels) as never,
    });
    // Read by the worker on its next pass; the Knowledge screen shows it.
    await knowledgeRepo.updateSource(created.id, { nextRefreshAt: new Date().toISOString() });
    haveKnowledge.push(created);
    ok(item, 'Attached and queued to be read.');
  }

  // ── Persona sources: keep the writing that was read, on record ──
  for (const item of chosen.filter((i) => i.section === 'PERSONA_SOURCES')) {
    const v = record(valueOf(item));
    const handle = typeof v.handle === 'string' ? v.handle : null;
    if (!handle) {
      skip(item, 'No account named.');
      continue;
    }
    const source = await personaSources.upsertSource({ agentId, kind: 'x_public', handle, label: `@${handle}` });
    // The posts this run already read, so the source starts with them rather
    // than asking X for the same pages again.
    const evidence = await researchRepo.runEvidence(run.id, { author: handle, kinds: ['POST', 'REPLY', 'QUOTE'], limit: 1_000 });
    const confirmed = evidence.filter((e) => e.confirmedOnPlatform);
    if (confirmed.length > 0) {
      await syncPersonaSource({
        sourceId: source.id,
        items: confirmed.map((e) => ({
          remoteId: e.externalId ?? e.objectKey,
          text: e.content,
          url: e.canonicalUrl,
          itemKind: e.kind === 'REPLY' ? ('reply' as const) : e.kind === 'QUOTE' ? ('quote' as const) : ('post' as const),
          createdAt: e.publishedAt,
          raw: { researchObjectId: e.id, families: e.families },
        })),
      }).catch(() => undefined);
    }
    ok(item, `Kept, with ${confirmed.length} post${confirmed.length === 1 ? '' : 's'} confirmed on X.`);
  }

  // ── Radar ──
  const accountId = await primaryAccountOf(agentId);
  for (const item of chosen.filter((i) => i.section === 'RADAR')) {
    if (!accountId) {
      skip(item, 'This agent has no X account connected yet. Connect one, then run Improve to add it.');
      continue;
    }
    const v = record(valueOf(item));
    await radarRepo.upsertSource({
      accountId,
      kind: v.kind as RadarSourceKind,
      target: typeof v.target === 'string' ? v.target : null,
      enabled: v.enabled !== false,
      label: 'Agent Foundry',
    });
    ok(item, v.enabled === false ? 'Added, switched off.' : 'On.');
  }

  // ── Capabilities ──
  for (const item of chosen.filter((i) => i.section === 'CAPABILITIES')) {
    const v = record(valueOf(item));
    try {
      await setToolpack({ agentId, packId: String(v.id), on: v.on !== false });
      ok(item, 'On, at each capability\'s own default: reads allowed, anything that acts still asks.');
    } catch (error) {
      skip(item, (error as Error).message);
    }
  }

  // ── Tests: they stay on the run, where "Test this agent" reads them ──
  for (const item of chosen.filter((i) => i.section === 'TESTS')) ok(item, 'In this agent\'s test suite.');

  await foundryRepo.markApplied(done);
  await foundryRepo.recordApplication({
    runId: run.id,
    agentId,
    appliedBy: input.userId,
    accepted: done.length,
    rejected: report.rejected,
    report: report as unknown as Record<string, unknown>,
  });
  await ops.audit({
    actorUserId: input.userId,
    action: 'agent.foundry.applied',
    entityType: 'agent',
    entityId: agentId,
    data: {
      runId: run.id,
      applied: done.length,
      skipped: report.skipped.length,
      rejected: report.rejected,
      personaVersion: report.personaVersion,
      policyVersion: report.policyVersion,
    },
  });
  return report;
}
