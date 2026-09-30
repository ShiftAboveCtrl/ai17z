/**
 * Is this agent set up well, and if not, what exactly to change and where.
 *
 * Concrete checks, never a score. "Setup 73%" tells an owner nothing and
 * invites tuning the number; "Persona source @x has not refreshed in 21 days"
 * with a link to it tells them what to do. Every check is one sentence, one
 * of four states, and the address of the setting that fixes it.
 *
 * Not configured is not broken. An agent with no goals or no Radar source is
 * an agent that has not been given one, and it is shown in its own quiet
 * state so a new agent's page is not a wall of red.
 *
 * Read only, and built from what already answers each question: diagnostics,
 * the knowledge freshness rule, the learner's own view, the repetition check
 * the generator already runs. No second health system.
 */
import {
  accounts as accountsRepo,
  agents as agentsRepo,
  deliberation as deliberationRepo,
  introspection,
  knowledge as knowledgeRepo,
  personaSources as personaSourcesRepo,
  relationships as relationshipsRepo,
  stances as stancesRepo,
  testSuites,
  voice as voiceRepo,
} from '@xbam/database';
import { knowledgeFreshness, type PolicyConfig } from '@xbam/shared/contracts';
import { habitualPhrases } from '@xbam/persona';
import { collectDiagnostics } from '@xbam/tools';
import { describeLearning } from './learning';
import { testSuiteView } from './testSuite';

export const SETUP_CHECK_STATES = ['OK', 'ATTENTION', 'PROBLEM', 'NOT_SET_UP'] as const;
export type SetupCheckState = (typeof SETUP_CHECK_STATES)[number];

export interface SetupCheck {
  key: string;
  state: SetupCheckState;
  sentence: string;
  fix: { label: string; href: string } | null;
}

export interface SetupSection {
  key: string;
  label: string;
  checks: SetupCheck[];
}

export interface SetupReport {
  agentId: string;
  checkedAt: string;
  counts: Record<SetupCheckState, number>;
  sections: SetupSection[];
}

const DAY_MS = 86_400_000;
/** Past this a persona source is describing somebody who may have moved on. */
export const PERSONA_STALE_DAYS = 21;
/** Fewer examples than this and a model is working from adjectives. */
const FEW_EXAMPLES = 5;

/** Where each setting lives, so a check never says "go and find it". */
export function settingHref(agentId: string, where: string, accountId?: string | null): string {
  const agent = `/agents/${agentId}`;
  switch (where) {
    case 'radar':
      return accountId ? `/settings?account=${accountId}&focus=radar` : '/settings#accounts';
    case 'accounts':
      return accountId ? `/settings?account=${accountId}` : `${agent}#accounts`;
    case 'browser':
      return accountId ? `/settings?account=${accountId}&focus=browser` : '/settings#browser';
    case 'providers':
      return '/settings#providers';
    case 'plugins':
      return '/plugins';
    case 'foundry':
      return `${agent}/foundry`;
    case 'activity':
      return '/activity';
    default:
      return `${agent}#${where}`;
  }
}

const fix = (label: string, href: string) => ({ label, href });

/** Words that name no particular subject, so cannot say whether one is covered. */
const GENERIC_TOPIC_WORDS = new Set([
  'agent', 'agents', 'open', 'source', 'community', 'crypto', 'market', 'markets', 'people', 'news', 'things',
  'building', 'build', 'tech', 'technology', 'life', 'work', 'launch', 'launches', 'token', 'tokens', 'chain',
]);

/**
 * Whether a topic the agent talks about is named anywhere in what it can read.
 *
 * By its distinctive words: "Pons launchpad" is covered by a source called
 * PONS. A topic made only of generic words ("open source") names nothing to
 * look for, so it is never reported as missing a source.
 */
