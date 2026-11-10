import { beforeEach, describe, expect, it } from 'vitest';
import { defaultPermission } from '@xbam/shared/contracts';
import { telegramAdapter } from '@xbam/channels';
import { registerTelegramCapabilities } from '@xbam/runtime';
import { TOOLPACKS, getCapability, listCapabilities, listModelCallable, resetCapabilitiesForTest } from '@xbam/tools';

beforeEach(() => {
  resetCapabilitiesForTest();
  registerTelegramCapabilities();
});

describe('the Telegram capability boundary', () => {
  it('pins exactly what a model may reach for', () => {
    // Adding one is meant to fail this test. There is no telegram.reply and no
    // telegram.send: replying is a pipeline action behind the REPLY grant, not a
    // thing a model can decide to do to a group on its own initiative. There is
    // no read_message or read_history either, because the Bot API has neither.
    expect(listModelCallable().map((c) => c.id)).toEqual(['telegram.react', 'telegram.read_chat']);
  });

  it('keeps every id in one family', () => {
    for (const capability of listCapabilities()) expect(capability.id).toMatch(/^telegram\.[a-z_]+$/);
  });

  it('declares the reaction as a write that is off until an owner turns it on', () => {
    const react = getCapability('telegram.react')!;
    expect(react).toMatchObject({ effect: 'WRITE', unsetPermission: 'DISABLED' });
    const read = getCapability('telegram.read_chat')!;
    expect(read).toMatchObject({ effect: 'READ', risk: 'LOW' });
    expect(defaultPermission(read.effect, read.risk)).not.toBe('DISABLED');
  });

  it('takes a chat id and a message reference, and refuses what is ambiguous', () => {
    const chat = getCapability('telegram.read_chat')!.input;
    expect(chat.safeParse({ chat: '-1001234567890' }).success).toBe(true);
    expect(chat.safeParse({ chat: '@somegroup' }).success).toBe(false);
    expect(chat.safeParse({ chat: 'Builders' }).success).toBe(false);
    const react = getCapability('telegram.react')!.input;
    expect(react.safeParse({ message: 'telegram:-1001234567890:50', reaction: '🔥' }).success).toBe(true);
    // A bare message id is only unique inside one chat.
    expect(react.safeParse({ message: '50', reaction: '🔥' }).success).toBe(false);
    expect(react.safeParse({ message: 'telegram:-1001234567890:0', reaction: '🔥' }).success).toBe(false);
    // The list of reactions is closed.
    expect(react.safeParse({ message: 'telegram:-1001234567890:50', reaction: '💣' }).success).toBe(false);
  });

  it('says why it cannot run, and refuses to act outside a job', async () => {
    const base = { agentId: 'a', config: {}, logger: console as never };
    const read = await getCapability('telegram.read_chat')!.readiness!({ ...base, jobId: null, accountId: null });
    expect(read.status).toBe('UNAVAILABLE');
    const react = await getCapability('telegram.react')!.readiness!({ ...base, jobId: null, accountId: 'acct' });
    expect(react.status).toBe('UNAVAILABLE');
    expect(react.why).toMatch(/inside a job/);
  });

  it('has a pack of its own whose summary does not promise a reply', () => {
    const pack = TOOLPACKS.find((entry) => entry.id === 'telegram');
    expect(pack?.prefixes).toEqual(['telegram.']);
    expect(pack?.summary).toMatch(/replying is set on the account/);
  });

  it('is a channel with a reply and a reaction and no browser', () => {
    expect(telegramAdapter.requiresBrowser).toBe(false);
    expect(telegramAdapter.capabilities).toEqual(['REPLY', 'REACT']);
  });
});
