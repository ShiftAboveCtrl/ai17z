import { describe, expect, it } from 'vitest';
import type { RadarCandidate } from '@xbam/shared/contracts';
import { DEFAULT_POLICY, OutreachPolicy } from '@xbam/shared/contracts';
import { decideEngagement, rankDiscovered, readPromo, scoreDiscovered } from '@xbam/runtime';

/**
 * Choosing which discovered posts deserve a closer look.
 *
 * Every text here was found by a live agent's own discovery, under its own
 * topics, in one afternoon. Ranked on audience alone, the top two were a
 * 1.6-million-follower account flexing old calls and a 1.3-million one pitching
 * a token, above a 55-thousand account with a real thesis about the agent's
 * own subject.
 */

const TOPICS = ['Pons', '$PONS', 'Pons launchpad', 'Robinhood Chain', 'Uniswap', 'Robinhood ecosystem'];

const found = (handle: string, followers: number | null, likes: number, replies: number, text: string): RadarCandidate => ({
  remoteId: `${handle}-1`,
  remoteUrl: null,
  authorHandle: handle,
  authorId: null,
  authorDisplayName: null,
  text,
  parentRemoteId: null,
  conversationRemoteId: `${handle}-1`,
  occurredAt: null,
  eventType: 'POST',
  raw: { ...(followers === null ? {} : { author: { followers } }), metrics: { likes, replies } },
});

const CALLS = found('cryptorover', 1_615_247, 156, 36,
  'I GAVE YOU $PONS AT 411K - 1.060X I GAVE YOU $STONK AT 660K - 418X And I gave you $ARENA. Already 3x since my first call and I think it could go much higher');
const SENDING = found('cryptorover', 1_615_247, 276, 35,
  "$ARENA is sending already! +50% in one hour \u{1F92F} This could be the next big run. Don't tell me I didn't talk about it \u{1F4C8}");
const PITCH = found('tripleK31', 1_258_270, 809, 5,
  '$EKOX is looking seriously strong right now \u{1F440} The Next Chain. The Next Move. EKOX is building around staking, restaking, community rewards and real utility');
const SETUP = found('BluntCap', 26_674, 151, 34,
  "Gm It seems that I have to talk a bit more about $Vectis so you guys don't miss this unique setup. What is it? First launch protocol on the Robinhood Chain");
const THESIS = found('zaimiri', 54_918, 127, 63,
  'I think we see a rotation into Robinhood Chain soon. HOOD Summit is September 29 to 30 and my read is that the next wave will lean heavily into tech and AI');
const DATA = found('tokenterminal', 164_854, 67, 14,
  'Tokenized stocks generated $20.9B in DEX trading volume over the past 30 days. Uniswap v4 led with 40.7% market share, followed by v3 at 19.4%');
const PONS = found('ProMint_X', 4_200, 202, 11,
  '$PONS Ready for Hood Summit. Revenue is still down, but the foundation for protocol growth is already in place: 4 new assets added for paired deploys');
const WHALE_OFF_TOPIC = found('injective', 539_370, 55, 9,
  "A short guide on how to get $INJ and Injective eco tokens on @fomo via Injective's latest integration with @solana");

describe('reading a token pitch', () => {
  it('marks call-flexing and hype as a pitch', () => {
    expect(readPromo(CALLS.text).level).toBe('strong');
    expect(readPromo(CALLS.text).signals).toContain('flexes past calls');
    expect(readPromo(SENDING.text).level).toBe('strong');
    expect(readPromo(PITCH.text).level).toBe('strong');
    expect(readPromo(SETUP.text).level).toBe('some');
    // Verbatim: a live reply went under this, because it carried no cashtag.
    expect(
      readPromo("Golden Kitty's on page 2 of @ponsdotfamily \u{1F440} robinhood:0x92e4b008161ac64a7d0c5e540f453f8e6b8bd8d7 https://t.co/iUeLcSGMeh").level,
    ).toBe('strong');
    // An address quoted in a real discussion is not a pitch on its own.
    expect(
      readPromo(
        'The Pons V2 factory at 0x92e4b008161ac64a7d0c5e540f453f8e6b8bd8d7 routes creator fees through the v4 hook, which is why the burn shows up in the same transaction as the swap.',
      ).level,
    ).toBe('none');
    // Verbatim: the first live proactive reply went under this.
    expect(readPromo('I have the next $CASHCAT\n\nI have the next $CATE\n\nI have the next $PONS\n\nI have the next $ANSEM').level).toBe(
      'strong',
    );
    // Verbatim from discovery. A live agent replied under this: the call was
    // teased through the contract, and "Want in?" read as a question.
    expect(readPromo('I have the CA to the next $PONS\n\nIt will go to millions in a few minutes \n\nWant in?').level).toBe('strong');
    // Talking about a contract is not teasing one.
    expect(readPromo('Which contract are you calling $PEPONS? I have seen more than one using that ticker.').level).toBe('none');
    // Verbatim from discovery. Drafted a reply under before this rule.
    expect(
      readPromo(
        'Some of the main, high conviction ARC / Robinhood bags. Bid the dips into Q4 $ASKR - great comms, responsive team constantly pushing updates, bid zone',
      ).level,
    ).toBe('strong');
  });

  it('marks giveaways and engagement farming', () => {
    expect(readPromo('GIVEAWAY: like & RT and tag 3 friends to win $500 of $PONS').level).toBe('strong');
    expect(readPromo('This is a paid promo for $XYZ').level).toBe('strong');
  });

  it('does not call a ticker a pitch', () => {
    // Most of what this agent should talk about has a ticker in it.
    expect(readPromo(PONS.text).level).toBe('none');
    expect(readPromo(DATA.text).level).toBe('none');
    expect(readPromo(THESIS.text).level).toBe('none');
    expect(readPromo('Pons V2 pairs against $HOOD now, which changes how creator fees route').level).toBe('none');
  });
});

