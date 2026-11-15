import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  NarrativePulseChecks, NarrativeTermBatch, NarrativeTermReceipt, NARRATIVE_PULSE_MIN_AUTHORS, PolicyConfig, type CheckBoardRow,
} from '@xbam/shared/contracts';
import { readNarratives, NARRATIVE_MIN_AUTHORS, type NarrativePost } from '../../packages/runtime/src/narratives';
import {
  CHECKS_NOT_READ, NARRATIVE_PULSE_IDEA_SOURCE, SAYS_NOT_ENDORSED_PULSE, checkNarrativePulseAtSend, checkNarrativePulseText,
  classifyRows, filterPulseNarratives, narrativePulseIdea, personReason, type PulseRow,
} from '../../packages/runtime/src/narrativePulse';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/studio-narrative-pulse.json', import.meta.url), 'utf8'));
const SOL = 'So11111111111111111111111111111111111111112';
const NOW = new Date('2026-11-15T12:00:00.000Z');

function post(i: number, handle: string, text: string, hoursAgo = 1): NarrativePost {
  return { statusId: `s${i}`, handle, authorId: `id-${handle}`, text, postedAt: new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString() };
}

/** Thirty distinct authors, each saying something of their own, and a subject several of them share. */
function crowd(subject: string, authors: number, extra: (i: number) => string = (i) => `thought number ${i} about gardens`): NarrativePost[] {
  const posts: NarrativePost[] = [];
  for (let i = 0; i < 30; i += 1) {
    const says = i < authors ? `${extra(i)} and ${subject}` : extra(i);
    posts.push(post(i, `user${i}`, says));
  }
  return posts;
}

describe('the frozen Studio payload', () => {
  it('parses the fixture Studio copies, and nothing else is in it', () => {
    expect(Object.keys(fixture).sort()).toEqual(['checks', 'contribution_batch', 'contribution_receipt']);
    expect(NarrativeTermBatch.parse(fixture.contribution_batch)).toEqual(fixture.contribution_batch);
    expect(NarrativeTermReceipt.parse(fixture.contribution_receipt)).toEqual(fixture.contribution_receipt);
    expect(NarrativePulseChecks.parse(fixture.checks)).toEqual(fixture.checks);
  });
  it('carries no field that could identify an author, a handle, an agent or a post', () => {
    const term = fixture.contribution_batch.terms[0];
    for (const extra of [{ handle: 'x' }, { author: 'x' }, { text: 'x' }, { agent_id: 'x' }, { example: 'x' }]) {
      expect(NarrativeTermBatch.safeParse({ protocol: 1, terms: [{ ...term, ...extra }] }).success).toBe(false);
    }
    expect(NarrativeTermBatch.safeParse({ ...fixture.contribution_batch, agent_id: 'x' }).success).toBe(false);
  });
  it('refuses a term that is not a subject, a count under the floor, a window off the hour and a zero share', () => {
    const term = fixture.contribution_batch.terms[0];
    const bad = (patch: object) => NarrativeTermBatch.safeParse({ protocol: 1, terms: [{ ...term, ...patch }] }).success;
    expect(bad({ term: '@someone' })).toBe(false);
    expect(bad({ term: 'two words' })).toBe(false);
    expect(bad({ distinctAuthors: NARRATIVE_PULSE_MIN_AUTHORS - 1 })).toBe(false);
    expect(bad({ windowEnd: '2026-11-15T08:30:00.000Z' })).toBe(false);
    expect(bad({ share: 0 })).toBe(false);
    expect(bad({ share: 1.2 })).toBe(false);
    expect(bad({})).toBe(true);
  });
  it('uses the same author floor as the reader', () => {
    expect(NARRATIVE_PULSE_MIN_AUTHORS).toBe(NARRATIVE_MIN_AUTHORS);
  });
});

describe('opt-ins', () => {
  it('are both off by default and independent', () => {
    const policy = PolicyConfig.parse({});
    expect(policy.studio.postNarrativePulse).toBe(false);
    expect(policy.studio.contributeNarrativeTerms).toBe(false);
    expect(PolicyConfig.parse({ studio: { contributeNarrativeTerms: true } }).studio.postNarrativePulse).toBe(false);
  });
});

