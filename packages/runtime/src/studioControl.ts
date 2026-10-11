import { agents as agentsRepo, ops } from '@xbam/database';
import { createLogger, errorMessage } from '@xbam/shared';
import { startPreflight } from './agentStart';
import { agentStatusNow } from './agentStatusNow';
import { pauseState, setPauseAll } from './killSwitch';
import { studioExchange } from './studioLink';
import { canShowBrowser, releaseControl, startView, stopView, studioLiveViewSetting, studioTakeoverSetting, takeControl } from './studioLiveView';

const log = createLogger('studio-control');

/**
 * Seeing and steering this installation's agents from AI17Z Studio.
 *
 * ## Off until the owner says otherwise
 *
 * Linking an installation to Studio was for entitlements: it sent nothing
 * about the agents. Showing them in Studio, and letting Studio pause one, is a
 * different thing to have agreed to, so it is a separate switch
 * (`studio.control`), off by default, and turning it off tells Studio once so
 * it stops offering controls it can no longer use.
 *
 * ## The same boundary as Telegram
 *
 * `telegramCommands.ts` made this decision first and the reasoning carries:
 *
 *   1. **Outbound only.** Studio never reaches this machine. The worker asks,
 *      on the sweep it already runs, and Studio answers with what is waiting.
 *   2. **A closed list of verbs.** `STUDIO_COMMANDS` is the whole of it.
 *      Nothing interprets free text, nothing becomes part of a prompt, and a
 *      kind not in the list is refused with a sentence.
 *   3. **Every verb through what already exists.** Resuming an agent runs the
 *      same preflight as the Start button, and refuses for the same reasons; a
 *      pause of everything is `setPauseAll`. No second set of gates.
 *   4. **Nothing sensitive goes out.** An agent's id, name, state and a one
 *      sentence status. No persona, no memory, no account handle, no draft.
 *   5. **Stale is not an instruction.** A command older than
 *      `STALE_COMMAND_MS` is answered and not carried out.
 *   6. **Once.** A command id already carried out is answered from its
 *      recorded result, because a response lost on the way back means Studio
 *      will deliver it again.
 *
 * It speaks for the installation, as the Telegram chat does: Studio's owner
 * linked this machine, and sees every agent on it.
 */

/**
 * The whole list. The last two show the agent's browser and stop showing it,
 * and run only where the live view switch is on and the browser lives.
 */
export const STUDIO_COMMANDS = ['PAUSE_AGENT', 'RESUME_AGENT', 'PAUSE_ALL', 'RESUME_ALL', 'START_VIEW', 'STOP_VIEW', 'TAKE_CONTROL', 'RELEASE_CONTROL'] as const;
export type StudioCommandKind = (typeof STUDIO_COMMANDS)[number];

/** Fifteen minutes, as for a Telegram command: long enough for a slow sweep, short enough that nothing stale survives. */
export const STALE_COMMAND_MS = 15 * 60_000;

const CONTROL_SETTING = 'studio.control';
const DONE_SETTING = 'studio.control.done';
/** How many carried-out commands are remembered for answering a redelivery. */
const DONE_KEPT = 200;
/** How many commands one sweep will carry out, so a flood cannot hold the loop. */
const MAX_PER_SWEEP = 20;

export interface ControlSetting {
  enabled: boolean;
  changedAt: string | null;
  /** Whether Studio has been told the current value. */
  announced: boolean;
}

export interface StudioCommand {
  id: string;
  kind: string;
  agentId: string | null;
  ageMs: number;
}

export interface StudioCommandResult {
  id: string;
  ok: boolean;
  sentence: string;
}

export interface ReportedAgent {
  id: string;
  name: string;
  state: string;
  activity: string;
  detail: string;
  awaitingPeople: number;
}

const OFF: ControlSetting = { enabled: false, changedAt: null, announced: true };

export async function studioControlSetting(): Promise<ControlSetting> {
  return (await ops.getSetting<ControlSetting>(CONTROL_SETTING)) ?? OFF;
}

/** The owner's switch. Studio is told on the next sweep either way. */
export async function setStudioControl(enabled: boolean, by: string | null): Promise<ControlSetting> {
  const next: ControlSetting = { enabled, changedAt: new Date().toISOString(), announced: false };
  await ops.setSetting(CONTROL_SETTING, next);
  await ops.audit({ actorUserId: by, action: enabled ? 'studio.control.enabled' : 'studio.control.disabled', entityType: 'settings', entityId: 'studio' });
  return next;
}

