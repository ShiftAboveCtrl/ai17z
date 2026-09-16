import { describe, expect, it } from 'vitest';
import { actions as actionsRepo, events as eventsRepo, jobs as jobsRepo, query } from '@xbam/database';
import { explainRehearsal, ingestNormalizedEvent, rehearse } from '@xbam/runtime';
import { installHarness, mockEvent } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { drainAgentJobs } from '../support/runner';

installHarness();

/**
 * The Response Lab.
 *
 * Against a real database, because the two properties that matter are
 * properties of rows. Nothing may be published, and a second rehearsal of the
 * same post must not be swallowed by the index that exists to stop a post being
 * answered twice.
 *
 * The explanation is checked for the thing that makes it worth having: it is
 * assembled from the rows a real reply writes, so an owner reading it is
 * reading what actually happened rather than a second account of it.
 */

async function labAgent() {
  return createFixture({
    policy: { engagement: { strategy: 'ALWAYS_REPLY' } as never },
    model: 'mock-echo',
  });
}

describe('rehearsing without publishing', () => {
  it('queues a job that is a dry run', async () => {
    const fixture = await labAgent();
    const run = await rehearse({
      agentId: fixture.agentId,
      subject: { channel: 'mock', authorHandle: 'someone', text: 'What do you make of this?' },
    });

    const job = await jobsRepo.requireJob(run.jobId);
    expect(job.dryRun).toBe(true);
  });

  it('performs no real action, whatever the pipeline decides', async () => {
    const fixture = await labAgent();
    const run = await rehearse({
      agentId: fixture.agentId,
      subject: { channel: 'mock', authorHandle: 'someone', text: 'Say something back to me.' },
    });
    await drainAgentJobs(fixture.agentId);

    const performed = await actionsRepo.listJobActions(run.jobId);
    // Every action on this job is a rehearsal. DRY_RUN is the status the
    // execute step writes when it stops before the remote call.
    for (const action of performed) expect(action.status).toBe('DRY_RUN');
    expect(performed.every((action) => action.status !== 'EXECUTED')).toBe(true);
  });

  it('does not record the post as seen, so the real mention still gets through', async () => {
    /*
      A rehearsal is not a sighting.

      `events (channel, account, remote_event_id)` is unique, which is what stops
      four radar monitors answering one post four times. Borrowing the post's own
      id for a rehearsal would turn that guarantee against the owner: trying an
      agent against a post would silently suppress the real mention arriving an
      hour later.
    */
    const fixture = await labAgent();
    const postId = '1999000000000000001';
    await rehearse({
      agentId: fixture.agentId,
      subject: { channel: 'x', remoteId: postId, authorHandle: 'someone', text: 'A real post.' },
    });

    const real = await ingestNormalizedEvent({
      accountId: null,
      onlyAgentId: fixture.agentId,
      event: mockEvent('A real post.', { remoteEventId: postId }),
    });
    expect(real.jobs.length).toBeGreaterThan(0);
  });

  it('can rehearse the same post more than once', async () => {
    // The mirror of the above. An owner editing a persona tries the same post
    // repeatedly, and a lab that answered only the first time would look broken.
    const fixture = await labAgent();
    const subject = {
      channel: 'x' as const,
      remoteId: '1999000000000000002',
      authorHandle: 'someone',
      text: 'The same post, twice.',
    };
    const first = await rehearse({ agentId: fixture.agentId, subject });
    const second = await rehearse({ agentId: fixture.agentId, subject });
    expect(second.jobId).not.toBe(first.jobId);
  });

  it('refuses when the agent is paused, rather than queueing something that will not run', async () => {
    const fixture = await labAgent();
    await query('UPDATE agents SET state = $2 WHERE id = $1', [fixture.agentId, 'PAUSED']);
    await expect(
      rehearse({ agentId: fixture.agentId, subject: { channel: 'mock', authorHandle: 'a', text: 'hello' } }),
    ).rejects.toThrow(/paused/i);
  });
});

