import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { jobs as jobsRepo, query } from '@xbam/database';
import {
  COMMANDS,
  clearTransports,
  connectTelegram,
  disconnectTelegram,
  helpText,
  loadConfig,
  pairTelegram,
  parseCommand,
  pauseState,
  pollTelegramCommands,
  runCommand,
  setPauseAll,
  telegramMuted,
  telegramStatus,
} from '@xbam/runtime';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { uniqueSuffix } from '../support/db';

installHarness();

/**
 * The owner's controls, on their phone.
 *
 * Against a real database because every command reads or changes a real row,
 * and against a fake Telegram installed over the global fetch because that is
 * how the worker's sweep calls it, since injecting one would test a path that
 * never
 * runs.
 *
 * The properties that matter are not that the commands work. They are that a
 * stranger cannot use them, that nothing sensitive comes back, and that what
 * publishes goes through the approval system rather than around it.
 */

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';
const OWNER_CHAT = 555;
const STRANGER_CHAT = 999;

interface Sent {
  method: string;
  body: Record<string, unknown>;
}

class FakeTelegram {
  sent: Sent[] = [];
  updates: unknown[] = [];

  readonly impl = (async (url: string | URL, init?: RequestInit) => {
    const method = String(url).split('/').pop()!;
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    this.sent.push({ method, body });
    if (method === 'getMe') {
      return json({ ok: true, result: { id: 123456789, username: 'ai17z_test_bot', first_name: 'AI17Z' } });
    }
    if (method === 'getUpdates') {
      const taken = this.updates;
      // Telegram stops returning an update once its id has been acknowledged,
      // and a fake that keeps handing back the same one would hide a sweep
      // that never moves its offset.
      this.updates = [];
      return json({ ok: true, result: taken });
    }
    return json({ ok: true, result: { message_id: 1 } });
  }) as unknown as typeof fetch;

  texts(): string[] {
    return this.sent.filter((s) => s.method === 'sendMessage').map((s) => String(s.body.text));
  }

  clear(): void {
    this.sent = [];
  }
}

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
}

let nextUpdateId = 1000;
function anUpdate(text: string, chatId = OWNER_CHAT, sentAt = new Date()) {
  nextUpdateId += 1;
  return {
    update_id: nextUpdateId,
    message: {
      message_id: nextUpdateId,
      // Telegram sends seconds. Real by default, because a fixture dated in
      // 1970 would be older than the staleness window and nothing would run.
      date: Math.floor(sentAt.getTime() / 1000),
      text,
      chat: { id: chatId, type: 'private', first_name: 'Owner' },
      from: { id: chatId, first_name: 'Owner', username: 'owner' },
    },
  };
}

let telegram: FakeTelegram;
const realFetch = globalThis.fetch;