/** Reads a command list off Studio's answer, dropping anything that is not the expected shape. */
export function parseCommands(body: Record<string, unknown> | null): StudioCommand[] {
  const raw = Array.isArray(body?.commands) ? body.commands : [];
  const out: StudioCommand[] = [];
  for (const item of raw.slice(0, MAX_PER_SWEEP)) {
    if (!item || typeof item !== 'object') continue;
    const c = item as Record<string, unknown>;
    if (typeof c.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(c.id) || typeof c.kind !== 'string') continue;
    const agentId = typeof c.agent_id === 'string' && /^[0-9a-f-]{36}$/i.test(c.agent_id) ? c.agent_id : null;
    const ageMs = typeof c.age_seconds === 'number' && Number.isFinite(c.age_seconds) ? Math.max(0, c.age_seconds) * 1000 : Number.POSITIVE_INFINITY;
    out.push({ id: c.id, kind: c.kind, agentId, ageMs });
  }
  return out;
}

/**
 * Carries out one command. Pure decision over injected effects, so every
 * refusal can be pinned without a database.
 */
export async function carryOut(
  command: StudioCommand,
  effects: {
    agent: (id: string) => Promise<{ id: string; name: string; state: string } | null>;
    pause: (id: string) => Promise<void>;
    resume: (id: string) => Promise<{ ok: true } | { ok: false; why: string }>;
    pauseAll: (paused: boolean) => Promise<void>;
    audit: (action: string, entityId: string | null) => Promise<void>;
    startView?: (agentId: string, name: string) => Promise<{ ok: boolean; sentence: string }>;
    stopView?: (agentId: string) => Promise<boolean>;
    takeControl?: (agentId: string, name: string) => Promise<{ ok: boolean; sentence: string }>;
    releaseControl?: (agentId: string) => Promise<boolean>;
  },
): Promise<StudioCommandResult> {
  const answer = (ok: boolean, sentence: string): StudioCommandResult => ({ id: command.id, ok, sentence });
  if (!(STUDIO_COMMANDS as readonly string[]).includes(command.kind)) {
    return answer(false, 'This AI17Z does not know that command. It may need updating.');
  }
  if (!(command.ageMs <= STALE_COMMAND_MS)) {
    return answer(false, 'Not carried out: it arrived too long after it was sent to still be meant.');
  }
  const kind = command.kind as StudioCommandKind;
  if (kind === 'PAUSE_ALL' || kind === 'RESUME_ALL') {
    await effects.pauseAll(kind === 'PAUSE_ALL');
    await effects.audit(kind === 'PAUSE_ALL' ? 'studio.command.pause_all' : 'studio.command.resume_all', null);
    return answer(true, kind === 'PAUSE_ALL' ? 'Everything on this AI17Z is paused.' : 'The pause on this AI17Z is lifted.');
  }
  if (!command.agentId) return answer(false, 'The command did not say which agent.');
  const agent = await effects.agent(command.agentId);
  if (!agent) return answer(false, 'That agent is not on this AI17Z any more.');
  if (kind === 'START_VIEW') {
    if (!effects.startView) return answer(false, 'This part of AI17Z does not run the browser.');
    const started = await effects.startView(agent.id, agent.name);
    return answer(started.ok, started.sentence);
  }
  if (kind === 'STOP_VIEW') {
    const stopped = effects.stopView ? await effects.stopView(agent.id) : false;
    return answer(true, stopped ? `Stopped showing ${agent.name}'s browser.` : `${agent.name}'s browser was not being shown.`);
  }
  if (kind === 'TAKE_CONTROL') {
    if (!effects.takeControl) return answer(false, 'This part of AI17Z does not run the browser.');
    const taken = await effects.takeControl(agent.id, agent.name);
    return answer(taken.ok, taken.sentence);
  }
  if (kind === 'RELEASE_CONTROL') {
    const released = effects.releaseControl ? await effects.releaseControl(agent.id) : false;
    return answer(true, released ? `You gave ${agent.name} its browser back.` : `${agent.name} already had its browser.`);
  }
  if (kind === 'PAUSE_AGENT') {
    if (agent.state === 'PAUSED') return answer(true, `${agent.name} was already paused.`);
    await effects.pause(agent.id);
    await effects.audit('agent.paused', agent.id);
    return answer(true, `${agent.name} is paused.`);
  }
  // RESUME_AGENT
  if (agent.state === 'ACTIVE') return answer(true, `${agent.name} was already running.`);
  if (agent.state !== 'PAUSED') return answer(false, `${agent.name} is not set up to run yet. Finish setting it up on the machine it runs on.`);
  const resumed = await effects.resume(agent.id);
  if (!resumed.ok) return answer(false, resumed.why);
  await effects.audit('agent.started', agent.id);
  return answer(true, `${agent.name} is running again.`);
}

