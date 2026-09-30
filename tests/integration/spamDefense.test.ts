import { describe, expect, it } from 'vitest';
import { accounts as accountsRepo, jobs as jobsRepo, query, relationships, spam as spamRepo } from '@xbam/database';
import { ingestNormalizedEvent, judgeSpam, spamFeatures } from '@xbam/runtime';
import { installHarness, mockEvent } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { uniqueSuffix } from '../support/db';

installHarness();

async function setup() {
  const fixture = await createFixture();
  const account = await accountsRepo.createAccount({ ownerId: fixture.ownerId, channel: 'mock', handle: `ai17zos_${uniqueSuffix()}` });
  await accountsRepo.updateAccount(account.id, { status: 'CONNECTED', enabled: true });
  await accountsRepo.linkAgentAccount({ agentId: fixture.agentId, accountId: account.id, triggerEventTypes: ['MENTION', 'REPLY'], actionType: 'REPLY' });
  const post = async (text: string, author: string, over: Record<string, unknown> = {}) => {
    const event = mockEvent(text, { remoteAuthorHandle: author, remoteAuthorId: `id-${author}`, ...over });
    const outcome = await ingestNormalizedEvent({ accountId: account.id, event });
    const verdict = await spamRepo.verdictFor(outcome.eventId);
    return { eventId: outcome.eventId, jobs: outcome.jobs.filter((j) => j.created).length, verdict: verdict?.verdict ?? null, reasons: verdict?.reasons ?? [] };
  };
  return { fixture, account, post };
}

const CAMPAIGN = '#ai17zoss @grok https://t.co/abc123 https://t.co/def456';

describe('spam defense at ingest', () => {
  it('lets the first few of a campaign through as suspect, then filters it once three accounts paste it', async () => {
    const { post } = await setup();
    const results = [];
    for (let i = 0; i < 20; i += 1) results.push(await post(`@ai17zOS ${CAMPAIGN.replace('abc123', `x${i}`)}`, `farm${i}`));
    expect(results.slice(0, 2).every((r) => r.verdict === 'SUSPECT')).toBe(true);
    expect(results.slice(2).every((r) => r.verdict === 'SPAM' && r.jobs === 0)).toBe(true);
    // Twenty posts, one campaign, every account counted.
    const [template] = await query<{ items: number; actors: number }>(`SELECT items, actors FROM spam_templates`);
    expect(template).toEqual({ items: 20, actors: 20 });
  });

  it('filters one account pasting the same thing twenty times', async () => {
    const { post } = await setup();
    const results = [];
    for (let i = 0; i < 20; i += 1) results.push(await post(`@ai17zOS ${CAMPAIGN}`, 'onefarm'));
    expect(results.slice(2).every((r) => r.verdict === 'SPAM' && r.jobs === 0)).toBe(true);
  });

  it('filters a crypto scam reply the first time it is seen', async () => {
    const { post } = await setup();
    const scam = await post('@ai17zOS @grok Claim your free airdrop now, limited spots! https://scam.example/claim', 'scammer');
    expect(scam.verdict).toBe('SPAM');
    expect(scam.jobs).toBe(0);
  });

  it('never treats @grok as spam: a real question tagging it is answered after spam that tagged it', async () => {
    const { post, fixture } = await setup();
    const spam = await post('@ai17zOS @grok Claim your free airdrop now https://scam.example/x', 'scammer');
    await spamRepo.ownerLabel(spam.eventId, 'SPAM');
    const legit = await post('@ai17zOS @grok what do you two think about restaking risk?', 'curious_dev');
    expect(legit.verdict).toBe('CLEAN');
    expect(legit.jobs).toBe(1);
    // And the owner's one verdict condemned nothing but that post.
    const actor = await spamRepo.getActor(fixture.ownerId, 'grok');
    expect(actor).toBeNull();
  });

  it('keeps a legitimate crypto reply and a real conversation with many mentions', async () => {
    const { post } = await setup();
    expect((await post('@ai17zOS the gas on that chain was cheaper than I expected, did you see the fee data?', 'trader1')).verdict).toBe('CLEAN');
    expect((await post('@ai17zOS @a @b @c @d @e @f lmao this thread is the best thing I read today, the bug report is art', 'viral1')).verdict).not.toBe('SPAM');
  });

  it('gives a known friend joking with mass mentions the benefit of the doubt', async () => {
    const { post, fixture } = await setup();
    await relationships.recordInteraction?.({
      agentId: fixture.agentId,
      channel: 'mock',
      handle: 'oldfriend',
      remoteUserId: null,
      direction: 'OUTBOUND',
    } as never).catch(() => undefined);
    await query(`UPDATE relationships SET familiarity = 'REGULAR' WHERE handle = 'oldfriend'`);
    const joke = await post('@ai17zOS @a @b @c @d @e @f @g @h @i @j #gm https://t.co/meme', 'oldfriend');
    expect(joke.verdict).not.toBe('SPAM');
  });

  it('respects the owner: marked spam applies to the item, not spam is a strong correction for the template', async () => {
    const { post } = await setup();
    const a = await post('@ai17zOS #ai17zoss https://t.co/one', 'fan1');
    expect(a.verdict).toBe('SUSPECT');
    await spamRepo.ownerLabel(a.eventId, 'NOT_SPAM');
    // Two more accounts post the same shape: a campaign by count, but the owner said it is not spam.
    await post('@ai17zOS #ai17zoss https://t.co/two', 'fan2');
    const c = await post('@ai17zOS #ai17zoss https://t.co/three', 'fan3');
    expect(c.verdict).not.toBe('SPAM');
    expect(c.jobs).toBe(1);
  });

  it('does not condemn an account for one spammy post', async () => {
    const { post } = await setup();
    const once = await post('@ai17zOS Claim your free airdrop https://scam.example/y', 'reformed');
    expect(once.verdict).toBe('SPAM');
    const later = await post('@ai17zOS genuinely curious how you handle restarts mid job', 'reformed');
    expect(later.verdict).toBe('CLEAN');
    expect(later.jobs).toBe(1);
  });

  it('honours a mute, and only for that account', async () => {
    const { post, account } = await setup();
    await spamRepo.setMuted(account.id, 'noisy', true);
    expect((await post('@ai17zOS hello there, fine day for it', 'noisy')).verdict).toBe('SPAM');
    expect((await post('@ai17zOS hello there, fine day for it', 'quiet')).verdict).toBe('CLEAN');
  });

  it('keeps direct replies from real people flowing under a spam flood', async () => {
    const { post } = await setup();
    for (let i = 0; i < 30; i += 1) await post(`@ai17zOS ${CAMPAIGN.replace('abc123', `f${i}`)}`, `flood${i}`);
    const real = await post('@ai17zOS your last post about restarts was spot on, how long did recovery take?', 'realperson');
    expect(real.verdict).toBe('CLEAN');
    expect(real.jobs).toBe(1);
    const queued = await query<{ n: number }>(`SELECT count(*)::int AS n FROM jobs`);
    // Two suspects from the flood's first posts at most, plus the real reply.
    expect(queued[0]!.n).toBeLessThanOrEqual(3);
    expect(await jobsRepo.countJobsByStatus()).toBeTruthy();
  });
});

