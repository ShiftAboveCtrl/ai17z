import { describe, expect, it } from 'vitest';
import { contextOf, eventOf, messageUrl } from '../../packages/channels/src/telegram/normalise';

const BOT = { botId: '7000000001', botUsername: 'Agent_One_bot' };
const CHAT = -1001234567890;
const ALLOWED = new Set([String(CHAT)]);
const alice = { id: 11, first_name: 'Alice', last_name: 'A', username: 'alice' };

function update(message: Record<string, unknown>, id = 1) {
  return {
    update_id: id,
    message: {
      message_id: 50,
      date: 1_760_000_000,
      chat: { id: CHAT, type: 'supergroup', title: 'Builders' },
      from: alice,
      ...message,
    },
  };
}
const mentioning = (text: string, name = BOT.botUsername) => ({
  text,
  entities: [{ type: 'mention', offset: text.indexOf(`@${name}`), length: name.length + 1 }],
});

describe('which Telegram messages reach an agent', () => {
  it('reads a message that @mentions the bot, whatever its case', () => {
    const event = eventOf(update(mentioning('gm @agent_one_BOT what is up', 'agent_one_BOT')), BOT, ALLOWED);
    expect(event).toMatchObject({
      channel: 'telegram',
      type: 'MENTION',
      remoteEventId: `telegram:${CHAT}:50`,
      remoteMessageId: `telegram:${CHAT}:50`,
      remoteAuthorId: '11',
      remoteAuthorHandle: 'alice',
      remoteAuthorDisplayName: 'Alice A',
      remoteConversationId: `telegram:${CHAT}:50`,
      parentRemoteMessageId: null,
      remoteUrl: 'https://t.me/c/1234567890/50',
      raw: { addressedToAgent: true, addressedBy: 'mention' },
    });
  });

  it('measures a mention in UTF-16 units, so emoji before it do not move it', () => {
    const text = '🔥🔥 @Agent_One_bot hello';
    expect(eventOf(update({ text, entities: [{ type: 'mention', offset: text.indexOf('@'), length: 14 }] }), BOT, ALLOWED)).not.toBeNull();
  });

  it('reads a reply to one of the bot\'s own messages, with no mention at all', () => {
    const event = eventOf(
      update({
        text: 'and the second part?',
        reply_to_message: { message_id: 49, date: 1_759_999_900, from: { id: 7000000001, is_bot: true }, text: 'Here is the first part.' },
      }),
      BOT,
      ALLOWED,
    );
    expect(event).toMatchObject({
      type: 'REPLY',
      parentRemoteMessageId: `telegram:${CHAT}:49`,
      remoteConversationId: `telegram:${CHAT}:49`,
      raw: { addressedBy: 'reply', parent: { isSelf: true, text: 'Here is the first part.' } },
    });
  });

  it('treats a mention that is also a reply to the bot as a reply', () => {
    const event = eventOf(
      update({
        ...mentioning('@Agent_One_bot thanks'),
        reply_to_message: { message_id: 49, date: 1, from: { id: 7000000001, is_bot: true }, text: 'hi' },
      }),
      BOT,
      ALLOWED,
    );
    expect(event?.type).toBe('REPLY');
  });

  it('ignores everything that is not addressed to it', () => {
    expect(eventOf(update({ text: 'gm everyone' }), BOT, ALLOWED)).toBeNull();
    // The bot's name inside a word, without an entity, is not a mention.
    expect(eventOf(update({ text: 'ask Agent_One_bot later' }), BOT, ALLOWED)).toBeNull();
    // Another bot's mention.
    expect(eventOf(update(mentioning('hey @someone_else_bot', 'someone_else_bot')), BOT, ALLOWED)).toBeNull();
    // A reply to a person, not to the bot.
    expect(
      eventOf(update({ text: 'agreed', reply_to_message: { message_id: 40, date: 1, from: alice, text: 'x' } }), BOT, ALLOWED),
    ).toBeNull();
  });

  it('drops a group the owner did not allow, a private chat, and a channel', () => {
    const mention = mentioning('hi @Agent_One_bot');
    expect(eventOf(update({ ...mention, chat: { id: -1009999999999, type: 'supergroup', title: 'Elsewhere' } }), BOT, ALLOWED)).toBeNull();
    expect(eventOf(update({ ...mention, chat: { id: CHAT, type: 'private' } }), BOT, new Set([String(CHAT)]))).toBeNull();
    expect(eventOf(update({ ...mention, chat: { id: CHAT, type: 'channel', title: 'News' } }), BOT, ALLOWED)).toBeNull();
    expect(eventOf(update(mention), BOT, new Set())).toBeNull();
  });

  it('never answers a bot, another agent or itself', () => {
    const mention = mentioning('hi @Agent_One_bot');
    expect(eventOf(update({ ...mention, from: { id: 99, is_bot: true, username: 'other_bot' } }), BOT, ALLOWED)).toBeNull();
    expect(eventOf(update({ ...mention, from: { id: 7000000001, is_bot: true } }), BOT, ALLOWED)).toBeNull();
    expect(eventOf(update({ ...mention, via_bot: { id: 5, is_bot: true } }), BOT, ALLOWED)).toBeNull();
    expect(eventOf(update({ ...mention, from: undefined }), BOT, ALLOWED)).toBeNull();
  });

  it('does not take the topic-creation message of a forum for a reply to the bot', () => {
    const event = eventOf(
      update({
        text: 'a message in a topic the bot created',
        reply_to_message: { message_id: 3, date: 1, from: { id: 7000000001, is_bot: true }, forum_topic_created: { name: 'Q&A' } },
      }),
      BOT,
      ALLOWED,
    );
    expect(event).toBeNull();
  });

  it('reads a mention in a photo caption, and ignores a message with no words', () => {
    const caption = 'look @Agent_One_bot';
    expect(
      eventOf(update({ text: undefined, caption, caption_entities: [{ type: 'mention', offset: 5, length: 14 }] }), BOT, ALLOWED),
    ).toMatchObject({ text: caption });
    expect(eventOf(update({ text: undefined }), BOT, ALLOWED)).toBeNull();
    expect(eventOf(update({ text: '   ' }), BOT, ALLOWED)).toBeNull();
  });

  it('gives a handle to people who have no username, never an empty one', () => {
    const event = eventOf(update({ ...mentioning('hi @Agent_One_bot'), from: { id: 77, first_name: 'Quiet' } }), BOT, ALLOWED);
    expect(event).toMatchObject({ remoteAuthorHandle: 'user:77', remoteAuthorId: '77' });
  });

  it('survives a malformed update instead of throwing', () => {
    for (const bad of [null, 5, {}, { update_id: 'x' }, { update_id: 1, message: { message_id: 'no' } }]) {
      expect(eventOf(bad, BOT, ALLOWED)).toBeNull();
    }
  });

  it('links to a message the way Telegram does', () => {
    expect(messageUrl({ id: '-1001234567890' }, 9)).toBe('https://t.me/c/1234567890/9');
    expect(messageUrl({ id: '-1001234567890', username: 'builders' }, 9)).toBe('https://t.me/builders/9');
    expect(messageUrl({ id: '-4455' }, 9)).toBeNull();
  });
});