const realEffects = {
  agent: async (id: string) => agentsRepo.getAgent(id),
  pause: async (id: string) => {
    await agentsRepo.updateAgent(id, { state: 'PAUSED' });
  },
  resume: async (id: string): Promise<{ ok: true } | { ok: false; why: string }> => {
    const blockers = await startPreflight(id);
    if (blockers.length > 0) return { ok: false, why: `Not started: ${blockers[0]!.what} ${blockers[0]!.fix}` };
    await agentsRepo.updateAgent(id, { state: 'ACTIVE', lastError: null });
    return { ok: true };
  },
  pauseAll: async (paused: boolean) => {
    await setPauseAll({ paused, by: null, reason: 'Paused from AI17Z Studio.' });
  },
  audit: async (action: string, entityId: string | null) => {
    await ops.audit({ actorUserId: null, action, entityType: entityId ? 'agent' : 'settings', entityId: entityId ?? 'pause', data: { via: 'studio' } });
  },
  startView,
  stopView,
  takeControl,
  releaseControl,
};

async function reportAgents(): Promise<ReportedAgent[]> {
  const out: ReportedAgent[] = [];
  for (const agent of await agentsRepo.allAgents()) {
    try {
      const { status, awaitingPeople } = await agentStatusNow(agent.id);
      out.push({ id: agent.id, name: agent.name, state: agent.state, activity: status.activity, detail: status.detail, awaitingPeople });
    } catch (error) {
      // One agent whose status cannot be read is reported plainly rather than
      // dropped, because a missing card reads as a deleted agent.
      out.push({ id: agent.id, name: agent.name, state: agent.state, activity: 'NEEDS_ATTENTION', detail: 'Its status could not be read just now.', awaitingPeople: 0 });
      log.warn('could not read an agent status for Studio', { agentId: agent.id, message: errorMessage(error) });
    }
  }
  return out;
}

/**
 * One exchange with Studio, run on the worker's sweep when linked. Reports
 * the agents, carries out what is waiting, and reports the results in a
 * second request that asks for nothing new, so a command is never delivered
 * into a sweep that has already finished.
 */
export async function exchangeWithStudio(): Promise<{ ran: number; skipped?: string }> {
  const setting = await studioControlSetting();
  if (!setting.enabled) {
    if (setting.announced) return { ran: 0, skipped: 'off' };
    const told = await studioExchange({ protocol: 1, control: false, want_commands: false });
    if (told.ok) await ops.setSetting(CONTROL_SETTING, { ...setting, announced: true });
    return { ran: 0, skipped: told.ok ? 'off' : told.why };
  }

  // Which commands this process can carry out: only the worker that owns the
  // browser can show it, and only when the owner allowed showing it.
  const shows = canShowBrowser() && (await studioLiveViewSetting()).enabled;
  const takeover = shows && (await studioTakeoverSetting()).enabled;
  const first = await studioExchange({ protocol: 1, control: true, paused: (await pauseState()).paused, agents: await reportAgents(), browser: shows, takeover, want_commands: true });
  if (!first.ok) return { ran: 0, skipped: first.why };
  if (!setting.announced) await ops.setSetting(CONTROL_SETTING, { ...setting, announced: true });

  const commands = parseCommands(first.body);
  if (commands.length === 0) return { ran: 0 };
  const done = (await ops.getSetting<StudioCommandResult[]>(DONE_SETTING)) ?? [];
  const results: StudioCommandResult[] = [];
  for (const command of commands) {
    const before = done.find((r) => r.id === command.id);
    if (before) {
      results.push(before);
      continue;
    }
    let result: StudioCommandResult;
    try {
      result = await carryOut(command, realEffects);
    } catch (error) {
      log.warn('a Studio command failed', { kind: command.kind, message: errorMessage(error) });
      result = { id: command.id, ok: false, sentence: 'It could not be carried out. The machine logged why.' };
    }
    results.push(result);
    done.unshift(result);
  }
  await ops.setSetting(DONE_SETTING, done.slice(0, DONE_KEPT));
  const second = await studioExchange({ protocol: 1, control: true, paused: (await pauseState()).paused, agents: await reportAgents(), results, browser: shows, takeover, want_commands: false });
  if (!second.ok) log.warn('could not report Studio command results; they are sent again when redelivered', { why: second.why });
  return { ran: results.length };
}