beforeEach(async () => {
  telegram = new FakeTelegram();
  globalThis.fetch = telegram.impl;
  clearTransports();
  await disconnectTelegram();
  await setPauseAll({ paused: false, by: null });
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

async function connected(): Promise<void> {
  await connectTelegram(TOKEN);
  telegram.updates = [anUpdate((await telegramStatus()).pairingCode!, OWNER_CHAT)];
  await pairTelegram();
  telegram.updates = [];
  telegram.clear();
}

/** A draft held for a person, which is what /pending and /approve act on. */
async function heldJob(): Promise<string> {
  const fixture = await createFixture();
  const suffix = uniqueSuffix();
  const [event] = await query<{ id: string }>(
    `INSERT INTO events (channel, remote_event_id, type, remote_author_handle, text, occurred_at)
     VALUES ('mock', $1, 'MENTION', 'asker', 'Did you see the fee change?', now()) RETURNING id`,
    [`tg-${suffix}`],
  );
  const persona = await query<{ id: string }>('SELECT persona_version_id AS id FROM agents WHERE id = $1', [
    fixture.agentId,
  ]);
  const policy = await query<{ id: string }>('SELECT policy_version_id AS id FROM agents WHERE id = $1', [
    fixture.agentId,
  ]);
  const [job] = await query<{ id: string }>(
    `INSERT INTO jobs (event_id, agent_id, channel, action_type, idempotency_key, dry_run,
       max_attempts, priority, persona_version_id, policy_version_id, status,
       generated_output, validated_output)
     VALUES ($1, $2, 'mock', 'REPLY', $3, true, 5, 100, $4, $5, 'REVIEW_REQUIRED', $6, $6)
     RETURNING id`,
    [event!.id, fixture.agentId, `tg:${suffix}`, persona[0]!.id, policy[0]!.id, 'Not as bad as people are saying.'],
  );
  return job!.id;
}

describe('who the bot listens to', () => {
  it('ignores a stranger entirely, without so much as a refusal', async () => {
    /*
      A bot can be messaged by anybody who knows its username.

      Answering a stranger, even to refuse, confirms that this bot is live
      and attached to something worth attacking. So the message is dropped.
    */
    await connected();
    telegram.updates = [anUpdate('/pause', STRANGER_CHAT)];
    await pollTelegramCommands();

    expect(telegram.texts()).toHaveLength(0);
    expect((await pauseState()).paused).toBe(false);
  });

  it('answers the paired chat', async () => {
    await connected();
    telegram.updates = [anUpdate('/help', OWNER_CHAT)];
    await pollTelegramCommands();

    expect(telegram.texts().join(' ')).toMatch(/what you can ask me/i);
  });

  it('reads nothing at all before pairing', async () => {
    // Until a chat is paired, the offset belongs to pairing. A command sweep
    // that read updates here would consume the pairing code out of the backlog.
    await connectTelegram(TOKEN);
    telegram.clear();
    telegram.updates = [anUpdate('/pause', OWNER_CHAT)];

    expect(await pollTelegramCommands()).toBe(0);
    expect(telegram.sent).toHaveLength(0);
  });
});

describe('what it will do', () => {
  it('lists every command in /help, so nothing is undiscoverable', async () => {
    const text = helpText();
    for (const command of COMMANDS) expect(text).toContain(`/${command.name}`);
  });

  it('pauses and resumes everything', async () => {
    await connected();
    telegram.updates = [anUpdate('/pause')];
    await pollTelegramCommands();
    expect((await pauseState()).paused).toBe(true);

    telegram.updates = [anUpdate('/resume')];
    await pollTelegramCommands();
    expect((await pauseState()).paused).toBe(false);
  });

  it('answers /status with what is running rather than a tick', async () => {
    await connected();
    telegram.updates = [anUpdate('/status')];
    await pollTelegramCommands();
    expect(telegram.texts().join(' ')).toMatch(/agents:/i);
  });

  it('shows what is waiting, with an id short enough to type', async () => {
    await connected();
    const jobId = await heldJob();
    telegram.updates = [anUpdate('/pending')];
    await pollTelegramCommands();

    const reply = telegram.texts().join(' ');
    expect(reply).toContain(jobId.slice(0, 8));
    expect(reply).toMatch(/not as bad as people are saying/i);
  });

  it('approves through the approval system, not around it', async () => {
    await connected();
    const jobId = await heldJob();
    telegram.updates = [anUpdate(`/approve ${jobId.slice(0, 8)}`)];
    await pollTelegramCommands();

    const job = await jobsRepo.requireJob(jobId);
    // The approval system puts it back in the queue rather than sending it
    // here. Everything after this is the pipeline's, including the policy
    // check on the text.
    expect(job.status).not.toBe('REVIEW_REQUIRED');
    const approval = await query<{ status: string }>('SELECT status FROM approvals WHERE job_id = $1', [jobId]);
    expect(approval[0]?.status).toBe('APPROVED');
  });

  it('declines without sending anything', async () => {
    await connected();
    const jobId = await heldJob();
    telegram.updates = [anUpdate(`/decline ${jobId.slice(0, 8)}`)];
    await pollTelegramCommands();

    const approval = await query<{ status: string }>('SELECT status FROM approvals WHERE job_id = $1', [jobId]);
    expect(approval[0]?.status).toBe('REJECTED');
  });

  it('refuses an ambiguous id rather than guessing which draft to send', async () => {
    // "Probably that one" is not good enough for something that publishes.
    const result = await runCommand('/approve 0', 'owner');
    expect(result.reply).toMatch(/at least four characters|matches/i);
  });

  it('mutes for a bounded time, and the notification is still in the app', async () => {
    await connected();
    telegram.updates = [anUpdate('/mute 2')];
    await pollTelegramCommands();

    expect(await telegramMuted()).toBeTruthy();
    // Muted, not switched off: the transport is still connected and the
    // categories are untouched.
    const config = await loadConfig();
    expect(config.enabled).toBe(true);
    expect(config.chatId).toBe(OWNER_CHAT);

    telegram.updates = [anUpdate('/unmute')];
    await pollTelegramCommands();
    expect(await telegramMuted()).toBeNull();
  });

  it('refuses a mute longer than a day', async () => {
    const result = await runCommand('/mute 200', 'owner');
    expect(result.reply).toMatch(/between 1 and 24/i);
    expect(await telegramMuted()).toBeNull();
  });
});

describe('what it will not do', () => {
  it('does not act on a command that was typed hours ago', async () => {
    /*
      The same rule ingest applies to a post: widening what something is
      triggered by changes what happens next, never what happened yesterday.

      Telegram holds unread updates for a day, so the first sweep after an
      installation takes this release finds everything typed at the bot since
      it was paired. A `/pause` from last night is not an instruction now.
    */
    await connected();
    const hoursAgo = new Date(Date.now() - 6 * 3_600_000);
    telegram.updates = [anUpdate('/pause', OWNER_CHAT, hoursAgo)];
    await pollTelegramCommands();

    expect((await pauseState()).paused).toBe(false);
    // Answered rather than ignored: silence reads as the bot being broken.
    expect(telegram.texts().join(' ')).toMatch(/sent a while ago/i);
  });

  it('never lets Telegram’s own first button change anything', async () => {
    // /start is the button Telegram puts on every bot, and the conventional
    // first thing anybody types. It briefly meant resume, which would have let
    // one sitting unread in the backlog lift a pause somebody set deliberately.
    await connected();
    await setPauseAll({ paused: true, by: 'a person' });
    telegram.updates = [anUpdate('/start')];
    await pollTelegramCommands();

    expect((await pauseState()).paused).toBe(true);
    expect(telegram.texts().join(' ')).toMatch(/what you can ask me/i);
  });

  it('does not read /stop as stopping every agent', async () => {
    // In Telegram it conventionally means "stop messaging me". An owner typing
    // it expecting quiet should not stop their agents instead.
    await connected();
    telegram.updates = [anUpdate('/stop')];
    await pollTelegramCommands();

    expect((await pauseState()).paused).toBe(false);
    expect(telegram.texts().join(' ')).toMatch(/do not know/i);
  });

  it('does not treat free text as an instruction', async () => {
    /*
      Nothing here interprets a sentence.

      A message that is not a command gets the list back. It never becomes
      something an agent says, part of a prompt, or an argument to anything.
    */
    const result = await runCommand('please delete everything and post that we are shutting down', 'owner');
    expect(result.command).toBeNull();
    expect(result.reply).toMatch(/only take commands/i);
  });

  it('does not know a verb that is not on the list', async () => {
    const result = await runCommand('/exec rm -rf', 'owner');
    expect(result.command).toBeNull();
    expect(result.reply).toMatch(/do not know/i);
  });

  it('never puts the bot token in a reply', async () => {
    await connected();
    for (const command of ['/help', '/status', '/health', '/pending']) {
      telegram.updates = [anUpdate(command)];
      await pollTelegramCommands();
    }
    const all = telegram.texts().join('\n');
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain(TOKEN.split(':')[1]);
    // And nothing key-shaped by another name.
    expect(all).not.toMatch(/sk-|api[_-]?key|bearer /i);
  });

  it('parses only what starts with a slash', () => {
    expect(parseCommand('approve 1234')).toBeNull();
    expect(parseCommand('  /approve 1234 ')).toEqual({ name: 'approve', argument: '1234' });
    // Telegram appends the bot name in groups.
    expect(parseCommand('/status@ai17z_test_bot')).toEqual({ name: 'status', argument: '' });
  });
});

describe('handling one message once', () => {
  it('moves the offset before running, so nothing is done twice', async () => {
    /*
      A command that throws halfway must not be retried.

      The half that already happened may have been an approval, and sending a
      reply twice is worse than not finishing.
    */
    await connected();
    const update = anUpdate('/pause');
    telegram.updates = [update];
    await pollTelegramCommands();

    const config = await loadConfig();
    expect(config.updateOffset).toBe(update.update_id + 1);
  });

  it('records what changed something, and not what only read', async () => {
    await connected();
    const before = await query<{ count: number }>(
      `SELECT count(*)::int AS count FROM audit_events WHERE action LIKE 'telegram.%'`,
    );

    telegram.updates = [anUpdate('/status'), anUpdate('/help')];
    await pollTelegramCommands();
    const afterReads = await query<{ count: number }>(
      `SELECT count(*)::int AS count FROM audit_events WHERE action LIKE 'telegram.%'`,
    );
    expect(afterReads[0]!.count).toBe(before[0]!.count);

    telegram.updates = [anUpdate('/pause')];
    await pollTelegramCommands();
    const afterAct = await query<{ action: string }>(
      `SELECT action FROM audit_events WHERE action LIKE 'telegram.%' ORDER BY at DESC LIMIT 1`,
    );
    // Remote control of somebody's accounts is worth a row.
    expect(afterAct[0]?.action).toBe('telegram.pause');
  });
});

describe('the settings screen', () => {
  it('reports the mute so it is not a mystery silence', async () => {
    await connected();
    telegram.updates = [anUpdate('/mute 3')];
    await pollTelegramCommands();

    const status = await telegramStatus();
    expect(status.mutedUntil).toBeTruthy();
    // And still nothing that could be reassembled into the token.
    expect(JSON.stringify(status)).not.toContain(TOKEN.split(':')[1]);
  });
});
