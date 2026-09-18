import { beforeAll, describe, expect, it } from 'vitest';
import { bootstrapRuntime, shortlistCapabilities, familyOf, taskText, SHORTLIST_LIMIT, zodToDescription } from '@xbam/runtime';
import { listModelCallable, renderMenu, type AnyCapability } from '@xbam/tools';

/**
 * Which capabilities a model is shown for one task.
 *
 * The loop offered everything the owner had not switched off, which was right
 * at a dozen capabilities and wrong at seventy-three: the menu measured 20,535
 * characters against a 3,010-character prompt.
 *
 * Measured on a live agent with the loop enabled, that produced no capability
 * call at all. Asked the time in Tokyo it ran a web search and answered "I
 * don't know" while `time.now` was in the menu; asked whether its browser was
 * working it called nothing while `agent.diagnostics` was in the menu. The
 * mechanism worked. The model could not find the line that mattered.
 */

let all: AnyCapability[];

beforeAll(async () => {
  await bootstrapRuntime();
  all = listModelCallable();
});

const menuSize = (capabilities: AnyCapability[]) =>
  capabilities.length === 0 ? 0 : renderMenu(capabilities, (c) => zodToDescription(c.input)).length;

describe('the shortlist a task actually gets', () => {
  it('offers the clock for a question about the time', () => {
    const list = shortlistCapabilities(all, 'quick one: what is the actual date and time right now in Tokyo?');
    expect(list.offered.map((c) => c.id)).toContain('time.now');
    // The failure this fixes: the answer was in the menu and could not be found.
    expect(list.offered.length).toBeLessThanOrEqual(SHORTLIST_LIMIT);
  });

  it('offers its own diagnostics when asked whether it is working', () => {
    const list = shortlistCapabilities(all, 'is your browser session actually working, or are you flying blind?');
    expect(list.offered.map((c) => c.id)).toContain('agent.diagnostics');
  });

  it('offers repository reads for a question about a repository', () => {
    const list = shortlistCapabilities(all, 'what changed in ShiftAboveCtrl/ai17z this week?');
    expect(list.families).toContain('github');
  });

  it('offers memory for a question about what it remembers', () => {
    const list = shortlistCapabilities(all, 'what do you remember about Alice?');
    expect(list.offered.map((c) => c.id)).toContain('memory.search');
  });

  it('offers X reads for a question about somebody posting', () => {
    // "posting" is the word people use, and matching only "post" offered
    // nothing at all for this.
    const list = shortlistCapabilities(all, 'what has @foo been posting lately?');
    expect(list.families).toContain('x');
    expect(list.offered.some((c) => c.id.startsWith('x.read'))).toBe(true);
  });

  /*
    Banter needs no catalogue.

    Offering nothing is the right answer and the cheap one: the model answers
    directly, and the prompt carries no menu at all.
  */
  it('offers nothing at all for banter', () => {
    for (const task of ['nice one', 'ha, fair enough', 'gm']) {
      expect(shortlistCapabilities(all, task).offered).toHaveLength(0);
    }
  });

  it('never shows more than the limit', () => {
    for (const task of ['price of SOL and ethereum gas and github releases and the time', 'everything']) {
      expect(shortlistCapabilities(all, task).offered.length).toBeLessThanOrEqual(SHORTLIST_LIMIT);
    }
  });

  /*
    A question wants reading.

    The family somebody names contains writes as well, and `x.like` sorted to
    the top of "what has @foo been posting" purely for being in it. Ordering,
    not a ban: the model may still be offered a write when little else matches.
  */
  it('puts reading above writing for a question', () => {
    const list = shortlistCapabilities(all, 'what has @foo been posting lately?');
    expect(list.offered.every((c) => c.effect === 'READ')).toBe(true);
  });

  it('says what it narrowed, so an owner can tell nobody-wanted-it from never-saw-it', () => {
    const list = shortlistCapabilities(all, 'what is the price of SOL right now?');
    expect(list.considered).toBe(all.length);
    expect(list.families.length).toBeGreaterThan(0);
  });
});

describe('the size of what the model reads', () => {
  it('is a fraction of the whole catalogue', () => {
    const whole = menuSize(all);
    expect(whole).toBeGreaterThan(15_000);

    for (const task of [
      'what is the date and time in Tokyo?',
      'is your browser working?',
      'what changed in the repo?',
      'what do you remember about Alice?',
    ]) {
      const narrowed = menuSize(shortlistCapabilities(all, task).offered);
      expect(narrowed).toBeLessThan(whole / 5);
    }
  });
});

describe('families', () => {
  it('reads the family off the id', () => {
    expect(familyOf('x.read_post')).toBe('x');
    expect(familyOf('time.now')).toBe('time');
    expect(familyOf('nodots')).toBe('nodots');
  });
});

