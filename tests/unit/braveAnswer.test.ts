import { describe, expect, it } from 'vitest';
import { extractBraveAnswer } from '@xbam/channels';
import { whatToResearch } from '@xbam/runtime';

/**
 * Reading an answer off Brave's Ask page.
 *
 * The fixture below is the real page text, captured from a live lookup. It is
 * kept verbatim because every trap in it is one the first implementation fell
 * into: the sidebar of previously asked questions, the privacy notice, the
 * navigation, the query echoed back, the progress narration Brave leaves in
 * place when it finishes, and the interface that follows the answer.
 */

const QUERY = 'what happened with the ethereum pectra upgrade';

const PAGE = `New conversation
Ctrl + Shift + O
${QUERY}
who won the world cup
what is the price of ethereum today
Encrypted & Private History
Your chat history is encrypted and auto-deleted after 24 hours of inactivity by default. The encryption key is stored locally on your device. Brave does not retain your IP address.
Learn more
Got it
Settings
Ask
All
Images
News
Videos
Maps
Goggles
${QUERY}
Searching
Summarized the Ethereum Pectra upgrade details and its impact
Finished
+6
The Pectra upgrade activated on May 7, 2025 at epoch 364032. It combined the Prague execution-layer and Electra consensus-layer forks into one release.
Validator consolidation raised the effective balance cap from 32 to 2048 ETH, and blob capacity doubled.
ledger.com
Ethereum Pectra Upgrade: What Changed and Why It Matters
May 7, 2025
coindesk.com
Ethereum Developers Lock in May 7 for Pectra Upgrade
April 3, 2025
View all
33
Elaborate
How does EIP-7702 work?
Copy
Try again
AI-generated answer. Please verify critical facts.`;

describe('separating the answer from the page', () => {
  it('returns the prose and nothing else', () => {
    const { answer } = extractBraveAnswer(PAGE, QUERY);

    expect(answer).toContain('activated on May 7, 2025');
    expect(answer).toContain('Validator consolidation');
  });

  it('drops the progress narration Brave leaves behind', () => {
    // "Finished" sits directly after the question, so raw text hands a model a
    // status word as the opening of the answer.
    const { answer } = extractBraveAnswer(PAGE, QUERY);

    expect(answer).not.toMatch(/^Searching/);
    expect(answer).not.toContain('Finished');
    expect(answer).not.toContain('Summarized the Ethereum');
  });

  it('never returns questions somebody asked earlier', () => {
    // The sidebar is a history of previous lookups. Handing those to a model as
    // findings would be both wrong and a small privacy leak between replies.
    const { answer } = extractBraveAnswer(PAGE, QUERY);

    expect(answer).not.toContain('who won the world cup');
    expect(answer).not.toContain('what is the price of ethereum today');
  });

  it('leaves the privacy notice and the navigation out', () => {
    const { answer } = extractBraveAnswer(PAGE, QUERY);

    expect(answer).not.toContain('Encrypted & Private History');
    expect(answer).not.toContain('Goggles');
    expect(answer).not.toContain('New conversation');
  });

  it('stops before the interface that follows the answer', () => {
    const { answer } = extractBraveAnswer(PAGE, QUERY);

    expect(answer).not.toContain('Elaborate');
    expect(answer).not.toContain('Try again');
    expect(answer).not.toContain('AI-generated answer');
  });

  it('keeps the sources, so a finding can say where it came from', () => {
    const { sources } = extractBraveAnswer(PAGE, QUERY);

    expect(sources).toContain('ledger.com');
    expect(sources).toContain('coindesk.com');
  });

  it('returns nothing usable from a page that is still searching', () => {
    // The failure that made the first version fall back to snippets every time:
    // Brave holds a constant page length while it fetches, so a wait that only
    // watches for stability reads the word "Searching" as the answer.
    const stillWorking = `Settings\nAsk\n${QUERY}\nSearching\n+6\nAI-generated answer. Please verify critical facts.`;
    const { answer } = extractBraveAnswer(stillWorking, QUERY);

    expect(answer.length).toBeLessThan(80);
  });
});

describe('how the question is asked', () => {
  it('asks for the latest when the reason to look was that it changes', () => {
    const lookups = whatToResearch({
      incoming: '@agent any news on this today?',
      parent: 'Ethereum core devs have scheduled the next upgrade for the spring.',
    });

    const search = lookups.find((l) => l.kind === 'search');
    // The prefix used to be "What is the latest on: " followed by the post's
    // first sentence, which is a paste rather than a question. The recency is
    // still expressed; what it is attached to is now the subject.
    expect(search?.query).toContain('Ethereum');
    expect(search?.query).toMatch(/latest/i);
    expect(search?.query).not.toContain('core devs have scheduled');
  });

  it('does not paste half a post at an answer engine', () => {
    // A keyword engine rewards more words. An answer engine reads the query as
    // a question, and a wall of text with no question in it gets one back.
    const long = `Here is a very long post about ${'governance and fee markets '.repeat(20)}`;
    const lookups = whatToResearch({ incoming: '@agent what is this about?', parent: long });

    // A wall of text naming nothing now produces no query at all, which is the
    // stronger form of the same rule: there was never a good query to build.
    expect(lookups.find((l) => l.kind === 'search')).toBeUndefined();
  });

  it('keeps a query short even when the post is enormous', () => {
    const long = `Solana had an outage. ${'Governance and fee markets are contentious. '.repeat(20)}`;
    const search = whatToResearch({ incoming: '@agent what is this about?', parent: long }).find(
      (l) => l.kind === 'search',
    );
    expect(search).toBeTruthy();
    expect(search!.query.length).toBeLessThanOrEqual(140);
  });

  it('still looks up nothing for an ordinary reply', () => {
    // The whole point of the decision. An agent that searches before every
    // message is slow, expensive and no better at answering "nice one".
    expect(whatToResearch({ incoming: 'nice one', parent: null })).toEqual([]);
    expect(whatToResearch({ incoming: '@agent totally agree with this', parent: 'A view about fees.' })).toEqual([]);
  });
});
