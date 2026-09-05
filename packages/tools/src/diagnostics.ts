/**
 * What an agent can find out about itself.
 *
 * Asked "why aren't you replying to mentions?", an agent should be able to say
 * "mention search is healthy, the notifications monitor has been failing for
 * eleven minutes, so discovery is still working through search". That needs
 * facts, and the facts are all already stored -- each radar source keeps its
 * own health, the account keeps its last poll, the worker publishes its tabs.
 * None of it was reachable from one place.
 *
 * Built from stored state, deliberately, rather than by giving the agent a
 * query interface with a filter over it. A filter is something somebody gets
 * wrong once; a shape with nowhere to put a secret is wrong never. See the
 * contract in `@xbam/shared/contracts/diagnostics` for what that means field by
 * field.
 */
import type { AgentDiagnostics, ComponentHealth, FailureSummary, HealthState } from '@xbam/shared/contracts';
import { createLogger, errorMessage, nowIso } from '@xbam/shared';
import {
  accounts as accountsRepo,
  agents as agentsRepo,
  knowledge as knowledgeRepo,
  ops as opsRepo,
  providers as providersRepo,
  query,
  radar as radarRepo,
  workers as workersRepo,
  WORKER_PRESENT_SECONDS,
} from '@xbam/database';
import { toolReadiness } from './toolReadiness';

const log = createLogger('diagnostics');

/** Minutes since a moment, or null when there is no moment. */
function minutesSince(at: string | null | undefined): number | null {
  if (!at) return null;
  const ms = Date.now() - Date.parse(at);
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms / 60_000)) : null;
}

const RUNNABLE = new Set(['ACTIVE', 'DRAFT']);

/**
 * Everything the agent may know, in one document.
 *
 * Nothing here throws. A diagnostic that fails to collect is worse than useless
 * -- it is asked precisely when something is already broken -- so each part
 * degrades to UNKNOWN with a sentence rather than taking the whole thing down.
 */
export async function collectDiagnostics(agentId: string): Promise<AgentDiagnostics> {
  const agent = await agentsRepo.getAgent(agentId);
  const links = agent ? await accountsRepo.listAgentAccounts(agentId) : [];
  const accountId = links[0]?.accountId ?? null;
  const account = accountId ? await accountsRepo.getAccount(accountId).catch(() => null) : null;

  return {
    agent: {
      state: agent?.state ?? 'MISSING',
      canWork: Boolean(agent && RUNNABLE.has(agent.state)),
      reason: !agent
        ? 'This agent no longer exists.'
        : RUNNABLE.has(agent.state)
          ? null
          : `The agent is ${agent.state.toLowerCase()}, so nothing is queued for it.`,
    },
    account: {
      connected: account?.status === 'CONNECTED',
      handle: account?.handle ?? null,
      status: account?.status ?? null,
      lastPolledAt: (account as { lastPolledAt?: string | null } | null)?.lastPolledAt ?? null,
    },
    worker: await workerHealth(),
    providers: await providerHealth(agent?.ownerId ?? null),
    models: await modelHealth(agentId),
    browser: await browserHealth(accountId),
    radar: await radarHealth(accountId),
    tools: await toolHealth(agentId),
    knowledge: await knowledgeHealth(agentId),
    lastSuccess: await lastSuccesses(agentId),
    recentFailures: await recentFailures(agentId),
    collectedAt: nowIso(),
  };
}

const unknown = (name: string, detail: string): ComponentHealth => ({
  name,
  state: 'UNKNOWN',
  detail,
  lastSucceededAt: null,
  failingForMinutes: null,
});

async function workerHealth(): Promise<ComponentHealth> {
  try {
    const present = await workersRepo.present();
    const browserCapable = present.filter((w) => w.browserCapable).length;
    return {
      name: 'Worker',
      state: present.length === 0 ? 'FAILING' : 'HEALTHY',
      detail:
        present.length === 0
          ? `Nothing has checked in for ${WORKER_PRESENT_SECONDS} seconds, so no work is being done at all.`
          : `${present.length} running, ${browserCapable} able to drive a browser.`,
      lastSucceededAt: present[0]?.lastSeenAt ?? null,
      failingForMinutes: null,
    };
  } catch {
    return unknown('Worker', 'Could not be checked.');
  }
}

async function providerHealth(ownerId: string | null): Promise<ComponentHealth[]> {
  if (!ownerId) return [];
  try {
    const credentials = await providersRepo.listProviders(ownerId);
    // The label and the provider name only. Never the key, never the endpoint:
    // a base URL can carry a token in its path.
    return credentials
      .filter((c) => c.enabled)
      .map((c) => ({
        name: `${c.label} (${c.provider})`,
        state: (c.lastStatus === 'healthy' ? 'HEALTHY' : c.lastStatus ? 'FAILING' : 'UNKNOWN') as HealthState,
        detail: c.lastStatus
          ? `Last checked and found ${c.lastStatus}.`
          : 'Has not been checked since it was added.',
        lastSucceededAt: c.lastStatus === 'healthy' ? (c.lastCheckedAt ?? null) : null,
        failingForMinutes: c.lastStatus && c.lastStatus !== 'healthy' ? minutesSince(c.lastCheckedAt) : null,
      }));
  } catch {
    return [unknown('Providers', 'Could not be checked.')];
  }
}