export function topicCovered(topic: string, sources: { name: string; location: string | null; labels?: unknown }[]): boolean {
  const words = topic
    .toLowerCase()
    .replace(/^[$#]/, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !GENERIC_TOPIC_WORDS.has(w));
  if (words.length === 0) return true;
  const haystack = sources.map((s) => [s.name, s.location ?? '', JSON.stringify(s.labels ?? {})].join(' ').toLowerCase()).join(' ');
  return words.some((w) => haystack.includes(w));
}

/**
 * Work that stopped because it should have: a block the owner set, the
 * agent's own post, a post that was deleted. Reported, never as a fault.
 */
const STOPPED_ON_PURPOSE = /blocked for this agent|belongs to this agent|no longer exists|deleted or is not visible|do not contact/i;

/** Recent failed work, sorted into what is broken, what waits for the owner, and what stopped as it should. */
export function sortFailures<T extends { status: string; lastError: string | null; lastAt: string }>(failures: T[]): { real: T[]; held: T[]; onPurpose: T[] } {
  const held = failures.filter((f) => f.status === 'REVIEW_REQUIRED');
  const onPurpose = failures.filter((f) => f.status !== 'REVIEW_REQUIRED' && STOPPED_ON_PURPOSE.test(f.lastError ?? ''));
  const real = failures
    .filter((f) => !held.includes(f) && !onPurpose.includes(f))
    .sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)));
  return { real, held, onPurpose };
}