describe('the context an update carries', () => {
  it('makes the replied-to message the only earlier turn, and says so', () => {
    const event = eventOf(
      update({
        ...mentioning('@Agent_One_bot is this right?'),
        reply_to_message: { message_id: 40, date: 1_759_999_000, from: { id: 22, username: 'bob' }, text: 'ETH is a security' },
      }),
      BOT,
      ALLOWED,
    )!;
    const context = contextOf(event);
    expect(context).toMatchObject({
      targetRef: `telegram:${CHAT}:50`,
      targetAuthorHandle: 'alice',
      parentText: 'ETH is a security',
      thread: [{ role: 'INBOUND', remoteMessageId: `telegram:${CHAT}:40`, authorHandle: 'bob' }],
    });
    expect(context.conversation?.method).toBe('EVENT_ONLY');
    expect(context.conversation?.note).toMatch(/does not let a bot read a group history/);
  });

  it('marks the bot\'s own earlier message as outbound', () => {
    const event = eventOf(
      update({ text: 'more?', reply_to_message: { message_id: 49, date: 1, from: { id: 7000000001, is_bot: true }, text: 'earlier' } }),
      BOT,
      ALLOWED,
    )!;
    expect(contextOf(event).thread[0]).toMatchObject({ role: 'OUTBOUND' });
  });

  it('is the incoming message alone when nothing was replied to', () => {
    const context = contextOf(eventOf(update(mentioning('@Agent_One_bot hi')), BOT, ALLOWED)!);
    expect(context.thread).toEqual([]);
    expect(context.parentText).toBeNull();
    expect(context.conversation?.root?.remoteId).toBe(`telegram:${CHAT}:50`);
  });
});