async function modelHealth(agentId: string): Promise<AgentDiagnostics['models']> {
  try {
    const assignments = await providersRepo.listModelConfigs(agentId);
    return assignments.map((row: { role: string; model?: string | null }) => ({
      role: row.role,
      configured: Boolean(row.model),
      model: row.model ?? null,
    }));
  } catch {
    return [];
  }
}

/**
 * What a published tab state means for somebody reading a health screen.
 *
 * The vocabulary the worker publishes is `READY | BUSY | MISSING | FAILED`,
 * from `TabHealth` in `@xbam/browser`. This used to compare against 'HEALTHY',
 * which the worker has never produced, so **every working tab was graded
 * DEGRADED** and every role that had not been needed yet was graded FAILING.
 * A screen that reports a healthy browser as degraded teaches people to ignore
 * the screen, which is the opposite of what it is for.
 *
 * MISSING is `OFF`, not a failure. Tabs are opened on demand and RESEARCH
 * spends most of its life closed; calling that broken would mean an agent doing
 * exactly the right thing always shows a fault.
 */
function gradeTab(state: string | undefined, lastError: string | null): { state: HealthState; detail: string } {
  switch (state) {
    case 'READY':
      return { state: 'HEALTHY', detail: 'Open and answering.' };
    case 'BUSY':
      // Busy is working. It means something is using the tab right now.
      return { state: 'HEALTHY', detail: 'In use right now.' };
    case 'MISSING':
      return { state: 'OFF', detail: 'Not open. This role is opened when it is needed.' };
    case 'FAILED':
      return {
        state: 'FAILING',
        // The classification and the sentence the browser layer wrote, never a
        // raw stack.
        detail: lastError ? `Failed: ${lastError.slice(0, 200)}` : 'Failed, with no reason recorded.',
      };
    default:
      return { state: 'UNKNOWN', detail: `Reported as ${String(state ?? 'nothing').toLowerCase()}.` };
  }
}

/**
 * The four tabs, from what the worker last published.
 *
 * The API owns no browsers, so a snapshot is all there is -- and one nobody has
 * refreshed describes a browser that has closed, which is why age decides
 * before contents do.
 */
async function browserHealth(accountId: string | null): Promise<ComponentHealth[]> {
  if (!accountId) return [];
  try {
    const rows = await query<{ tabs: unknown; tabs_updated_at: string | null }>(
      'SELECT tabs, tabs_updated_at FROM browser_sessions WHERE account_id = $1',
      [accountId],
    );
    const row = rows[0];
    if (!row) return [unknown('Browser', 'No browser has been opened for this account.')];

    const staleMinutes = minutesSince(row.tabs_updated_at);
    const stale = staleMinutes === null || staleMinutes * 60 > WORKER_PRESENT_SECONDS;
    if (stale) {
      return [
        {
          name: 'Browser',
          state: 'FAILING',
          detail: 'No worker has reported on this browser recently, so it is treated as not running.',
          lastSucceededAt: row.tabs_updated_at,
          failingForMinutes: staleMinutes,
        },
      ];
    }

    const tabs = Array.isArray(row.tabs)
      ? (row.tabs as { role?: string; state?: string; lastError?: string | null }[])
      : [];
    return tabs.map((tab) => {
      const { state, detail } = gradeTab(tab.state, tab.lastError ?? null);
      return {
        name: `${tab.role ?? 'Tab'} tab`,
        state,
        detail,
        lastSucceededAt: row.tabs_updated_at,
        failingForMinutes: state === 'FAILING' ? staleMinutes : null,
      };
    });
  } catch {
    return [unknown('Browser', 'Could not be checked.')];
  }
}

/**
 * Each monitor separately, because that is how they fail.
 *
 * The whole point of the radar is that one surface being incomplete is not
 * silence, so "the account is fine" is the wrong granularity: what an owner
 * needs to hear is which one stopped and what still works.
 */
async function radarHealth(accountId: string | null): Promise<ComponentHealth[]> {
  if (!accountId) return [];
  try {
    const sources = await radarRepo.listSources(accountId);
    return sources.map((source) => ({
      name: source.label || `${source.kind}${source.target ? ` (${source.target})` : ''}`,
      state: (!source.enabled
        ? 'OFF'
        : source.status === 'HEALTHY'
          ? 'HEALTHY'
          : source.status === 'DEGRADED'
            ? 'DEGRADED'
            : source.status === 'FAILING'
              ? 'FAILING'
              : 'UNKNOWN') as HealthState,
      detail: !source.enabled
        ? 'Switched off.'
        : source.status === 'HEALTHY'
          ? 'Polling normally.'
          : `${source.consecutiveFailures} failed poll(s) in a row.`,
      lastSucceededAt: source.lastSuccessAt ?? null,
      failingForMinutes: source.status === 'HEALTHY' ? null : minutesSince(source.lastSuccessAt),
    }));
  } catch {
    return [unknown('Social radar', 'Could not be checked.')];
  }
}