describe('what may be published', () => {
  const recent = (posts: NarrativePost[]) => posts;

  it('drops a subject reticence refuses, with the reason', () => {
    const posts = crowd('election', 12);
    const reading = readNarratives(posts, { now: NOW, windowHours: 6, limit: 40 });
    expect(reading.narratives.map((n) => n.term)).toContain('election');
    const { kept, dropped } = filterPulseNarratives(reading.narratives, { recent: recent(posts), handles: new Set() });
    expect(kept.map((n) => n.term)).not.toContain('election');
    expect(dropped.find((d) => d.term === 'election')).toMatchObject({ reason: 'reticence' });
  });

  it('drops health and personal subjects too', () => {
    for (const subject of ['diagnosis', 'cancer', 'abortion', 'divorce']) {
      const posts = crowd(subject, 12);
      const reading = readNarratives(posts, { now: NOW, windowHours: 6, limit: 40 });
      const { kept } = filterPulseNarratives(reading.narratives, { recent: posts, handles: new Set() });
      expect(kept.map((n) => n.term), subject).not.toContain(subject);
    }
  });

  it('drops a subject that is the name of an account it read', () => {
    const posts = crowd('anika', 12);
    const reading = readNarratives(posts, { now: NOW, windowHours: 6, limit: 40 });
    const { kept, dropped } = filterPulseNarratives(reading.narratives, { recent: posts, handles: new Set(['anika']) });
    expect(kept.map((n) => n.term)).not.toContain('anika');
    expect(dropped.find((d) => d.term === 'anika')).toMatchObject({ reason: 'person' });
  });

  it('drops a subject that mostly appears inside a capitalised name, and keeps an ordinary lower-case one', () => {
    const named = crowd('Elon Musk', 12, (i) => `take number ${i} on the week`);
    expect(personReason('musk', named, new Set())).toMatch(/capitalised name/);
    const plain = crowd('restaking', 12);
    expect(personReason('restaking', plain, new Set())).toBeNull();
    // A capital at the start of a sentence is not a name.
    const lead = crowd('Great restaking', 12, (i) => `thought ${i}`).map((p) => ({ ...p, text: p.text.replace('and Great restaking', '. Great restaking') }));
    expect(personReason('restaking', lead, new Set())).toBeNull();
    // A cashtag is a ticker, not a person.
    expect(personReason('$sol', crowd('$Sol Labs', 12), new Set())).toBeNull();
  });

  it('drops a subject whose posts are near-identical wording from several accounts, and says so', () => {
    const shill = 'gm frens the moonrocket token is about to change everything for all of us today';
    const posts = crowd('moonrocket', 12).map((p, i) => (i < 12 ? { ...p, text: shill } : p));
    const reading = readNarratives(posts, { now: NOW, windowHours: 6, limit: 40 });
    expect(reading.narratives.map((n) => n.term)).toContain('moonrocket');
    const { kept, dropped } = filterPulseNarratives(reading.narratives, { recent: posts, handles: new Set() });
    expect(kept.map((n) => n.term)).not.toContain('moonrocket');
    const gone = dropped.find((d) => d.term === 'moonrocket');
    expect(gone).toMatchObject({ reason: 'coordination' });
    expect(gone!.sentence).toMatch(/not a finding about anybody/);
  });

  it('keeps a subject several people raised in their own words', () => {
    const own = ['liquid restaking is getting crowded', 'my restaking yield dropped again this week', 'who is still doing restaking on mainnet', 'restaking points seem fine to me', 'tried restaking with a small amount'];
    const posts = crowd('x', 0).map((p, i) => (i < 5 ? { ...p, text: own[i]! } : p));
    const reading = readNarratives(posts, { now: NOW, windowHours: 6, limit: 40 });
    const { kept } = filterPulseNarratives(reading.narratives, { recent: posts, handles: new Set() });
    expect(kept.map((n) => n.term)).toContain('restaking');
  });
});

