import {
  agents as agentsRepo,
  jobs as jobsRepo,
  notifications as notificationsRepo,
  ops as opsRepo,
  workers as workersRepo,
} from '@xbam/database';
import { createLogger, errorMessage, openSecret } from '@xbam/shared';
import { approveJob, rejectJob } from './approvals';
import { pauseState, setPauseAll } from './killSwitch';
import { loadConfig, saveConfig, telegramMuted, type TelegramConfig } from './telegram';
import { escapeHtml, getUpdates, sendMessage } from './telegramApi';

const log = createLogger('telegram-commands');

/**
 * The owner's controls, on their phone.
 *
 * ## What changed, and what did not
 *
 * This file is a deliberate reversal of one sentence that used to be in
 * `telegram.ts`: "not a command channel". The reasoning behind it was sound and
 * is kept, that a bot token is a bearer credential and a chat is not an
 * authenticated session, but the conclusion was wrong for the case that
 * matters. An owner who gets "an account is waiting on a security challenge" at
 * three in the morning, on a machine at home, could read it and do nothing
 * about it. A notification nobody can act on is half a feature.
 *
 * So the boundary moved rather than disappeared, and it moved to four places:
 *
 *   1. **One chat, and only one.** Every update from any chat other than the
 *      paired one is dropped without a reply. Not answered with a refusal,
 *      dropped. A refusal confirms the bot is live and attached to something
 *      worth attacking, to whoever typed at it.
 *   2. **A closed list of verbs.** Nothing here interprets free text, and no
 *      message becomes an instruction to an agent, a prompt, or a shell. What
 *      is not in `COMMANDS` is not a command.
 *   3. **Every verb goes through the machinery that already exists.** An
 *      approval is `approveJob`, the same call the web UI makes, with the same
 *      policy check on the text. A pause is `setPauseAll`. There is no second
 *      path to anything, so there is no second set of gates to keep in step.
 *   4. **Nothing sensitive comes back.** No token, no cookie, no provider
 *      credential, no memory. Every reply below is assembled from a fixed set
 *      of fields; none of them is a secret, and none is free text from a
 *      model.
 *
 * ## Still not a channel
 *
 * No agent reads this, writes to it, or knows it exists. What arrives here
 * reaches the owner's own controls and nothing else: it cannot become
 * something an agent says, and it cannot become part of a prompt.
 *
 * ## It speaks for the installation, not for one owner
 *
 * The paired chat sees what is waiting anywhere on this machine, and can
 * decide it. That matches the notifications it already receives, which have
 * always been installation-wide, and the alternative is the half-feature
 * again: a phone that says "a draft is waiting" and then refuses to let you
 * answer it. It is said here rather than left to be discovered, because on an
 * installation with more than one owner it is the thing to know before
 * pairing.
 */

/** How many updates one sweep will take. Bounded so a flood cannot hold the loop. */
const MAX_PER_SWEEP = 20;

/** How much of a job id has to be typed. Eight hex characters is a phone-sized name. */
const SHORT_ID = 8;

export interface CommandSpec {
  /** Without the slash. */
  name: string;
  args: string | null;
  /** What it does, in the owner's words. Shown by /help. */
  blurb: string;
  /** True when it changes something, which decides whether it is audited. */
  acts: boolean;
}

/**
 * Everything the bot will do.
 *
 * Read-heavy on purpose. The two that change the most, pausing and approving,
 * are the two an owner actually needs a phone for, and both are reversible:
 * a pause is lifted, and a declined draft was never sent. Nothing here deletes
 * anything, changes a policy, touches a credential, or makes an agent say
 * something the pipeline did not already write and check.
 */
export const COMMANDS: CommandSpec[] = [
  { name: 'help', args: null, blurb: 'This list.', acts: false },
  { name: 'status', args: null, blurb: 'What is running, and what is waiting for you.', acts: false },
  { name: 'pending', args: null, blurb: 'Drafts waiting on a decision, with their ids.', acts: false },
  { name: 'show', args: '<id>', blurb: 'The whole of one draft, and who it answers.', acts: false },
  { name: 'approve', args: '<id>', blurb: 'Send that draft. It is checked against the policy first.', acts: true },
  { name: 'decline', args: '<id>', blurb: 'Do not send that draft.', acts: true },
  { name: 'pause', args: null, blurb: 'Stop every agent from doing anything, immediately.', acts: true },
  { name: 'resume', args: null, blurb: 'Lift the pause.', acts: true },
  { name: 'mute', args: '<hours>', blurb: 'No messages here for a while. Up to 24 hours.', acts: true },
  { name: 'unmute', args: null, blurb: 'Start telling me things again.', acts: true },
  { name: 'health', args: null, blurb: 'The worker, the browser, and anything unhealthy.', acts: false },
];

