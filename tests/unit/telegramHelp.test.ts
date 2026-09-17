import { describe, expect, it, vi } from 'vitest';
import { COMMANDS, helpText, parseCommand, publishCommands, sendMessage } from '@xbam/runtime';

/**
 * The command whose job is to explain the other ten.
 *
 * `/help` produced nothing on a real installation while `/health` worked. The
 * parser was fine and the handler ran; the message was refused by Telegram
 * before anybody saw it, because four of the eleven commands take an argument
 * and the placeholder was interpolated into HTML unescaped. Telegram parses
 * `<id>` as a start tag, answers
 * `Bad Request: can't parse entities: Unsupported start tag "id"`, and sends
 * nothing. The catch around the send logged a warning nobody reads.
 *
 * Verified against the real API before the fix: HTTP 400 with that exact
 * wording, and HTTP 200 with the placeholders escaped.
 */

/** The tags Telegram's HTML mode actually understands. */
const ALLOWED = new Set([
  'b', 'i', 'u', 's', 'a', 'code', 'pre', 'em', 'strong', 'del',
  'span', 'tg-spoiler', 'blockquote', 'tg-emoji',
]);

function tagsIn(html: string): string[] {
  return [...html.matchAll(/<\/?([A-Za-z_][A-Za-z0-9_-]*)[^>]*>/g)].map((match) => match[1]!.toLowerCase());
}

describe('the help Telegram will actually accept', () => {
  it('emits no tag Telegram does not understand', () => {
    const unsupported = [...new Set(tagsIn(helpText()))].filter((tag) => !ALLOWED.has(tag));
    expect(unsupported).toEqual([]);
  });

  it('escapes the argument placeholders rather than emitting them as markup', () => {
    const html = helpText();
    // The bug exactly: `<id>` and `<hours>` arriving as tags.
    expect(html).not.toContain('<id>');
    expect(html).not.toContain('<hours>');
    expect(html).toContain('&lt;id&gt;');
    expect(html).toContain('&lt;hours&gt;');
  });

  it('still names every command, which is the point of it', () => {
    const html = helpText();
    for (const command of COMMANDS) expect(html).toContain(`/${command.name}`);
  });

  /*
    Not the problem, and worth pinning so the next person does not start here.

    Every one of these routed correctly before the fix and after it. The parser
    was the obvious suspect and the innocent one.
  */
  it('routes the forms a person actually types', () => {
    expect(parseCommand('/help')?.name).toBe('help');
    expect(parseCommand('/help@ai17zstudio_bot')?.name).toBe('help');
    expect(parseCommand('/start')?.name).toBe('help');
    expect(parseCommand('/h')?.name).toBe('help');
    expect(parseCommand('/health')?.name).toBe('health');
    expect(parseCommand('not a command')).toBeNull();
  });
});

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('a formatting mistake is not allowed to become silence', () => {
  it('sends the words without the markup when Telegram cannot parse it', async () => {
    const calls: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push(body);
      if (calls.length === 1) {
        return reply({ ok: false, error_code: 400, description: `Bad Request: can't parse entities: Unsupported start tag "id" at byte offset 214` }, 400);
      }
      return reply({ ok: true, result: {} });
    }) as unknown as typeof fetch;

    await sendMessage('token', 42, '<b>Hi</b> <code>/show <id></code>', fetchImpl);

    expect(calls).toHaveLength(2);
    expect(calls[0]!.parse_mode).toBe('HTML');
    // The retry carries the text, with the markup gone and nothing else lost.
    expect(calls[1]!.parse_mode).toBeUndefined();
    expect(String(calls[1]!.text)).toContain('Hi');
    expect(String(calls[1]!.text)).toContain('/show');
    expect(String(calls[1]!.text)).not.toContain('<b>');
  });

  /*
    Only a parse failure is retried.

    A bad token, a blocked bot and a chat that is gone are real errors, and
    sending the same message again in plain text neither fixes them nor tells
    anybody anything.
  */
  it('does not retry an error that plain text cannot fix', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return reply({ ok: false, error_code: 401, description: 'Unauthorized' }, 401);
    }) as unknown as typeof fetch;

    await expect(sendMessage('token', 42, '<b>Hi</b>', fetchImpl)).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it('sends once when the markup is fine', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return reply({ ok: true, result: {} });
    }) as unknown as typeof fetch;

    await sendMessage('token', 42, '<b>Hi</b>', fetchImpl);
    expect(calls).toBe(1);
  });
});

describe('offering the menu to Telegram', () => {
  it('publishes the same closed list, scoped to the one paired chat', async () => {
    let sent: Record<string, unknown> | null = null;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain('/setMyCommands');
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return reply({ ok: true, result: true });
    }) as unknown as typeof fetch;

    await publishCommands(
      'token',
      42,
      COMMANDS.map((command) => ({ command: command.name, description: command.blurb })),
      fetchImpl,
    );

    const body = sent as unknown as { commands: { command: string }[]; scope: { type: string; chat_id: number } };
    expect(body.commands.map((entry) => entry.command)).toEqual(COMMANDS.map((command) => command.name));
    // Scoped, because the bot can be messaged by anybody who knows its name and
    // a menu is an invitation.
    expect(body.scope).toEqual({ type: 'chat', chat_id: 42 });
  });
});