async function toolHealth(agentId: string): Promise<ComponentHealth[]> {
  try {
    const [items, policy] = await Promise.all([opsRepo.listAgentTools(agentId), agentsRepo.getActivePolicy(agentId)]);
    const allowed = (policy?.config as { tools?: { allowed?: string[] } } | undefined)?.tools?.allowed ?? [];
    return items.map((tool: { key: string; name?: string | null; enabled: boolean }) => {
      const verdict = toolReadiness({ key: tool.key, name: tool.name ?? undefined, enabled: tool.enabled }, allowed);
      return {
        name: tool.name ?? tool.key,
        state: (verdict.state === 'READY' ? 'HEALTHY' : verdict.state === 'OFF' ? 'OFF' : 'DEGRADED') as HealthState,
        // Already written for a person, and written here rather than anywhere
        // a value could reach it.
        detail: verdict.summary,
        lastSucceededAt: null,
        failingForMinutes: null,
      };
    });
  } catch {
    return [unknown('Tools', 'Could not be checked.')];
  }
}

async function knowledgeHealth(agentId: string): Promise<ComponentHealth[]> {
  try {
    const sources = await knowledgeRepo.listSources(agentId);
    return sources.map((source) => ({
      name: source.name,
      state: (!source.enabled
        ? 'OFF'
        : source.lastError
          ? 'FAILING'
          : source.indexedAt
            ? 'HEALTHY'
            : 'UNKNOWN') as HealthState,
      detail: !source.enabled
        ? 'Switched off.'
        : source.lastError
          ? 'The last attempt to read it did not finish.'
          : source.indexedAt
            ? `${source.documentCount} document(s) read.`
            : 'Has not been read yet.',
      lastSucceededAt: source.indexedAt ?? null,
      failingForMinutes: source.lastError ? minutesSince(source.updatedAt) : null,
    }));
  } catch {
    return [unknown('Knowledge', 'Could not be checked.')];
  }
}

/**
 * The three timestamps that answer "is it actually working".
 *
 * Read from what happened rather than from a counter, for the same reason
 * everything else here is: a counter can be stale and still look confident.
 */
/**
 * The three timestamps that answer "is it actually doing anything".
 *
 * This asked for `model_calls.finished_at`, which does not exist -- the column
 * is `completed_at` -- and matched `status = 'OK'`, which the writer never
 * produces either; it writes COMPLETED or FAILED. So the query threw, the catch
 * turned that into three nulls, and **every agent has always reported never
 * read, never wrote, never sent**, including agents in the middle of working.
 *
 * Two lessons, both already written down elsewhere in this codebase and both
 * ignored here: compare against the vocabulary the writer actually produces,
 * and never let a catch turn a broken query into a plausible answer.
 */
async function lastSuccesses(agentId: string): Promise<AgentDiagnostics['lastSuccess']> {
  try {
    const rows = await query<{ poll: string | null; generation: string | null; action: string | null }>(
      `SELECT
         (SELECT max(a.last_polled_at) FROM accounts a
            JOIN agent_accounts aa ON aa.account_id = a.id WHERE aa.agent_id = $1) AS poll,
         (SELECT max(m.completed_at) FROM model_calls m
           WHERE m.agent_id = $1 AND m.status = 'COMPLETED') AS generation,
         (SELECT max(ac.executed_at) FROM actions ac
           WHERE ac.agent_id = $1 AND ac.status = 'EXECUTED' AND ac.dry_run = false) AS action`,
      [agentId],
    );
    return { poll: rows[0]?.poll ?? null, generation: rows[0]?.generation ?? null, action: rows[0]?.action ?? null };
  } catch (error) {
    // Said out loud. Three nulls look exactly like an agent that has never done
    // anything, which is how this stayed broken.
    log.error('the last-success timestamps could not be read', { agentId, message: errorMessage(error) });
    return { poll: null, generation: null, action: null };
  }
}

/**
 * Failures by their class, counted.
 *
 * The class is a name this codebase chose. The message is not included and must
 * not be: a raw error can contain the request it came from, and a request can
 * contain a key.
 */
async function recentFailures(agentId: string, hours = 24): Promise<FailureSummary[]> {
  try {
    return await query<FailureSummary>(
      `SELECT error_class AS reason, count(*)::int AS count, max(updated_at) AS "lastAt"
         FROM jobs
        WHERE agent_id = $1
          AND error_class IS NOT NULL
          AND updated_at > now() - make_interval(hours => $2)
        GROUP BY error_class
        ORDER BY count DESC
        LIMIT 20`,
      [agentId, hours],
    );
  } catch {
    return [];
  }
}