describe('what makes two posts the same', () => {
  it('ignores casing, links, accents, invisible characters and numbers', () => {
    const a = spamFeatures('Claim your AIRDROP now at https://a.example/1 !!!');
    const b = spamFeatures('claim your airdrop now at https://b.example/2');
    const c = spamFeatures('Cláim yоur a​irdrop now at https://c.example 777');
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(spamFeatures('CLAIM your airdrop now at').fingerprint).toBe(a.fingerprint);
    expect(c.residue.replace(/#/g, '').trim()).toContain('claim');
  });

  it('does not weigh followers at all', () => {
    const verdict = judgeSpam(spamFeatures('@ai17zOS genuinely good question about memory'), { template: null, actor: null, familiarity: null });
    expect(verdict.verdict).toBe('CLEAN');
  });
});

describe('a post that is only tags', () => {
  it('has no words however long the handles are', () => {
    expect(spamFeatures('@a_handle_longer_than_fifteen #ai17zoss @grok https://t.co/x').words).toBe(0);
  });
});

describe('a post that is only a link', () => {
  it('is not the same text as somebody else\'s link', () => {
    const photoA = spamFeatures('@ai17zOS https://t.co/Iv9yhlJHB7');
    const photoB = spamFeatures('@ai17zOS https://t.co/GgQzsqeDJl');
    expect(photoA.fingerprint).not.toBe(photoB.fingerprint);
  });

  it('still groups a campaign that shares a hashtag', () => {
    const one = spamFeatures('#ai17zoss @grok https://t.co/a1 https://t.co/a2');
    const two = spamFeatures('#ai17zoss @grok https://t.co/b1 https://t.co/b2');
    expect(one.fingerprint).toBe(two.fingerprint);
  });
});
