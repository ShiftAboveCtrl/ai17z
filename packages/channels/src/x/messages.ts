import type { XAuthor, XInbox, XDirectMessageThread } from '@xbam/shared/contracts';
import { PipelineError } from '@xbam/shared';
import type { ChannelContext } from '../contract';
import { SEL } from './selectors';
import { goto, settle, withSession, type Page } from './page';

/**
 * The direct message inbox, read and never written.
 *
 * There is no send in this file and there is not meant to be one. A reply on a
 * timeline is a public act somebody can see and answer in the open; a direct
 * message is a private one, sent to an inbox with no audience to correct it,
 * and `docs/ENGINEERING.md` already refuses to let an agent open conversations
 * with strangers to make coverage look green. An agent that can read its own
 * inbox can tell its owner what is in it, which is the useful half.
 *
 * Reading is HIGH risk on purpose, so the permission model asks the owner
 * rather than allowing it the way it allows a public read. Private
 * correspondence between other people ends up in a prompt otherwise, and the
 * owner is the only one who can say whether that is wanted.
 */

/** How far down the conversation list the reader will go. */
const MAX_SCROLL_PASSES = 4;
const SCROLL_PIXELS = 1_400;

/** The ceiling on one read of either surface. */
const MAX_THREADS = 30;
const MAX_MESSAGES = 40;

/** One conversation row, as the list rendered it. */
export interface ConversationRow {
  conversationId: string;
  handles: string[];
  names: string[];
  text: string;
  at: string | null;
}

/**
 * Turns conversation rows into threads.
 *
 * Pure, so fixtures can pin the one thing that is easy to get wrong: the row's
 * text runs the participants, the timestamp and the preview together in a
 * single `innerText`, and taking the whole of it as "the last message" puts the
 * other person's display name inside the message they sent.
 */
export function toThreads(rows: ConversationRow[]): XDirectMessageThread[] {
  const seen = new Set<string>();
  const threads: XDirectMessageThread[] = [];
  for (const row of rows) {
    if (!row.conversationId || seen.has(row.conversationId)) continue;
    seen.add(row.conversationId);

    const participants: XAuthor[] = [];
    const already = new Set<string>();
    row.handles.forEach((handle, index) => {
      const clean = handle.replace(/^@+/, '');
      if (!clean || already.has(clean.toLowerCase())) return;
      already.add(clean.toLowerCase());
      const displayName = row.names[index]?.split('\n')[0]?.trim();
      participants.push({ handle: clean, ...(displayName ? { displayName } : {}) });
    });

    // The preview is the last line X rendered. Everything above it is the
    // participant block and the timestamp, which are already recorded.
    const lines = row.text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const preview = lines[lines.length - 1];

    threads.push({
      conversationId: row.conversationId,
      participants,
      ...(preview ? { lastMessage: preview } : {}),
      ...(row.at ? { lastAt: row.at } : {}),
    });
  }
  return threads;
}

/** Who has been in touch, without opening anything. */
export async function readInbox(ctx: ChannelContext, request: { limit?: number } = {}): Promise<XInbox> {
  const limit = Math.min(Math.max(request.limit ?? 10, 1), MAX_THREADS);

  return withSession(ctx, 'RESEARCH', async (session) => {
    await goto(session.page, 'https://x.com/messages');
    await settle();

    let rows = await readConversationRows(session.page, limit * 2);
    for (let pass = 0; pass < MAX_SCROLL_PASSES && rows.length < limit; pass += 1) {
      const before = rows.length;
      await session.page.mouse.wheel(0, SCROLL_PIXELS).catch(() => undefined);
      await session.page.waitForTimeout(600);
      rows = [...rows, ...(await readConversationRows(session.page, limit * 2))];
      if (rows.length <= before) break;
    }

    const threads = toThreads(rows);
    return { threads: threads.slice(0, limit), more: threads.length > limit };
  });
}

/**
 * One conversation, oldest message first.
 *
 * Deliberately separate from the inbox. Listing who has been in touch is a much
 * smaller claim on somebody's privacy than reading what they said, and an owner
 * who is happy with the first is not thereby happy with the second.
 */
export async function readConversation(
  ctx: ChannelContext,
  request: { conversationId: string; limit?: number },
): Promise<{ conversationId: string; messages: { text: string; fromUs: boolean; sentAt?: string }[]; truncated: boolean }> {
  const id = request.conversationId.trim();
  if (!/^[0-9-]{3,64}$/.test(id)) {
    throw PipelineError.permanent('bad_conversation_id', `"${request.conversationId}" is not a conversation id.`);
  }
  const limit = Math.min(Math.max(request.limit ?? 20, 1), MAX_MESSAGES);

  return withSession(ctx, 'RESEARCH', async (session) => {
    await goto(session.page, `https://x.com/messages/${id}`);
    await settle();

    const entries = await session.page
      .locator(SEL.messageEntry)
      .evaluateAll(
        (nodes, max) =>
          nodes.slice(-max).map((node) => {
            const el = node as HTMLElement;
            // X marks the sender by which side the bubble sits on, expressed as
            // the flex alignment of the row. `justify-content: flex-end` is
            // ours. There is no test id for it, and guessing from the text is
            // how a quote of somebody else becomes something we said.
            const style = el.ownerDocument.defaultView?.getComputedStyle(el);
            const align = style?.justifyContent ?? '';
            return {
              text: el.innerText ?? '',
              fromUs: align.includes('end'),
              sentAt: el.querySelector('time')?.getAttribute('datetime') ?? null,
            };
          }),
        limit,
      )
      .catch(() => [] as { text: string; fromUs: boolean; sentAt: string | null }[]);

    const messages = entries
      .map((entry) => ({
        text: entry.text.replace(/\s+/g, ' ').trim(),
        fromUs: entry.fromUs,
        ...(entry.sentAt ? { sentAt: entry.sentAt } : {}),
      }))
      .filter((message) => message.text.length > 0);

    return { conversationId: id, messages, truncated: messages.length >= limit };
  });
}

/** Every conversation row currently in the DOM, in one evaluation. */
async function readConversationRows(
  page: Page,
  max: number,
): Promise<ConversationRow[]> {
  return page
    .locator(SEL.dmConversation)
    .evaluateAll(
      (nodes, limit) =>
        nodes.slice(0, limit).map((node) => {
          const el = node as HTMLElement;
          const links = Array.from(el.querySelectorAll('a[role="link"]')) as HTMLAnchorElement[];
          const handles: string[] = [];
          const names: string[] = [];
          for (const link of links) {
            const match = /^\/([A-Za-z0-9_]{1,15})$/.exec(link.getAttribute('href') ?? '');
            if (!match) continue;
            handles.push(match[1]!);
            names.push(link.innerText ?? '');
          }
          // The row's own test id carries the conversation id X uses in its
          // urls, which is what makes a follow-up read reach the same thread.
          const testId = el.getAttribute('data-testid') ?? '';
          const own = /conversation-(.+)$/.exec(testId)?.[1] ?? '';
          const linked = /^\/messages\/([0-9-]+)/.exec(
            (el.querySelector('a[href^="/messages/"]') as HTMLAnchorElement | null)?.getAttribute('href') ?? '',
          )?.[1];
          return {
            conversationId: own || linked || '',
            handles,
            names,
            text: el.innerText ?? '',
            at: el.querySelector('time')?.getAttribute('datetime') ?? null,
          };
        }),
      max,
    )
    .catch(() => [] as ConversationRow[]);
}
