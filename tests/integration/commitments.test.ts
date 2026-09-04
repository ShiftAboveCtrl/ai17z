import { describe, expect, it } from 'vitest';
import { accounts as accountsRepo, agents as agentsRepo, query, stances as stancesRepo, type CommitmentRow } from '@xbam/database';
import { DEFAULT_FOLLOW_UP_MS, canFollowUp, followUpOnCommitment, runDueFollowUps } from '@xbam/runtime';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { uniqueSuffix } from '../support/db';

installHarness();

/** An agent that can actually reply, which is what makes a promise keepable. */
async function agentThatCanFollowUp(state: 'ACTIVE' | 'PAUSED' = 'ACTIVE') {
  const fixture = await createFixture();
  const account = await accountsRepo.createAccount({
    ownerId: fixture.ownerId,
    channel: 'mock',
    handle: `promise_${uniqueSuffix()}`,
  });
  await accountsRepo.updateAccount(account.id, { status: 'CONNECTED', enabled: true });
  await accountsRepo.linkAgentAccount({
    agentId: fixture.agentId,
    accountId: account.id,
    triggerEventTypes: ['MENTION'],
    actionType: 'REPLY',
  });
  await agentsRepo.updateAgent(fixture.agentId, { state });
  return fixture;
}

const promise = async (agentId: string, over: Partial<{ dueAt: string | null; promise: string }> = {}) => {
  const id = await stancesRepo.recordCommitment({
    agentId,
    promise: over.promise ?? 'I will check this later and come back to you.',
    recipientHandle: 'alice',
    confidence: 0.7,
    dueAt: over.dueAt === undefined ? new Date(Date.now() - 60_000).toISOString() : over.dueAt,
  });
  return id!;
};

const read = async (id: string): Promise<CommitmentRow> =>
  (await query('SELECT * FROM commitments WHERE id = $1', [id]))[0] as unknown as CommitmentRow;

const backdate = (id: string) => query("UPDATE commitments SET due_at = now() - interval '1 minute' WHERE id = $1", [id]);

/**
 * An agent that says "I'll check this later" and never does is worse than one
 * that says nothing: the sentence is a small lie the system then forgets it
 * told. Commitments were detected and recorded and nothing ever read them --
 * no due date was ever set, so the index for open commitments indexed a column
 * that was always null.
 */
describe('a promise the agent made', () => {
  it('comes due, and becomes a job that runs the ordinary pipeline', async () => {
    const fixture = await agentThatCanFollowUp();
    const id = await promise(fixture.agentId);

    const [result] = await runDueFollowUps(5);
    expect(result?.commitmentId).toBe(id);
    expect(result?.jobId, result?.reason).toBeTruthy();
    expect((await read(id)).status).toBe('COMPLETED');
  });

  it('survives a restart, because it is a row and not a timer', async () => {
    // The reason for not building a scheduler: a promise held in memory is a
    // promise lost on the next deploy.
    const fixture = await agentThatCanFollowUp();
    const id = await promise(fixture.agentId, { dueAt: new Date(Date.now() + 3_600_000).toISOString() });

    // Nothing is running; the row is simply there, and still there.
    expect((await read(id)).status).toBe('OPEN');
    expect(await runDueFollowUps(5)).toEqual([]);
    await backdate(id);
    expect((await runDueFollowUps(5)).length).toBe(1);
  });

  it('is never claimed twice, however many workers arrive together', async () => {
    const fixture = await agentThatCanFollowUp();
    await promise(fixture.agentId);

    const [a, b] = await Promise.all([stancesRepo.claimDueCommitments(5), stancesRepo.claimDueCommitments(5)]);
    expect(a.length + b.length).toBe(1);
  });

  it('produces one follow-up per promise, not one per attempt', async () => {
    // The idempotency key is anchored to the commitment, so a second pass finds
    // the same job rather than sending a second message.
    const fixture = await agentThatCanFollowUp();
    const id = await promise(fixture.agentId);

    const first = (await runDueFollowUps(5))[0]!;
    await query("UPDATE commitments SET status = 'OPEN', due_at = now() - interval '1 minute' WHERE id = $1", [id]);
    const second = (await runDueFollowUps(5))[0]!;

    expect(second.jobId).toBe(first.jobId);
    expect(second.reason).toContain('already exists');
  });

  it('waits rather than giving up when the agent is paused', async () => {
    const fixture = await agentThatCanFollowUp('PAUSED');
    const id = await promise(fixture.agentId);

    await runDueFollowUps(5);
    const after = await read(id);
    expect(after.status).toBe('OPEN');
    // Put back with a future date, so it does not spin. Read as the column,
    // because this goes through `query` rather than the repository's mapper.
    const [raw] = await query<{ due_at: string | null }>('SELECT due_at FROM commitments WHERE id = $1', [id]);
    expect(new Date(raw!.due_at!).getTime()).toBeGreaterThan(Date.now());
  });

  it('gives up after enough attempts rather than retrying for ever', async () => {
    // The failure mode every reminder system has. Three tries, then FAILED with
    // the reason where somebody can see it.
    const fixture = await agentThatCanFollowUp('PAUSED');
    const id = await promise(fixture.agentId);

    for (let i = 0; i < 6; i += 1) {
      await backdate(id);
      await runDueFollowUps(5);
      if ((await read(id)).status === 'FAILED') break;
    }

    const after = await read(id);
    expect(after.status).toBe('FAILED');
    expect(after.outcome).toContain('Giving up');
  });

  it('is cancelled, not retried, when it can never be kept', async () => {
    // No account is linked, so there is nothing to follow up through. Retrying
    // that forever would be a loop with a guaranteed outcome.
    const fixture = await agentThatCanFollowUp();
    await query('DELETE FROM agent_accounts WHERE agent_id = $1', [fixture.agentId]);
    const id = await promise(fixture.agentId);

    await runDueFollowUps(5);
    const after = await read(id);
    expect(after.status).toBe('CANCELLED');
    expect(after.outcome).toContain('No account');
  });

  it('records what happened, in words, whichever way it went', async () => {
    const fixture = await agentThatCanFollowUp();
    const id = await promise(fixture.agentId);
    await runDueFollowUps(5);
    expect((await read(id)).outcome.length).toBeGreaterThan(5);
  });
});

/**
 * The brief's rule, and the right one: an agent that cannot revisit something
 * should not promise it will. Checked when the promise is made, so an
 * untrackable promise is never recorded as tracked -- a row that looks like
 * tracking and is not is worse than no row, because somebody believes it.
 */
describe('whether a promise can be kept at all', () => {
  it('says yes for an agent with an account it may reply through', async () => {
    const fixture = await agentThatCanFollowUp();
    expect((await canFollowUp(fixture.agentId)).able).toBe(true);
  });

  it('says no, and why, when there is no account', async () => {
    const fixture = await agentThatCanFollowUp();
    await query('DELETE FROM agent_accounts WHERE agent_id = $1', [fixture.agentId]);
    const verdict = await canFollowUp(fixture.agentId);
    expect(verdict.able).toBe(false);
    expect(verdict.why).toContain('No account');
  });

  it('says no for an agent that no longer exists', async () => {
    expect((await canFollowUp('00000000-0000-0000-0000-000000000000')).able).toBe(false);
  });

  it('uses hours rather than minutes, because "later" means hours', async () => {
    expect(DEFAULT_FOLLOW_UP_MS).toBeGreaterThan(60 * 60_000);
  });
});
