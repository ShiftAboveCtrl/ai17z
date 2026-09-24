import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { accounts as accountsRepo, radar as radarRepo, type RadarSourceRow } from '@xbam/database';
import { SocialRadar } from '../../apps/worker/src/radar';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { uniqueSuffix } from '../support/db';

installHarness();

/**
 * One poll that never comes back must not end all discovery.
 *
 * `tick` guards itself with a `running` flag so two ticks cannot overlap. That
 * flag has no owner but the loop, so a `pollOne` that never settles does not
 * slow the radar down -- it ends it. Every later tick returns at the first
 * line, no source is ever claimed again, and because nothing *failed*, every
 * source keeps whatever status it last had. The account goes on reporting
 * healthy monitors while nothing at all is being read.
 *
 * Found on two live installations simultaneously, running different versions,
 * which is how it was established not to be a regression in either: both
 * radars stopped claiming within ten seconds of each other and stayed stopped
 * for ninety-five minutes, every source HEALTHY with zero failures, while the
 * channel poller went on using the same browser every two minutes. Reproduced
 * on purpose by restarting one: it claimed its three direct sources, opened
 * the notifications tab, and never returned.
 *
 * The thing that hung was an evaluation against a renderer that had stopped
 * answering, which `monitorReadDeadline.test.ts` covers directly. This is the
 * floor underneath it: whatever hangs next, the loop has to live.
 */

/** A radar whose poll never settles, which is the one case that mattered. */
class NeverReturns extends SocialRadar {
  public started = 0;
  protected override async pollOne(_source: RadarSourceRow): Promise<void> {
    this.started += 1;
    // Deliberately never resolves and never rejects. A promise that never
    // settles is never rejected, which is why `.catch()` upstream was no
    // protection at all.
    return new Promise<void>(() => {});
  }
}

/** A radar that polls normally, to prove the deadline is not always firing. */
class ReturnsAtOnce extends SocialRadar {
  public started = 0;
  protected override async pollOne(_source: RadarSourceRow): Promise<void> {
    this.started += 1;
  }
}

async function connectedSource(kind: 'notifications' | 'mention_search' = 'notifications') {
  const fixture = await createFixture();
  const account = await accountsRepo.createAccount({
    ownerId: fixture.ownerId,
    channel: 'mock',
    handle: `hang_${uniqueSuffix()}`,
  });
  await accountsRepo.updateAccount(account.id, { status: 'CONNECTED', enabled: true });
  await accountsRepo.linkAgentAccount({
    agentId: fixture.agentId,
    accountId: account.id,
    triggerEventTypes: ['MENTION'],
    actionType: 'REPLY',
  });
  return radarRepo.upsertSource({ accountId: account.id, kind });
}

const previousHold = process.env.AI17Z_RADAR_CLAIM_HOLD_S;

beforeEach(() => {
  // The deadline is the claim hold, because that is already the moment the
  // source becomes claimable by anybody else. One second here so the test
  // measures the rule rather than the default.
  process.env.AI17Z_RADAR_CLAIM_HOLD_S = '1';
});

afterEach(() => {
  if (previousHold === undefined) delete process.env.AI17Z_RADAR_CLAIM_HOLD_S;
  else process.env.AI17Z_RADAR_CLAIM_HOLD_S = previousHold;
});

describe('a radar source that stops answering', () => {
  it('does not take the whole loop down with it', async () => {
    const source = await connectedSource();
    const radar = new NeverReturns();

    const started = Date.now();
    await radar.tick();
    const took = Date.now() - started;

    // It returned at all, which is the whole point. Without the deadline this
    // await never resolves and the test times out.
    expect(radar.started).toBe(1);
    expect(took, 'gave up near the claim hold rather than waiting for ever').toBeLessThan(10_000);

    // And the next tick can still claim, because `running` was cleared.
    await radarRepo.retryNow(source.id);
    const second = new ReturnsAtOnce();
    await second.tick();
    expect(second.started, 'the radar kept working after being left behind').toBe(1);
  }, 30_000);

  it('says it was given up on, rather than reporting a healthy empty poll', async () => {
    const source = await connectedSource('mention_search');
    await new NeverReturns().tick();

    const after = (await radarRepo.getSource(source.id))!;
    /*
      The half that makes it visible. A source nobody can read is degraded, not
      healthy: this was the entire disguise, and a fix that restored the loop
      while leaving the light green would have hidden it better than before.
    */
    expect(after.status).toBe('DEGRADED');
    expect(after.consecutiveFailures).toBe(1);
    expect(after.lastError).toMatch(/stopped answering/i);
    expect(after.lastError, 'reads as a sentence, not a code').toMatch(/not the same as nothing being there/i);
  }, 30_000);

  it('does not move the cursor of a source it gave up on', async () => {
    // It read nothing, so it can vouch for nothing. Advancing here would close
    // the gap the hang just opened.
    const source = await connectedSource();
    await radarRepo.recordPoll({ sourceId: source.id, nextPollAt: new Date(), found: 4, cursor: 'high-water' });
    await radarRepo.retryNow(source.id);

    await new NeverReturns().tick();
    expect((await radarRepo.getSource(source.id))!.cursor).toBe('high-water');
  }, 30_000);

  it('leaves an ordinary poll completely alone', async () => {
    // The deadline must be invisible in the normal case. A radar that starts
    // abandoning healthy polls is worse than the fault it replaced.
    const source = await connectedSource();
    const radar = new ReturnsAtOnce();

    await radar.tick();
    expect(radar.started).toBe(1);

    // The stub records no poll of its own, so what matters is what the
    // deadline did *not* do: no failure, no error, nothing marked degraded.
    const after = (await radarRepo.getSource(source.id))!;
    expect(after.status).not.toBe('DEGRADED');
    expect(after.consecutiveFailures).toBe(0);
    expect(after.lastError).toBeNull();
  }, 30_000);
});