const BY_NAME = new Map(COMMANDS.map((command) => [command.name, command]));

/** Short names people reach for, mapped to the real one. */
const ALIASES: Record<string, string> = {
  ok: 'approve',
  yes: 'approve',
  no: 'decline',
  reject: 'decline',
  stop: 'pause',
  start: 'resume',
  h: 'help',
  s: 'status',
};

export function helpText(): string {
  const lines = [
    '<b>What you can ask me</b>',
    '',
    ...COMMANDS.map(
      (command) => `<code>/${command.name}${command.args ? ` ${command.args}` : ''}</code> · ${escapeHtml(command.blurb)}`,
    ),
    '',
    '<i>Ids are the first eight characters. Typing more of one is fine.</i>',
  ];
  return lines.join('\n');
}

/**
 * Parses one message into a command.
 *
 * Deliberately strict. A message that is not a command is not a command, and
 * guessing at what somebody meant is how "no" becomes an approval.
 */
export function parseCommand(text: string): { name: string; argument: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  // Telegram appends @thebot to commands in groups.
  const match = trimmed.match(/^\/([A-Za-z_]+)(?:@\S+)?\s*(.*)$/s);
  if (!match) return null;
  const raw = match[1]!.toLowerCase();
  return { name: ALIASES[raw] ?? raw, argument: (match[2] ?? '').trim() };
}

/** Jobs a person is being asked to decide. The same two states the badge counts. */
async function waiting(limit = 10) {
  const result = await jobsRepo.listJobs({
    statuses: ['WAITING_FOR_APPROVAL', 'REVIEW_REQUIRED'],
    limit,
    offset: 0,
  });
  return result.items;
}

/**
 * Finds the one job a typed id means.
 *
 * An ambiguous prefix is refused rather than resolved to the first match. The
 * whole point of the id is that the owner knows which draft they are sending,
 * and "probably that one" is not good enough for something that publishes.
 */
async function findByShortId(prefix: string): Promise<{ job: Awaited<ReturnType<typeof waiting>>[number] } | { error: string }> {
  const clean = prefix.trim().toLowerCase();
  if (clean.length < 4) return { error: 'Give me at least four characters of the id. <code>/pending</code> lists them.' };
  const open = await waiting(50);
  const matches = open.filter((job) => job.id.toLowerCase().startsWith(clean));
  if (matches.length === 0) return { error: 'Nothing is waiting under that id. <code>/pending</code> lists what is.' };
  if (matches.length > 1) {
    return { error: `That matches ${matches.length} of them. Type a few more characters.` };
  }
  return { job: matches[0]! };
}

function shortId(id: string): string {
  return id.slice(0, SHORT_ID);
}

/** A draft, trimmed to something readable on a phone. */
function excerpt(text: string | null | undefined, limit = 220): string {
  const clean = (text ?? '').trim().replace(/\s+/g, ' ');
  if (!clean) return '(nothing)';
  return escapeHtml(clean.length <= limit ? clean : `${clean.slice(0, limit)}...`);
}

async function statusReply(): Promise<string> {
  const [paused, counts, open, present, muted] = await Promise.all([
    pauseState(),
    jobsRepo.countJobsByStatus(),
    notificationsRepo.countOpen(),
    workersRepo.present(),
    telegramMuted(),
  ]);
  const held = (counts.WAITING_FOR_APPROVAL ?? 0) + (counts.REVIEW_REQUIRED ?? 0);
  const states = await agentsRepo.countAgentsByState();
  const total = Object.values(states).reduce((sum, count) => sum + count, 0);
  const active = states.ACTIVE ?? 0;

  const lines = [
    paused.paused ? '⏸ <b>Everything is paused.</b>' : '<b>AI17Z is running.</b>',
    '',
    `Agents: ${active} active of ${total}.`,
    `Workers: ${present.length === 0 ? 'none running' : `${present.length} running`}.`,
    `Waiting for you: ${held}.`,
    `Open problems: ${open.critical} critical, ${open.warning} warning.`,
  ];
  if (paused.paused && paused.since) lines.push('', `<i>Paused since ${escapeHtml(paused.since)}.</i>`);
  if (muted) lines.push('', `<i>Messages here are muted until ${escapeHtml(muted)}.</i>`);
  if (held > 0) lines.push('', 'Use <code>/pending</code> to see them.');
  return lines.join('\n');
}