describe('ranking what discovery found', () => {
  const context = { topics: TOPICS };

  it('puts a relevant thesis above a whale flexing calls', () => {
    const ranked = rankDiscovered([CALLS, PITCH, SENDING, THESIS, DATA, PONS, WHALE_OFF_TOPIC], 3, context);
    const handles = ranked.map((c) => c.authorHandle);
    expect(handles).toContain('zaimiri');
    expect(handles).toContain('tokenterminal');
    expect(handles).not.toContain('cryptorover');
    expect(handles).not.toContain('tripleK31');
    expect(handles).not.toContain('injective');
  });

  it('lets a small account that is squarely on-topic outrank an off-topic whale', () => {
    expect(scoreDiscovered(PONS, context).score).toBeGreaterThan(scoreDiscovered(WHALE_OFF_TOPIC, context).score);
  });

  it('writes its reasons onto what it keeps', () => {
    const [top] = rankDiscovered([THESIS, CALLS], 1, context);
    const ranking = (top!.raw as { ranking: { rank: number; of: number; factors: { label: string }[] } }).ranking;
    expect(ranking.rank).toBe(1);
    expect(ranking.of).toBe(2);
    expect(ranking.factors.map((f) => f.label)).toEqual(
      expect.arrayContaining(['names Robinhood Chain', '54,918 followers']),
    );
  });

  it('marks down somebody approached this week, and up somebody who wrote in', () => {
    const plain = scoreDiscovered(THESIS, context).score;
    expect(scoreDiscovered(THESIS, { ...context, contactedRecently: ['zaimiri'] }).score).toBeLessThan(plain);
    expect(scoreDiscovered(THESIS, { ...context, engagedWithUs: ['zaimiri'] }).score).toBeGreaterThan(plain);
  });

  it('adds nothing for a count X did not report', () => {
    const unknown = found('someone', null, 0, 0, THESIS.text);
    expect(scoreDiscovered(unknown, context).factors.some((f) => /followers/.test(f.label))).toBe(false);
  });
});

describe('the decision, for speaking first', () => {
  const outreach = OutreachPolicy.parse({ enabled: true, mode: 'AUTONOMOUS', requireTopicMatch: false, minimumValue: 55 });
  const base = {
    directlyAddressed: false,
    relationship: null,
    threadDepth: 0,
    recentRepliesToPerson: 0,
    alreadyRepliedInThread: false,
    hasParent: true,
    unprompted: true,
    topics: TOPICS,
    outreach,
    policy: DEFAULT_POLICY.engagement,
  };

  it('declines a strong pitch however big the account', () => {
    const verdict = decideEngagement({ ...base, text: PITCH.text, authorFollowers: 1_258_270, postEngagement: 814 });
    expect(verdict.decision).toBe('IGNORE');
    expect(verdict.factors.map((f) => f.label).join(' ')).toMatch(/token pitch/);
  });

  it('decays for somebody approached before who never answered, and warms for somebody who did', () => {
    const fresh = decideEngagement({ ...base, text: THESIS.text, authorFollowers: 54_918 }).value;
    const ignored = decideEngagement({ ...base, text: THESIS.text, authorFollowers: 54_918, approachHistory: { approaches: 2, answered: false } }).value;
    const answered = decideEngagement({ ...base, text: THESIS.text, authorFollowers: 54_918, approachHistory: { approaches: 1, answered: true } }).value;
    expect(ignored).toBeLessThan(fresh - 20);
    expect(answered).toBeGreaterThan(fresh);
  });

  it('never applies any of it to somebody who wrote to the agent', () => {
    const direct = { ...base, unprompted: false, directlyAddressed: true, text: `@agent ${PITCH.text}` };
    const withHistory = decideEngagement({ ...direct, approachHistory: { approaches: 3, answered: false }, authorFollowers: 5 });
    const without = decideEngagement(direct);
    expect(withHistory.value).toBe(without.value);
  });
});