describe('present or rising', () => {
  const narrative = (term: string, share: number, authors = 9) => ({ term, share, authors, mentions: authors, examples: [], detail: '' });

  it('calls nothing rising without an earlier snapshot', () => {
    const rows = classifyRows([narrative('restaking', 0.2)], null);
    expect(rows[0]!.rise).toEqual({ kind: 'present' });
  });

  it('calls a subject rising only when the snapshot measured it and the share moved enough', () => {
    const before = { windowEnd: '2026-11-14T10:00:00.000Z', terms: new Map([['restaking', { share: 0.05 }], ['gardens', { share: 0.2 }]]) };
    const rows = classifyRows([narrative('restaking', 0.2), narrative('gardens', 0.21), narrative('newword', 0.3)], before);
    const by = Object.fromEntries(rows.map((r) => [r.term, r.rise]));
    expect(by.restaking).toEqual({ kind: 'rising', priorShare: 0.05 });
    expect(by.gardens).toEqual({ kind: 'present' });
    // Absent from the snapshot means below the floor then, not zero: never "rising from nothing".
    expect(by.newword).toEqual({ kind: 'present' });
  });

  it('orders by share and by nothing else', () => {
    const before = { windowEnd: 'x', terms: new Map([['small', { share: 0.001 }]]) };
    const rows = classifyRows([narrative('small', 0.05), narrative('big', 0.3), narrative('mid', 0.1)], before);
    expect(rows.map((r) => r.term)).toEqual(['big', 'mid', 'small']);
  });
});

describe('the idea', () => {
  const row = (term: string, share: number, authors: number, rise: PulseRow['rise'] = { kind: 'present' }): PulseRow => ({ term, share, authors, rise });
  const rows = [row('$sol', 0.142, 41, { kind: 'rising', priorShare: 0.06 }), row('restaking', 0.09, 23)];
  const checkRows: CheckBoardRow[] = [{ chain: 'solana', mint: SOL, askers: 5, readings: [] }];
  const base = { windowHours: 12, windowEnd: NOW, dropped: [], hasBefore: true };

  it('shows share with its sample size, says not endorsed and ranks nothing by merit', () => {
    const idea = narrativePulseIdea({ ...base, rows, checks: { read: true, rows: checkRows, windowHours: 24 } })!;
    expect(idea.summary).toContain(SAYS_NOT_ENDORSED_PULSE);
    expect(idea.summary).toContain('$sol 14.2% of posts (n = 41 authors, rising, was 6.0%)');
    expect(idea.summary).toContain('restaking 9.0% of posts (n = 23 authors, present)');
    expect(idea.summary.indexOf('$sol')).toBeLessThan(idea.summary.indexOf('restaking'));
    expect(idea.summary).toContain(`${SOL} (solana) 5 askers`);
    expect(idea.summary.length).toBeLessThanOrEqual(500);
    expect(idea.detail).toMatch(/never that the word or any token is good/);
    expect(idea.summary).not.toMatch(/@/);
  });

  it('says the checks half was not read when Studio could not be reached, and names no token', () => {
    const idea = narrativePulseIdea({ ...base, rows, checks: { read: false, why: 'Studio could not be reached.' } })!;
    expect(idea.summary).toContain(CHECKS_NOT_READ);
    expect(idea.summary).not.toContain(SOL);
    expect(idea.detail).toMatch(/checks half was not read/);
  });

  it('says plainly when no token had enough askers, which is not the same as not read', () => {
    const idea = narrativePulseIdea({ ...base, rows, checks: { read: true, rows: [], windowHours: 24 } })!;
    expect(idea.summary).toMatch(/No token had enough distinct askers/);
    expect(idea.summary).not.toContain(CHECKS_NOT_READ);
  });

  it('makes nothing when the narrative half is below the floor, whatever the checks say', () => {
    expect(narrativePulseIdea({ ...base, rows: rows.slice(0, 1), checks: { read: true, rows: checkRows, windowHours: 24 } })).toBeNull();
    expect(narrativePulseIdea({ ...base, rows: [], checks: { read: true, rows: checkRows, windowHours: 24 } })).toBeNull();
  });

  it('says without naming it that a coordinated subject was left out', () => {
    const idea = narrativePulseIdea({
      ...base, rows, checks: { read: false, why: '' },
      dropped: [{ term: 'moonrocket', reason: 'coordination', sentence: 'x' }],
    })!;
    expect(idea.detail).toMatch(/1 subject was left out/);
    expect(idea.detail).not.toContain('moonrocket');
  });

  it('says nothing is rising when there was no earlier reading', () => {
    const idea = narrativePulseIdea({ ...base, hasBefore: false, rows: rows.map((r) => ({ ...r, rise: { kind: 'present' as const } })), checks: { read: false, why: '' } })!;
    expect(idea.detail).toMatch(/nothing here is called rising/);
  });
});