async function pendingReply(): Promise<string> {
  const open = await waiting(10);
  if (open.length === 0) return 'Nothing is waiting for you.';
  const lines = ['<b>Waiting for a decision</b>', ''];
  for (const job of open) {
    lines.push(
      `<code>${shortId(job.id)}</code> ${escapeHtml(job.agentName)} to @${escapeHtml(
        job.authorHandle ?? 'someone',
      )}`,
      excerpt(job.validatedOutput ?? job.generatedOutput, 160),
      '',
    );
  }
  lines.push('<code>/approve &lt;id&gt;</code> or <code>/decline &lt;id&gt;</code>.');
  return lines.join('\n');
}

async function healthReply(): Promise<string> {
  const [present, browser, open] = await Promise.all([
    workersRepo.present(),
    workersRepo.browserWorkerPresent(),
    notificationsRepo.listOpen({ limit: 6 }),
  ]);

  const lines = [
    '<b>Health</b>',
    '',
    `Workers running: ${present.length}.`,
    `A worker that can drive a browser: ${browser ? 'yes' : 'no'}.`,
  ];
  if (open.length === 0) {
    lines.push('', 'Nothing is reporting a problem.');
  } else {
    lines.push('', '<b>Open problems</b>');
    // Coalesced rather than one message per occurrence: `notify` already
    // counts repeats against one row, and the count is what says whether
    // something is happening once or continuously.
    for (const item of open) {
      const mark = item.severity === 'CRITICAL' ? '🔴' : item.severity === 'WARNING' ? '🟠' : '🔵';
      lines.push(
        `${mark} ${escapeHtml(item.title)}${item.occurrences > 1 ? ` <i>(${item.occurrences}x)</i>` : ''}`,
      );
    }
  }
  return lines.join('\n');
}

export interface CommandResult {
  /** What to send back. Null when the message is to be ignored entirely. */
  reply: string | null;
  /** The verb, for the audit row. Null when nothing was recognised. */
  command: string | null;
}

/**
 * Runs one command and produces the reply.
 *
 * Separated from the polling so it can be tested without a network, and so the
 * one place that decides what a command does is not also the place that decides
 * whose messages count.
 */
export async function runCommand(text: string, actor: string): Promise<CommandResult> {
  const parsed = parseCommand(text);
  if (!parsed) {
    // Not a command. Answered with the list rather than ignored, because the
    // owner typing at their own bot and getting silence has no way to tell a
    // broken connection from a message it did not understand.
    return { reply: `I only take commands.\n\n${helpText()}`, command: null };
  }

  const spec = BY_NAME.get(parsed.name);
  if (!spec) return { reply: `I do not know <code>/${escapeHtml(parsed.name)}</code>.\n\n${helpText()}`, command: null };

  switch (spec.name) {
    case 'help':
      return { reply: helpText(), command: 'help' };

    case 'status':
      return { reply: await statusReply(), command: 'status' };

    case 'pending':
      return { reply: await pendingReply(), command: 'pending' };

    case 'health':
      return { reply: await healthReply(), command: 'health' };

    case 'show': {
      const found = await findByShortId(parsed.argument);
      if ('error' in found) return { reply: found.error, command: 'show' };
      const job = found.job;
      return {
        reply: [
          `<b>${escapeHtml(job.agentName)}</b> to @${escapeHtml(job.authorHandle ?? 'someone')}`,
          '',
          `<i>They said:</i> ${excerpt(job.incomingText, 400)}`,
          '',
          `<i>It would say:</i> ${excerpt(job.validatedOutput ?? job.generatedOutput, 600)}`,
          '',
          `<code>/approve ${shortId(job.id)}</code> or <code>/decline ${shortId(job.id)}</code>`,
        ].join('\n'),
        command: 'show',
      };
    }

    case 'approve': {
      const found = await findByShortId(parsed.argument);
      if ('error' in found) return { reply: found.error, command: 'approve' };
      try {
        /*
          The same call the web UI makes.

          Including the policy check on the text, which is the reason this is
          not a shortcut around the approval system: an approval from a phone
          must not be able to send something an approval from the app could
          not.
        */
        await approveJob({ jobId: found.job.id, decidedBy: null, note: `Approved from Telegram by ${actor}.` });
        return { reply: `Sent. <code>${shortId(found.job.id)}</code> is on its way.`, command: 'approve' };
      } catch (error) {
        return { reply: `That could not be approved: ${escapeHtml(errorMessage(error))}`, command: 'approve' };
      }
    }

    case 'decline': {
      const found = await findByShortId(parsed.argument);
      if ('error' in found) return { reply: found.error, command: 'decline' };
      try {
        await rejectJob({ jobId: found.job.id, decidedBy: null, note: `Declined from Telegram by ${actor}.` });
        return { reply: `Left unsent. <code>${shortId(found.job.id)}</code> is closed.`, command: 'decline' };
      } catch (error) {
        return { reply: `That could not be declined: ${escapeHtml(errorMessage(error))}`, command: 'decline' };
      }
    }

    case 'pause': {
      await setPauseAll({ paused: true, by: `telegram:${actor}`, reason: 'Paused from Telegram.' });
      return {
        reply: '⏸ <b>Everything is paused.</b>\nNothing will be sent until you <code>/resume</code>.',
        command: 'pause',
      };
    }

    case 'resume': {
      await setPauseAll({ paused: false, by: `telegram:${actor}` });
      return { reply: '<b>Running again.</b>', command: 'resume' };
    }

    case 'mute': {
      const hours = Number(parsed.argument || '4');
      if (!Number.isFinite(hours) || hours <= 0 || hours > 24) {
        return { reply: 'Give me a number of hours between 1 and 24. <code>/mute 4</code>.', command: 'mute' };
      }
      const until = new Date(Date.now() + hours * 3_600_000).toISOString();
      const config = await loadConfig();
      await saveConfig({ ...config, mutedUntil: until });
      /*
        Muted, not switched off.

        A mute has an end, and an owner who silences a noisy night still wants
        to be told about the next thing. Turning the transport off is a
        different decision and it lives on the settings screen, where it can be
        seen.
      */
      return {
        reply: `Quiet for ${hours} hour${hours === 1 ? '' : 's'}. Nothing will arrive here until then; it is all still in the app.`,
        command: 'mute',
      };
    }

    case 'unmute': {
      const config = await loadConfig();
      await saveConfig({ ...config, mutedUntil: null });
      return { reply: 'Telling you things again.', command: 'unmute' };
    }

    default:
      return { reply: helpText(), command: null };
  }
}

