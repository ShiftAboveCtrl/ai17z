import { describe, expect, it } from 'vitest';
import { classifyNotification, othersCount, toNotifications, type NotificationCell } from '@xbam/channels';

/**
 * Reading X's notifications surface.
 *
 * The classification is the whole of the behaviour and there is no test id
 * behind it -- X writes a sentence, and what kind of thing happened is in the
 * verb. So these are the sentences X actually renders, and the cases that
 * matter are the overlapping ones: a quote is also a repost in X's vocabulary,
 * and "liked your reply" contains both a like and a reply.
 */

const cell = (over: Partial<NotificationCell>): NotificationCell => ({
  text: '',
  handles: [],
  names: [],
  statusHref: null,
  occurredAt: null,
  ...over,
});

describe('what X said happened', () => {
  it('reads the verb, not the noun', () => {
    expect(classifyNotification('alice followed you')).toBe('FOLLOW');
    expect(classifyNotification('alice liked your post')).toBe('LIKE');
    expect(classifyNotification('alice reposted your post')).toBe('REPOST');
    expect(classifyNotification('alice quoted your post')).toBe('QUOTE');
    expect(classifyNotification('alice mentioned you')).toBe('MENTION');
    expect(classifyNotification('Replying to @you')).toBe('REPLY');
  });

  it('prefers the more specific claim where two verbs overlap', () => {
    // A quote is a repost with something added, and X's sentence for it says
    // both. Reading it as a plain repost loses the part that was written.
    expect(classifyNotification('alice quoted your post and reposted it')).toBe('QUOTE');
    // "liked your reply" is a like, about a reply. Ranking REPLY first would
    // turn every like on a reply into somebody having answered.
    expect(classifyNotification('alice liked your reply')).toBe('LIKE');
  });

  it('will not guess at something it has not seen', () => {
    // X adds kinds without warning. A new one silently read as a like is a
    // wrong fact an agent then states in its own voice.
    expect(classifyNotification('alice sent you a Super Follow request')).toBe('OTHER');
    expect(classifyNotification('There was a live broadcast you might like')).toBe('OTHER');
  });
});

describe('how many people a notification is about', () => {
  it('counts the ones X did not name', () => {
    expect(othersCount('alice and 4 others liked your post')).toBe(4);
    expect(othersCount('alice and 1,204 others liked your post')).toBe(1204);
    expect(othersCount('alice and another liked your post')).toBe(1);
  });

  it('says nothing when the sentence named everybody', () => {
    expect(othersCount('alice liked your post')).toBeUndefined();
  });
});

describe('turning cells into notifications', () => {
  it('keeps the accounts X linked and counts the ones it did not', () => {
    // The aggregate case: five people liked it, one is a link and four are a
    // number. Inventing four empty authors would be inventing four people.
    const [note] = toNotifications([
      cell({
        text: 'Alice\nand 4 others liked your post',
        handles: ['alice'],
        names: ['Alice'],
        statusHref: '/me/status/1900000000000000001',
      }),
    ]);
    expect(note!.kind).toBe('LIKE');
    expect(note!.actors).toEqual([{ handle: 'alice', displayName: 'Alice' }]);
    expect(note!.others).toBe(4);
    expect(note!.statusId).toBe('1900000000000000001');
  });

  it('names one account once, however many times the cell linked it', () => {
    // A cell links the avatar and the name separately, which is the same
    // person twice.
    const [note] = toNotifications([
      cell({ text: 'Alice reposted your post', handles: ['alice', 'alice'], names: ['', 'Alice'] }),
    ]);
    expect(note!.actors).toHaveLength(1);
  });

  it('has no status id when the cell was not about a post', () => {
    const [note] = toNotifications([cell({ text: 'Alice followed you', handles: ['alice'], names: ['Alice'] })]);
    expect(note!.kind).toBe('FOLLOW');
    expect(note!.statusId).toBeUndefined();
  });

  it('drops a cell with nothing in it', () => {
    // A virtualised list renders empty placeholders while it loads. A
    // notification that says nothing is not a notification.
    expect(toNotifications([cell({ text: '   \n  ' }), cell({ text: 'Alice followed you' })])).toHaveLength(1);
  });
});