describe('what fed the answer', () => {
  it('names the observable inputs and says which were absent', async () => {
    const fixture = await labAgent();
    const run = await rehearse({
      agentId: fixture.agentId,
      subject: {
        channel: 'mock',
        authorHandle: 'asker',
        text: 'Is the fee change actually a problem?',
        parentText: 'They are raising the fee to 0.3% next week.',
      },
    });
    await drainAgentJobs(fixture.agentId);

    const explained = await explainRehearsal(run.jobId);
    const byKey = new Map(explained.inputs.map((input) => [input.key, input]));

    expect(byKey.get('post')?.value).toMatch(/fee change/);
    expect(byKey.get('author')?.value).toBe('@asker');
    // The post above it travels with the rehearsal, because a reply on its own
    // frequently means nothing.
    expect(byKey.get('parent')?.present).toBe(true);
    expect(byKey.get('parent')?.value).toMatch(/0\.3%/);

    // Absent is stated, never left as a blank. "It could not read the picture"
    // and "there was no picture" are different things to be told.
    for (const input of explained.inputs) {
      expect(input.why.length).toBeGreaterThan(0);
      if (!input.present) expect(explained.gaps.join(' ')).toContain(input.name);
    }
  });

  it('reads the stages off the job’s own trace', async () => {
    const fixture = await labAgent();
    const run = await rehearse({
      agentId: fixture.agentId,
      subject: { channel: 'mock', authorHandle: 'asker', text: 'What did you think of it?' },
    });
    await drainAgentJobs(fixture.agentId);

    const explained = await explainRehearsal(run.jobId);
    expect(explained.finished).toBe(true);
    expect(explained.dryRun).toBe(true);

    const stages = new Map(explained.stages.map((stage) => [stage.key, stage]));
    // The stages that cannot not have happened, if anything happened at all.
    expect(stages.get('prompt')?.outcome).toBe('RAN');
    expect(stages.get('model')?.outcome).toBe('RAN');
    // And the one that makes this a rehearsal.
    expect(stages.get('stop')?.outcome).toBe('RAN');
    expect(stages.get('stop')?.detail.length).toBeGreaterThan(0);

    // Every stage says something. A stage that did not run says so rather than
    // rendering as an empty row somebody has to interpret.
    for (const stage of explained.stages) expect(stage.detail.length).toBeGreaterThan(0);
  });

  it('shows the draft and what would have been sent', async () => {
    const fixture = await labAgent();
    const run = await rehearse({
      agentId: fixture.agentId,
      subject: { channel: 'mock', authorHandle: 'asker', text: 'Tell me what you make of the launch.' },
    });
    await drainAgentJobs(fixture.agentId);

    const explained = await explainRehearsal(run.jobId);
    expect(explained.draft?.length ?? 0).toBeGreaterThan(0);
    expect(explained.answer?.length ?? 0).toBeGreaterThan(0);
  });

  it('explains a decision not to answer rather than showing nothing', async () => {
    /*
      Silence is a branch, not an error.

      It is also the outcome an owner least understands without the reasons
      beside it: the agent looks broken, and the job list shows a cancellation
      with no explanation attached to it.
    */
    const fixture = await createFixture({
      // A real setting, not a test-only one: an owner who has decided that only
      // something genuinely worth answering is worth answering.
      policy: { engagement: { strategy: 'SELECTIVE', minimumReplyValue: 100 } as never },
      model: 'mock-echo',
    });
    const run = await rehearse({
      agentId: fixture.agentId,
      subject: { channel: 'mock', authorHandle: 'asker', text: 'gm' },
    });
    await drainAgentJobs(fixture.agentId);

    const explained = await explainRehearsal(run.jobId);
    expect(explained.status).toBe('CANCELLED');
    expect(explained.silence).toBeTruthy();
    expect(explained.silence!.length).toBeGreaterThan(0);
    expect(explained.stages.find((stage) => stage.key === 'worth')?.outcome).toBe('DECIDED_AGAINST');
  });

  it('carries what the reader could not establish through to the answer', async () => {
    // A gap found while reading X is the owner's to see. Dropping it here would
    // mean an agent answering a reply blind looked exactly like one answering
    // with the whole thread in front of it.
    const fixture = await labAgent();
    const run = await rehearse({
      agentId: fixture.agentId,
      subject: {
        channel: 'x',
        remoteId: '1999000000000000003',
        authorHandle: 'someone',
        text: 'same',
        gaps: ['This is a reply and the post above it could not be read.'],
      },
    });

    const explained = await explainRehearsal(run.jobId);
    expect(explained.gaps.join(' ')).toMatch(/could not be read/);
  });
});

describe('the event a rehearsal writes', () => {
  it('marks itself as one, so nothing downstream mistakes it for a sighting', async () => {
    const fixture = await labAgent();
    const run = await rehearse({
      agentId: fixture.agentId,
      subject: { channel: 'mock', authorHandle: 'someone', text: 'anything' },
      requestedBy: fixture.ownerId,
    });
    const job = await jobsRepo.requireJob(run.jobId);
    const event = await eventsRepo.getEvent(job.eventId);
    expect(event?.payload.rehearsal).toBe(true);
    expect(event?.payload.origin).toBe('rehearsal');
  });
});
