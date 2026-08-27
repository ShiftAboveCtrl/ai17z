import { describe, expect, it } from 'vitest';
import { EngagementPolicy, type RelationshipContext } from '@xbam/shared/contracts';
import { jobs as jobsRepo, observability } from '@xbam/database';
import { chooseIntent, decideEngagement, ingestNormalizedEvent, readTemperature, replyValue } from '@xbam/runtime';
import { installHarness, mockEvent } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { drainJobs } from '../support/runner';

installHarness();

const policy = (over: Partial<EngagementPolicy> = {}) => EngagementPolicy.parse(over);

function score(text: string, over: Partial<Parameters<typeof replyValue>[0]> = {}) {
  return replyValue({
    text,
    directlyAddressed: false,
    relationship: null,
    threadDepth: 0,
    recentRepliesToPerson: 0,
    alreadyRepliedInThread: false,
    policy: policy(),
    ...over,
  });
}

function verdict(text: string, over: Partial<Parameters<typeof decideEngagement>[0]> = {}) {
  return decideEngagement({
    text,
    directlyAddressed: false,
    relationship: null,
    threadDepth: 0,
    recentRepliesToPerson: 0,
    alreadyRepliedInThread: false,
    policy: policy(),
    ...over,
  });
}

const relationship = (over: Partial<RelationshipContext> = {}): RelationshipContext => ({
  known: true,
  handle: 'alice',
  familiarity: 'REGULAR',
  historyLine: '',
  topics: [],
  summary: null,
  ownerNote: null,
  disposition: 'NEUTRAL',
  callback: null,
  ...over,
});

describe('what makes a mention worth answering', () => {
  it('answers a direct question', () => {
    expect(verdict('What do you think about the new schedule?').decision).toBe('ENGAGE');
  });

  it('ignores a mass tag with nothing in it', () => {
    const v = verdict('@a @b @c @d @e @f check this out');
    expect(v.decision).toBe('IGNORE');
    expect(v.reason).toMatch(/tags 6 accounts/i);
  });

  it('answers a mass tag that actually asks the agent something', () => {
    // The tag count still counts against it, but a real question outweighs it.
    const v = verdict('@a @b @c @d @e what does everyone think about the unlock schedule and the timing?', {
      directlyAddressed: true,
    });
    expect(v.decision).toBe('ENGAGE');
  });

  it('ignores obvious promotion', () => {
    const v = verdict('Huge giveaway! DM me to enter, guaranteed 100x');
    expect(v.decision).toBe('IGNORE');
    expect(v.reason).toMatch(/promotional/i);
  });

  it('ignores a bare greeting', () => {
    expect(verdict('gm').decision).toBe('IGNORE');
  });

  it('does not answer a thank-you that needs no answer', () => {
    expect(verdict('thanks!').decision).toBe('IGNORE');
  });

  it('is more willing to answer somebody it knows', () => {
    const stranger = score('interesting point about the schedule');
    const regular = score('interesting point about the schedule', { relationship: relationship() });
    expect(regular.value).toBeGreaterThan(stranger.value);
  });

  it('stops answering somebody it has already answered repeatedly this hour', () => {
    const v = verdict('And another thing about the schedule which I think is important', {
      recentRepliesToPerson: 5,
    });
    expect(v.decision).toBe('IGNORE');
    expect(v.reason).toMatch(/already answered them/i);
  });

  it('backs off in a thread that has gone on a long way', () => {
    const shallow = score('what about the second point though', { threadDepth: 1 });
    const deep = score('what about the second point though', { threadDepth: 20 });
    expect(deep.value).toBeLessThan(shallow.value);
  });
});

describe('the owner chooses how selective the agent is', () => {
  it('answers everything when told to', () => {
    expect(verdict('gm', { policy: policy({ strategy: 'ALWAYS_REPLY' }) }).decision).toBe('ENGAGE');
  });

  it('answers only questions when told to', () => {
    const p = policy({ strategy: 'QUESTIONS_ONLY' });
    expect(verdict('What is the schedule?', { policy: p }).decision).toBe('ENGAGE');
    expect(verdict('This is a long and substantive statement about the schedule and its risks.', { policy: p }).decision).toBe('IGNORE');
  });

  it('asks a person rather than staying silent when told never to auto-ignore', () => {
    const v = verdict('gm', { policy: policy({ strategy: 'NEVER_AUTO_IGNORE' }) });
    expect(v.decision).toBe('REVIEW');
    expect(v.reason).toMatch(/never stays silent without asking/i);
  });

  it('lets the threshold be moved', () => {
    const text = 'interesting';
    expect(verdict(text, { policy: policy({ minimumReplyValue: 90 }) }).decision).toBe('IGNORE');
    expect(verdict(text, { policy: policy({ minimumReplyValue: 5 }) }).decision).toBe('ENGAGE');
  });
});