export async function agentSetupCheck(agentId: string, now = Date.now()): Promise<SetupReport> {
  const agent = await agentsRepo.requireAgent(agentId);
  const [persona, policyRow, links, personaSources, knowledge, stances, goals, people, wake, learning, diagnostics, failures, recent, suites] =
    await Promise.all([
      agentsRepo.getActivePersona(agentId),
      agentsRepo.getActivePolicy(agentId),
      accountsRepo.listAgentAccounts(agentId),
      personaSourcesRepo.listSources(agentId),
      knowledgeRepo.listSources(agentId),
      stancesRepo.listActive(agentId, 200),
      deliberationRepo.listGoals(agentId, { status: 'ACTIVE', limit: 50 }),
      relationshipsRepo.counts(agentId),
      deliberationRepo.getWake(agentId),
      describeLearning(agentId).catch(() => null),
      collectDiagnostics(agentId).catch(() => null),
      introspection.jobFailures(agentId, new Date(now - 7 * DAY_MS).toISOString()).catch(() => []),
      voiceRepo.recentOutput(agentId, 40, 21).catch(() => []),
      testSuites.listSuites(agentId, 1).catch(() => []),
    ]);
  const policy = (policyRow?.config ?? null) as PolicyConfig | null;
  const accountId = links[0]?.accountId ?? null;
  const href = (where: string) => settingHref(agentId, where, accountId);
  const sections: SetupSection[] = [];

  // ── Identity ──
  {
    const checks: SetupCheck[] = [];
    if (!persona) {
      checks.push({ key: 'persona', state: 'PROBLEM', sentence: 'It has no persona, so there is nobody to be.', fix: fix('Write one', href('identity')) });
    } else {
      checks.push(
        persona.biography.trim()
          ? { key: 'biography', state: 'OK', sentence: 'It has a background written for it.', fix: null }
          : { key: 'biography', state: 'ATTENTION', sentence: 'It has no background, so it has nothing to say about who it is.', fix: fix('Add one', href('identity')) },
      );
      const examples = persona.styleExamples.length;
      checks.push(
        examples >= FEW_EXAMPLES
          ? { key: 'examples', state: 'OK', sentence: `${examples} examples of how it sounds.`, fix: null }
          : {
              key: 'examples',
              state: 'ATTENTION',
              sentence: `Only ${examples} example${examples === 1 ? '' : 's'} of how it sounds. A model imitates examples and only approximates adjectives.`,
              fix: fix('Add examples', href('voice')),
            },
      );
    }
    if (policy) {
      checks.push(
        policy.identity.mayDenyBeingAI
          ? { key: 'ai', state: 'ATTENTION', sentence: 'It is allowed to deny being an AI. That is your setting, and it is not the default.', fix: fix('Review', href('policies')) }
          : { key: 'ai', state: 'OK', sentence: 'It will not claim to be human.', fix: null },
      );
    }
    sections.push({ key: 'identity', label: 'Identity', checks });
  }

  // ── Persona evidence ──
  {
    const checks: SetupCheck[] = [];
    if (personaSources.length === 0) {
      checks.push({
        key: 'none',
        state: 'NOT_SET_UP',
        sentence: 'No persona source. Its voice comes only from what was typed into its persona.',
        fix: fix('Add one', href('identity')),
      });
    }
    for (const source of personaSources) {
      const name = source.handle ? `@${source.handle}` : source.label;
      const days = source.lastSyncedAt ? Math.floor((now - Date.parse(source.lastSyncedAt)) / DAY_MS) : null;
      if (source.status === 'ERROR' || source.status === 'UNAVAILABLE') {
        checks.push({ key: `source-${source.id}`, state: 'PROBLEM', sentence: `Persona source ${name} could not be read: ${source.lastError ?? source.status.toLowerCase()}.`, fix: fix('Open it', href('identity')) });
      } else if (days === null) {
        checks.push({ key: `source-${source.id}`, state: 'ATTENTION', sentence: `Persona source ${name} has never been read.`, fix: fix('Read it now', href('identity')) });
      } else if (days >= PERSONA_STALE_DAYS) {
        checks.push({ key: `source-${source.id}`, state: 'ATTENTION', sentence: `Persona source ${name} has not refreshed in ${days} days.`, fix: fix('Refresh it', href('identity')) });
      } else {
        checks.push({ key: `source-${source.id}`, state: 'OK', sentence: `Persona source ${name} was read ${days === 0 ? 'today' : `${days} day${days === 1 ? '' : 's'} ago`}.`, fix: null });
      }
    }
    sections.push({ key: 'persona', label: 'Persona evidence', checks });
  }

  // ── Knowledge ──
  {
    const checks: SetupCheck[] = [];
    const enabled = knowledge.filter((s) => s.enabled);
    if (enabled.length === 0) {
      checks.push({ key: 'none', state: 'NOT_SET_UP', sentence: 'No knowledge sources. It answers factual questions from the model alone.', fix: fix('Add one', href('knowledge')) });
    } else {
      const failed = enabled.filter((s) => {
        const state = knowledgeFreshness(s as never, now);
        return state === 'FAILED' || state === 'UNAVAILABLE';
      });
      checks.push(
        failed.length > 0
          ? {
              key: 'failed',
              state: 'PROBLEM',
              sentence: `${failed.length} knowledge source${failed.length === 1 ? '' : 's'} failed ${failed.length === 1 ? 'its' : 'their'} last read: ${failed.map((s) => s.name).join(', ')}.`,
              fix: fix('See which', href('knowledge')),
            }
          : { key: 'failed', state: 'OK', sentence: `${enabled.length} knowledge source${enabled.length === 1 ? '' : 's'}, all read.`, fix: null },
      );
    }
    // What it keeps talking about, with nothing official to read on it.
    const uncovered = (persona?.topics ?? []).slice(0, 5).filter((topic) => !topicCovered(topic, knowledge));
    if (persona && uncovered.length > 0) {
      checks.push({
        key: 'uncovered',
        state: 'ATTENTION',
        sentence: `It talks about ${uncovered.slice(0, 3).join(', ')} but has no knowledge source that names ${uncovered.length === 1 ? 'it' : 'them'}.`,
        fix: fix('Add a source', href('knowledge')),
      });
    }
    sections.push({ key: 'knowledge', label: 'Knowledge', checks });
  }

  // ── Beliefs, goals, people ──
  {
    const checks: SetupCheck[] = [];
    if (stances.length === 0) {
      checks.push({ key: 'none', state: 'NOT_SET_UP', sentence: 'No beliefs recorded yet. It forms them from what it publishes.', fix: fix('Add one', href('beliefs')) });
    } else {
      const counts = await Promise.all(stances.filter((s) => !s.pinned).map((s) => stancesRepo.countEvidence(s.id).catch(() => 1)));
      const bare = counts.filter((n) => n === 0).length;
      checks.push(
        bare > 0
          ? { key: 'evidence', state: 'ATTENTION', sentence: `${bare} of ${stances.length} beliefs have no recorded evidence and were not set by you.`, fix: fix('Review them', href('beliefs')) }
          : { key: 'evidence', state: 'OK', sentence: `${stances.length} beliefs, each set by you or backed by evidence.`, fix: null },
      );
    }
    sections.push({ key: 'beliefs', label: 'Beliefs', checks });
    sections.push({
      key: 'goals',
      label: 'Goals',
      checks: [
        goals.length === 0
          ? { key: 'none', state: 'NOT_SET_UP', sentence: 'No goals. It still answers people; it just is not working towards anything of its own.', fix: fix('Set one', href('autonomy')) }
          : { key: 'active', state: 'OK', sentence: `${goals.length} active goal${goals.length === 1 ? '' : 's'}.`, fix: null },
      ],
    });
    const known = Object.values(people).reduce((a, b) => a + b, 0);
    sections.push({
      key: 'relationships',
      label: 'Relationships',
      checks: [
        known === 0
          ? { key: 'none', state: 'NOT_SET_UP', sentence: 'It has not spoken with anybody yet.', fix: null }
          : { key: 'known', state: 'OK', sentence: `It knows ${known} ${known === 1 ? 'person' : 'people'}, ${people.REGULAR ?? 0} of them regulars.`, fix: fix('See them', href('relationships')) },
      ],
    });
  }

  // ── X account, Radar, browser ──
  {
    const x: SetupCheck[] = [];
    if (links.length === 0) {
      x.push({ key: 'none', state: 'NOT_SET_UP', sentence: 'No account is connected, so it cannot read or post anywhere.', fix: fix('Connect one', href('accounts')) });
    } else {
      for (const link of links) {
        const name = link.handle ? `@${link.handle}` : link.channel;
        x.push(
          link.status === 'CONNECTED'
            ? { key: link.accountId, state: 'OK', sentence: `${name} is connected.`, fix: null }
            : { key: link.accountId, state: 'PROBLEM', sentence: `${name} is ${link.status.toLowerCase().replace(/_/g, ' ')}.`, fix: fix('Open the session', settingHref(agentId, 'accounts', link.accountId)) },
        );
      }
    }
    sections.push({ key: 'account', label: 'X account', checks: x });

    const radar: SetupCheck[] = [];
    const parts = diagnostics?.radar ?? [];
    if (links.length > 0 && (parts.length === 0 || parts.every((p) => p.state === 'OFF'))) {
      radar.push({ key: 'none', state: 'NOT_SET_UP', sentence: 'No Social Radar source is running, so it only sees what is sent to it.', fix: fix('Open Social Radar', href('radar')) });
    }
    const bad = parts.filter((p) => p.state === 'FAILING' || p.state === 'DEGRADED');
    for (const part of bad) {
      radar.push({ key: part.name, state: part.state === 'FAILING' ? 'PROBLEM' : 'ATTENTION', sentence: `${part.name}: ${part.detail}`, fix: fix('Open Social Radar', href('radar')) });
    }
    const running = parts.filter((p) => p.state === 'HEALTHY').length;
    if (running > 0 && bad.length === 0) radar.push({ key: 'ok', state: 'OK', sentence: `${running} Social Radar source${running === 1 ? '' : 's'} running.`, fix: null });
    if (links.length > 0) sections.push({ key: 'radar', label: 'Social Radar', checks: radar });

    const browser = (diagnostics?.browser ?? []).filter((p) => p.state !== 'OFF');
    if (browser.length > 0) {
      const worst = browser.find((p) => p.state === 'FAILING') ?? browser.find((p) => p.state === 'DEGRADED');
      sections.push({
        key: 'browser',
        label: 'Browser',
        checks: [
          worst
            ? { key: 'browser', state: worst.state === 'FAILING' ? 'PROBLEM' : 'ATTENTION', sentence: `${worst.name}: ${worst.detail}`, fix: fix('Open the browser session', href('browser')) }
            : { key: 'browser', state: 'OK', sentence: 'The X account browser is healthy.', fix: null },
        ],
      });
    }
  }

  // ── Models and capabilities ──
  {
    const checks: SetupCheck[] = [];
    const primary = diagnostics?.models.find((m) => m.role === 'primary');
    checks.push(
      primary?.configured
        ? { key: 'model', state: 'OK', sentence: `It thinks with ${primary.model}.`, fix: null }
        : { key: 'model', state: 'PROBLEM', sentence: 'No model is set up, so it cannot write anything.', fix: fix('Choose a model', href('intelligence')) },
    );
    const unready = (diagnostics?.tools ?? []).filter((t) => t.state === 'DEGRADED' || t.state === 'FAILING');
    if (unready.length > 0) {
      checks.push({
        key: 'capabilities',
        state: 'ATTENTION',
        sentence: `${unready.length} capabilit${unready.length === 1 ? 'y is' : 'ies are'} unavailable: ${unready.slice(0, 3).map((t) => `${t.name} (${t.detail})`).join('; ')}.`,
        fix: fix('Open Plugins', href('plugins')),
      });
    }
    sections.push({ key: 'toolspace', label: 'Models and capabilities', checks });
  }

  // ── Learning and autonomy ──
  {
    const checks: SetupCheck[] = [];
    if (learning) {
      const running = learning.trials.filter((t) => t.status === 'RUNNING').length;
      checks.push(
        running > 0
          ? { key: 'trial', state: 'OK', sentence: `Trying ${running} change${running === 1 ? '' : 's'} against a control, from ${learning.outcomes} measured outcomes.`, fix: fix('See what', href('learning')) }
          : {
              key: 'trial',
              state: 'OK',
              sentence:
                learning.outcomes === 0
                  ? 'Learning is on, but nothing it published has been measured yet.'
                  : `Learning is active but has insufficient evidence for a trial (${learning.outcomes} measured outcomes).`,
              fix: fix('See what it measured', href('learning')),
            },
      );
    }
    sections.push({ key: 'learning', label: 'Learning', checks });
    const mode = policy?.automation.mode ?? null;
    sections.push({
      key: 'autonomy',
      label: 'Autonomy',
      checks: [
        {
          key: 'mode',
          state: mode === 'OFF' ? 'NOT_SET_UP' : 'OK',
          sentence:
            mode === 'OFF'
              ? 'Automation is off, so it does nothing on its own.'
              : `Automation is ${String(mode ?? 'unknown').toLowerCase().replace(/_/g, ' ')}${wake?.enabled ? `, and it thinks between conversations at ${String(wake.autonomy).toLowerCase()} autonomy` : ', and it does not think between conversations'}.`,
          fix: fix('Change it', href('autonomy')),
        },
      ],
    });
  }

  // ── Recent errors and response quality ──
  {
    const count = (rows: typeof failures) => rows.reduce((a, f) => a + f.count, 0);
    const { real, held, onPurpose } = sortFailures(failures);
    const checks: SetupCheck[] = [];
    checks.push(
      real.length === 0
        ? { key: 'failures', state: 'OK', sentence: 'No failed work in the last seven days.', fix: null }
        : {
            key: 'failures',
            state: 'PROBLEM',
            sentence: `${count(real)} piece${count(real) === 1 ? '' : 's'} of work failed in the last seven days. The most recent: ${(real[0]?.lastError ?? real[0]?.status ?? '').slice(0, 160)}`,
            fix: fix('See the jobs', href('activity')),
          },
    );
    if (held.length > 0) {
      checks.push({
        key: 'held',
        state: 'ATTENTION',
        sentence: `${count(held)} ${count(held) === 1 ? 'reply is' : 'replies are'} waiting for you to review.`,
        fix: fix('Review them', href('activity')),
      });
    }
    if (onPurpose.length > 0) {
      checks.push({
        key: 'stopped',
        state: 'OK',
        sentence: `${count(onPurpose)} stopped as they should: a block you set, the agent's own post, or a post that was deleted.`,
        fix: null,
      });
    }
    sections.push({ key: 'errors', label: 'Recent errors', checks });

    const quality: SetupCheck[] = [];
    const habits = habitualPhrases(recent.map((r) => r.text));
    if (habits.length > 0) {
      quality.push({
        key: 'repetition',
        state: 'ATTENTION',
        sentence: `Recent outputs repeat "${habits[0]!.phrase}" (in ${habits[0]!.posts} of them).`,
        fix: fix('Look at its voice', href('voice')),
      });
    }
    const suite = suites[0] ? await testSuiteView(suites[0].id).catch(() => null) : null;
    if (!suite) {
      quality.push({ key: 'tests', state: 'NOT_SET_UP', sentence: 'It has not been put through the behavioural tests yet.', fix: fix('Test this agent', href('foundry')) });
    } else if (suite.counts.FAILED > 0) {
      quality.push({ key: 'tests', state: 'PROBLEM', sentence: `${suite.counts.FAILED} behavioural test${suite.counts.FAILED === 1 ? '' : 's'} failed on the last run.`, fix: fix('See which', href('foundry')) });
    } else {
      quality.push({ key: 'tests', state: 'OK', sentence: `The last behavioural test run had no failures (${suite.counts.REVIEW} to read).`, fix: fix('See the run', href('foundry')) });
    }
    sections.push({ key: 'quality', label: 'Response quality', checks: quality });
  }

  const counts = { OK: 0, ATTENTION: 0, PROBLEM: 0, NOT_SET_UP: 0 } as Record<SetupCheckState, number>;
  for (const section of sections) for (const check of section.checks) counts[check.state] += 1;
  return { agentId: agent.id, checkedAt: new Date(now).toISOString(), counts, sections };
}
