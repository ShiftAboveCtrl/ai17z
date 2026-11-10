import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TELEGRAM_TOKEN_PATTERN, telegramBotIdOfToken } from '@xbam/shared/contracts';
import { chatIdFromInput } from '@xbam/runtime';

/**
 * The agent channel and the owner notification transport use one API and must
 * share nothing else. These read the source, because the property is about what
 * each side is able to reach, and a runtime test can only show that it did not.
 */
const root = join(__dirname, '..', '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');
/** Code only: a comment may say what a file is not, and that is not a dependency. */
const code = (path: string) =>
  read(path)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
const channelFiles = readdirSync(join(root, 'packages/channels/src/telegram')).map((f) => `packages/channels/src/telegram/${f}`);

describe('the agent channel cannot reach the notification bot', () => {
  it('has source files to check', () => {
    expect(channelFiles.length).toBeGreaterThanOrEqual(3);
  });

  it.each(channelFiles)('%s never touches the notification transport or its settings', (path) => {
    const source = code(path);
    for (const forbidden of [
      'notifications.telegram',
      'telegramApi',
      'telegramCommands',
      'notifyTransport',
      'notifyTelegram',
      "from './telegram'",
      "from '../telegram'",
      'getSetting',
    ]) {
      expect(source, `${path} mentions ${forbidden}`).not.toContain(forbidden);
    }
  });

  it.each(['packages/runtime/src/telegram.ts', 'packages/runtime/src/telegramApi.ts', 'packages/runtime/src/telegramCommands.ts', 'packages/runtime/src/notifyTransport.ts'])(
    '%s never touches the agent channel\'s bots, groups or sends',
    (path) => {
      const source = code(path);
      for (const forbidden of ['telegram_bots', 'telegram_chats', 'telegram_outbox', 'telegramChannel', 'telegramBotGuard', '@xbam/channels']) {
        expect(source, `${path} mentions ${forbidden}`).not.toContain(forbidden);
      }
    },
  );

  it('keeps the two offsets in two places', () => {
    // The notification transport keeps its offset in a settings JSON document
    // and the agent channel on its own table. A column cannot be in both.
    expect(read('packages/runtime/src/telegram.ts')).toContain('updateOffset');
    expect(read('packages/database/src/repositories/telegramChannel.ts')).toContain('update_offset');
    expect(read('packages/database/src/repositories/telegramChannel.ts')).not.toContain('updateOffset');
  });
});

describe('bot tokens', () => {
  it('reads the bot id out of the front of a token and refuses anything else', () => {
    expect(telegramBotIdOfToken('7000000001:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw')).toBe('7000000001');
    expect(telegramBotIdOfToken('hunter2')).toBeNull();
    expect(telegramBotIdOfToken('0:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw')).toBeNull();
    expect(TELEGRAM_TOKEN_PATTERN.test('123456789:short')).toBe(false);
  });
});

describe('naming a group', () => {
  it('turns a message link from a private supergroup into its chat id', () => {
    expect(chatIdFromInput('https://t.me/c/1234567890/5')).toBe('-1001234567890');
    expect(chatIdFromInput('t.me/c/1234567890/7/9')).toBe('-1001234567890');
    expect(chatIdFromInput(' -1001234567890 ')).toBe('-1001234567890');
    expect(chatIdFromInput('-4455')).toBe('-4455');
  });

  it('refuses a person\'s id, a name, and anything that is not an id', () => {
    for (const bad of ['1234567890', '@builders', 'https://t.me/builders/5', 'Builders', '', '-0', '-12abc']) {
      expect(() => chatIdFromInput(bad), bad).toThrow(/chat id/);
    }
  });
});