describe('every decision explains itself', () => {
  it('names the factor that decided it', () => {
    const v = verdict('@a @b @c @d @e @f @g look at this');
    expect(v.factors.some((f) => f.label.includes('tags'))).toBe(true);
    expect(v.reason.length).toBeGreaterThan(10);
  });

  it('carries the numbers as well as the words', () => {
    const v = verdict('What do you think?');
    expect(v.value).toBeGreaterThan(0);
    expect(v.factors.length).toBeGreaterThan(0);
  });
});

describe('reading the temperature of a message', () => {
  const cases: [string, string][] = [
    ['You are an idiot and this is a scam', 'hostile'],
    ['lol that is genuinely funny', 'joking'],
    ['What is the throughput of the api under load?', 'technical'],
    ['I do not understand what you mean by that', 'confused'],
    ['thanks, appreciate it', 'friendly'],
  ];

  for (const [text, expected] of cases) {
    it(`reads "${text.slice(0, 30)}..." as ${expected}`, () => {
      expect(readTemperature(text)).toBe(expected);
    });
  }
});

describe('choosing what kind of reply to write', () => {
  const base = { relationship: null, contradictsStance: false, hasCallback: false };

  it('answers a question', () => {
    expect(chooseIntent({ ...base, text: 'What is the schedule?', temperature: 'curious' }).intent).toBe('ANSWER');
  });

  it('does not answer a joke earnestly', () => {
    expect(chooseIntent({ ...base, text: 'lol classic', temperature: 'joking' }).intent).toBe('JOKE');
  });

  it('deflects hostility rather than escalating into it', () => {
    const decision = chooseIntent({ ...base, text: 'You are a clown and this is garbage', temperature: 'hostile' });
    // Never CHALLENGE into hostility: escalating is how an agent ends up in a
    // fight on its owner's behalf.
    expect(decision.intent).toBe('DEFLECT');
    expect(decision.intent).not.toBe('CHALLENGE');
  });

  it('disagrees when the message contradicts a position it holds', () => {
    expect(
      chooseIntent({ ...base, text: 'The schedule is fine', temperature: 'casual', contradictsStance: true }).intent,
    ).toBe('DISAGREE');
  });

  it('clarifies when somebody says they did not follow', () => {
    expect(chooseIntent({ ...base, text: 'I dont understand', temperature: 'confused' }).intent).toBe('CLARIFY');
  });

  it('acknowledges a thank-you rather than answering it', () => {
    expect(chooseIntent({ ...base, text: 'thanks for that', temperature: 'friendly' }).intent).toBe('ACKNOWLEDGE');
  });

  it('explains itself in every case', () => {
    const decision = chooseIntent({ ...base, text: 'What is the schedule?', temperature: 'curious' });
    expect(decision.reason.length).toBeGreaterThan(10);
  });
});

describe('staying silent end to end', () => {
  it('ends the job as a decision, not a failure, and says why', async () => {
    const fixture = await createFixture({ policy: { engagement: EngagementPolicy.parse({}) } });
    const outcome = await ingestNormalizedEvent({
      accountId: null,
      onlyAgentId: fixture.agentId,
      event: mockEvent('gm'),
    });

    await drainJobs();
    const job = await jobsRepo.requireJob(outcome.jobs[0]!.job.id);
    expect(job.status).toBe('CANCELLED');

    const trace = await observability.listTrace(job.id);
    const decided = trace.find((t) => t.type === 'ENGAGEMENT_DECIDED');
    expect(decided).toBeTruthy();
    expect(decided!.message).toMatch(/ignore/i);
  });

  it('answers something worth answering', async () => {
    const fixture = await createFixture({ policy: { engagement: EngagementPolicy.parse({}) } });
    const outcome = await ingestNormalizedEvent({
      accountId: null,
      onlyAgentId: fixture.agentId,
      event: mockEvent('What do you actually think about the unlock schedule?'),
    });

    await drainJobs();
    const job = await jobsRepo.requireJob(outcome.jobs[0]!.job.id);
    expect(job.status).toBe('EXECUTED');
  });
});
