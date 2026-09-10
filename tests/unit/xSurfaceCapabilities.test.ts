import { describe, expect, it } from 'vitest';
import { defaultPermission } from '@xbam/shared/contracts';
import { registerXCapabilities } from '@xbam/runtime';
import { getCapability, resetCapabilitiesForTest } from '@xbam/tools';

/**
 * The surfaces a person opens rather than a model reaches for.
 *
 * What matters here is not that they exist -- the browser work is proved against
 * real Chrome -- but what each one is declared as, because the declaration is
 * what the permission model reads. A private inbox declared at the same risk as
 * a public timeline would be allowed by default for every agent, and it would
 * look completely correct in every list.
 */
describe('the X surface capabilities', () => {
  resetCapabilitiesForTest();
  registerXCapabilities();

  it('asks the owner before reading private correspondence', () => {
    // The whole reason these are HIGH. A timeline is public; an inbox is
    // correspondence between two people, only one of whom is the owner.
    for (const id of ['x.read_inbox', 'x.read_conversation']) {
      const capability = getCapability(id)!;
      expect(capability.effect, id).toBe('READ');
      expect(capability.risk, id).toBe('HIGH');
      expect(defaultPermission(capability.effect, capability.risk), id).toBe('OWNER_APPROVAL');
    }
  });

  it('allows the public reads without asking', () => {
    for (const id of ['x.read_notifications', 'x.read_timeline', 'x.read_post_analytics']) {
      const capability = getCapability(id)!;
      expect(defaultPermission(capability.effect, capability.risk), id).toBe('ALLOWED');
    }
  });

  it('has no capability that sends a direct message', () => {
    // Not an oversight. A reply on a timeline is public and answerable in the
    // open; a message is not, and an agent that can open conversations with
    // strangers is the thing this product refuses to be.
    expect(getCapability('x.send_message')).toBeNull();
    expect(getCapability('x.send_dm')).toBeNull();
  });

  it('bounds every list read', () => {
    // The ceiling is the bound on how long one capability holds a job open. A
    // follower list has no end, so a model asked for "everything" would
    // otherwise scroll until X stopped it.
    expect(getCapability('x.read_connections')!.input.safeParse({ handle: 'a', limit: 5_000 }).success).toBe(false);
    expect(getCapability('x.read_notifications')!.input.safeParse({ limit: 500 }).success).toBe(false);
    expect(getCapability('x.read_timeline')!.input.safeParse({ limit: 500 }).success).toBe(false);
    expect(getCapability('x.read_inbox')!.input.safeParse({ limit: 500 }).success).toBe(false);
  });

  it('defaults each list read to something small', () => {
    expect(getCapability('x.read_notifications')!.input.parse({})).toMatchObject({ surface: 'ALL', limit: 15 });
    expect(getCapability('x.read_timeline')!.input.parse({})).toMatchObject({ surface: 'HOME', limit: 15 });
    expect(getCapability('x.read_connections')!.input.parse({ handle: 'a' })).toMatchObject({
      kind: 'FOLLOWERS',
      limit: 25,
    });
  });

  it('refuses a list id that is not one', () => {
    const input = getCapability('x.read_timeline')!.input;
    expect(input.safeParse({ surface: 'LIST', listId: '1234567890' }).success).toBe(true);
    expect(input.safeParse({ surface: 'LIST', listId: 'my-list' }).success).toBe(false);
  });

  it('takes a post for analytics, not a handle', () => {
    const input = getCapability('x.read_post_analytics')!.input;
    expect(input.safeParse({ post: '2094843814082924574' }).success).toBe(true);
    expect(input.safeParse({ post: '@somebody' }).success).toBe(false);
  });

  it('says why it cannot run rather than failing later', async () => {
    const readiness = await getCapability('x.read_notifications')!.readiness!({
      agentId: 'a',
      jobId: null,
      accountId: null,
      config: {},
      logger: console as never,
    });
    expect(readiness.status).toBe('UNAVAILABLE');
    expect(readiness.why).toContain('no X account');
  });
});