describe('what the shortlist is judged against', () => {
  /*
    The menu comes from the question, and from nothing else.

    `taskText` used to append the first system message, on the reasoning that it
    frames the job. On a fixture the system layer is a sentence and it does no
    harm. On a real job it is the assembled persona, measured at 3,767
    characters against a fifty-character question and listing every subject the
    agent writes about. The shortlist stopped answering "what was asked" and
    started answering "what does this agent care about", which is the same for
    every message it will ever receive.
  */
  const PERSONA = [
    'You are an AI17Z agent. You write about autonomous agents, agent memory,',
    'local-first software, open source, browser automation, model providers and',
    'routing, workers, jobs and queues, retries, idempotency and recovery. You',
    'follow the repository ShiftAboveCtrl/ai17z and read its releases and its',
    'activity. You have discussed markets, tokens, contract addresses and',
    'liquidity with people before.',
  ].join(' ');

  it('is the last thing the person said, and only that', () => {
    expect(
      taskText([
        { role: 'system', content: PERSONA },
        { role: 'user', content: 'what time is it?' },
        { role: 'assistant', content: 'Let me look.' },
        { role: 'user', content: 'what time is it where you are right now, actually' },
      ]),
    ).toBe('what time is it where you are right now, actually');
  });

  it('offers the clock for a question about the time', () => {
    const offered = shortlistCapabilities(all, 'what time is it where you are right now, actually').offered;
    expect(offered.map((c) => c.id)).toContain('time.now');
  });

  /*
    The measurement behind the fix, kept as a test so the reason survives.

    This asserts the failure the old task text produced: against the real
    registry, the persona alone pushes the clock off a menu of eight. If this
    ever stops being true the comment above is no longer describing anything,
    and somebody should find out why before trusting it.
  */
  it('is measurably wrong if the persona is mixed in', () => {
    const question = 'what time is it where you are right now, actually';
    const polluted = shortlistCapabilities(all, `${question} ${PERSONA}`).offered.map((c) => c.id);
    expect(polluted).not.toContain('time.now');
  });
});

describe('the menu comes from the question, not from the prompt around it', () => {
  /*
    The second half of the same defect, and the one that actually shipped.

    Dropping the system layer was necessary and not sufficient. The prompt's
    *user* layer is not a question either: it is memory, evidence, the sender,
    the task framing and the output rules, assembled around one line of incoming
    text. Measured on the installed build after the first fix, asked "what time
    is it where you are right now, actually", the trace recorded eight X reads
    offered and still no clock, because the framing says reply, message, channel
    and names a handle.

    So the caller passes what was asked. This pins the difference.
  */
  const ASSEMBLED_USER_LAYER = [
    'WHAT YOU REMEMBER',
    'An old AI agent emailed. Bring these up only where they actually bear on what is being said.',
    '',
    'LOOKED UP JUST NOW',
    'Could not check: what time is it where you are right now, actually?.',
    '',
    'EVIDENCE',
    '1 lookup(s) were tried and did not work. Say plainly that you do not know.',
    '',
    'FROM',
    '@kinggavii',
    '',
    'INCOMING MESSAGE:',
    'what time is it where you are right now, actually',
    '',
    'TASK',
    'Write one Mock channel reply, as Shift, to @kinggavii. They are speaking to you.',
    'Answer them, address them, not a third party.',
    '',
    'OUTPUT RULES',
    '- Stay under 280 characters.',
    '- One or two sentences. Do not end with a question unless it is the actual point.',
    '- No surrounding quotation marks, no preamble, no sign-off.',
  ].join('\n');

  it('offers the clock when it is given the question', () => {
    const offered = shortlistCapabilities(all, 'what time is it where you are right now, actually').offered;
    expect(offered.map((c) => c.id)).toContain('time.now');
  });

  /*
    What the user layer costs, stated as a ranking rather than as an absence.

    An earlier version of this asserted the clock disappears entirely from a
    reconstructed prompt. It does not, and the reconstruction is why: this
    fixture names the time twice, in the failed-lookup line and in the incoming
    message, where the real prompt carries far more around it. Asserting a
    disappearance that depends on how faithfully somebody paraphrased a prompt
    is a test that measures the fixture.

    The ranking is the honest claim and it is the one that matters: given the
    question the clock is first, and given the whole layer it is buried under
    reads for words that belong to the framing rather than to what was asked.
  */
  it('buries it under the framing when it is given the whole user layer', () => {
    const asked = shortlistCapabilities(all, 'what time is it where you are right now, actually').offered;
    const framed = shortlistCapabilities(all, ASSEMBLED_USER_LAYER).offered;

    expect(asked[0]!.id).toBe('time.now');
    expect(framed.findIndex((c) => c.id === 'time.now')).toBeGreaterThan(0);
  });
});