describe('the finished text', () => {
  const facts = `Talked about and checked, last 12 hours. ${SAYS_NOT_ENDORSED_PULSE} Talked about, by share of the posts this agent read: $sol 14.2% of posts (n = 41 authors, rising, was 6.0%); restaking 9.0% of posts (n = 23 authors, present). Checked on AI17Z Studio in the last 24 hours, in order of askers: ${SOL} (solana) 5 askers.`;
  const good = `Talked about is not endorsed and checked is not endorsed. Of the posts I read, $sol came up in 14.2% (n = 41 authors), rising from 6.0%, restaking in 9.0%. People asked Studio to check ${SOL} 5 times.`;

  it('passes a faithful post', () => {
    expect(checkNarrativePulseText(good, facts)).toEqual([]);
  });
  it('wants the not endorsed line, and refuses advice, a verdict, a ranking and a forecast', () => {
    expect(checkNarrativePulseText('$sol is in 14.2% of posts.', facts).join(' ')).toMatch(/not endorsed/);
    expect(checkNarrativePulseText(`${good} Worth a look.`, facts).join(' ')).toMatch(/advice or a verdict/);
    expect(checkNarrativePulseText(`${good} The top narrative today.`, facts).join(' ')).toMatch(/ranks by something other than share/);
    expect(checkNarrativePulseText(`${good} This signals more to come.`, facts).join(' ')).toMatch(/promise, a signal/);
  });
  it('refuses rising when the facts carry no earlier reading, and rising from nothing always', () => {
    const noBefore = facts.replace('rising, was 6.0%', 'present');
    expect(checkNarrativePulseText(good, noBefore).join(' ')).toMatch(/nothing earlier was read/);
    expect(checkNarrativePulseText(`${good} It came out of nowhere.`, facts).join(' ')).toMatch(/rose from nothing/);
  });
  it('refuses an address, a tag or an account that is not in the facts', () => {
    expect(checkNarrativePulseText(`${good} 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU`, facts).join(' ')).toMatch(/address/);
    expect(checkNarrativePulseText(`${good} $pepe too.`, facts).join(' ')).toMatch(/tag that is not in the facts/);
    expect(checkNarrativePulseText(`${good} thanks @someone`, facts).join(' ')).toMatch(/names an account/);
  });
  it('requires saying the checks half was not read when it was not', () => {
    const missing = facts.replace(/Checked on AI17Z Studio.*$/, CHECKS_NOT_READ);
    const text = 'Talked about is not endorsed. $sol was in 14.2% of posts, rising from 6.0%, restaking in 9.0%.';
    expect(checkNarrativePulseText(text, missing).join(' ')).toMatch(/checks half was not read/);
    expect(checkNarrativePulseText(`${text} The checks half was not read.`, missing)).toEqual([]);
  });
});

describe('at send', () => {
  const policyOn = PolicyConfig.parse({ studio: { postNarrativePulse: true } });
  it('ignores every other post', async () => {
    await expect(checkNarrativePulseAtSend({ raw: { ideaSource: 'other' }, text: 'buy it', policy: PolicyConfig.parse({}) })).resolves.toBeUndefined();
  });
  it('refuses permanently when the owner switched posting off after the idea was made', async () => {
    await expect(checkNarrativePulseAtSend({ raw: { ideaSource: NARRATIVE_PULSE_IDEA_SOURCE }, text: 'x', policy: PolicyConfig.parse({}) })).rejects.toThrow(/switched off/);
  });
  it('sends a text that fails the check to the owner, and passes a narrative-only text with no Studio', async () => {
    const facts = `${SAYS_NOT_ENDORSED_PULSE} restaking 9.0% of posts (n = 23 authors, present). ${CHECKS_NOT_READ}`;
    await expect(checkNarrativePulseAtSend({ raw: { ideaSource: NARRATIVE_PULSE_IDEA_SOURCE, ideaSummary: facts }, text: 'restaking is great, buy', policy: policyOn })).rejects.toThrow(/needs the owner/);
    await expect(checkNarrativePulseAtSend({
      raw: { ideaSource: NARRATIVE_PULSE_IDEA_SOURCE, ideaSummary: facts },
      text: 'Talked about is not endorsed. restaking was in 9.0% of the posts I read (n = 23 authors). The checks half was not read.',
      policy: policyOn,
    })).resolves.toBeUndefined();
  });
});