/**
 * One sweep of the inbox.
 *
 * Called from the worker's own loop, beside the other claims, and the offset in
 * settings is what stops a message being handled twice. It moves **before** the
 * command runs, deliberately: a command that throws halfway must not be
 * retried, because the half that already happened was an approval.
 */
export async function pollTelegramCommands(fetchImpl: typeof fetch = fetch): Promise<number> {
  const config = await loadConfig();
  // Nothing to listen to until pairing has established which chat is the
  // owner's. Before that, `pairTelegram` owns the offset.
  if (!config.enabled || !config.tokenSealed || !config.chatId) return 0;

  const token = openSecret(config.tokenSealed);
  let updates;
  try {
    updates = await getUpdates(token, config.updateOffset ?? undefined, fetchImpl);
  } catch (error) {
    log.debug('could not read Telegram messages', { message: errorMessage(error) });
    return 0;
  }
  if (updates.length === 0) return 0;

  let handled = 0;
  let offset = config.updateOffset ?? 0;

  for (const update of updates.slice(0, MAX_PER_SWEEP)) {
    offset = Math.max(offset, update.update_id + 1);
    const message = update.message;
    if (!message?.text) continue;

    /*
      Somebody else's message.

      Dropped without a reply. A bot can be messaged by anyone who knows its
      username, and answering a stranger, even with a refusal, confirms
      that this bot is live and attached to something worth attacking.
    */
    if (message.chat.id !== config.chatId) continue;

    // The offset is saved before the command runs, so a command that throws is
    // not retried on the next sweep. The half that already happened may have
    // been an approval, and sending a reply twice is worse than not finishing.
    await saveConfig({ ...(await loadConfig()), updateOffset: offset });

    const actor = message.from?.username ?? message.from?.first_name ?? `chat ${message.chat.id}`;
    let result: CommandResult;
    try {
      result = await runCommand(message.text, actor);
    } catch (error) {
      log.warn('a Telegram command failed', { message: errorMessage(error) });
      result = { reply: 'Something went wrong running that. Nothing was changed.', command: null };
    }

    if (result.command && BY_NAME.get(result.command)?.acts) {
      // Remote control of somebody's accounts is worth a row. Who, what, and
      // when, and nothing about the content of the message beyond the verb.
      await opsRepo.audit({
        actorUserId: null,
        action: `telegram.${result.command}`,
        entityType: 'installation',
        data: { actor, chatId: message.chat.id },
      });
    }

    if (result.reply) {
      try {
        await sendMessage(token, config.chatId, result.reply, fetchImpl);
      } catch (error) {
        log.warn('could not answer a Telegram command', { message: errorMessage(error) });
      }
    }
    handled += 1;
  }

  if (offset !== (config.updateOffset ?? 0)) {
    await saveConfig({ ...(await loadConfig()), updateOffset: offset });
  }
  return handled;
}

export type { TelegramConfig };
