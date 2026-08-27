import { describe, expect, it } from 'vitest';
import { StancePolicy, positionsConflict, subjectKey } from '@xbam/shared/contracts';
import { stances } from '@xbam/database';
import {
  candidateSubjects,
  checkStanceConsistency,
  detectClaims,
  learnStancesFromOwnPost,
  loadStanceContext,
  readPosition,
} from '@xbam/runtime';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';

installHarness();

const policy = StancePolicy.parse({});

describe('reading a position out of text', () => {
  it('reads plain approval and plain disapproval', () => {
    expect(readPosition('This is a strong design and it works well.').position).toBe('POSITIVE');
    expect(readPosition('This is weak and the incentives are broken.').position).toBe('NEGATIVE');
  });

  it('says nothing when the text takes no view', () => {
    expect(readPosition('The announcement is scheduled for Tuesday.').position).toBe('NEUTRAL');
  });

  it('treats heavy hedging as uncertainty rather than a position', () => {
    const read = readPosition('Maybe it works, perhaps not, it depends and it is unclear either way.');
    expect(['UNCERTAIN', 'MIXED']).toContain(read.position);
  });

  it('reports a hedged view as weaker than a flat one', () => {
    const flat = readPosition('Wrong, broken, and failing.');
    const hedged = readPosition('Maybe wrong, possibly broken.');
    expect(hedged.strength).toBeLessThan(flat.strength);
  });
});

describe('what counts as a contradiction', () => {
  it('is only a straight reversal', () => {
    expect(positionsConflict('POSITIVE', 'NEGATIVE')).toBe(true);
    expect(positionsConflict('NEGATIVE', 'POSITIVE')).toBe(true);
  });

  it('lets a firm position soften without calling it a contradiction', () => {
    // An agent that cannot move from certain to hedged is not consistent,
    // it is stuck.
    expect(positionsConflict('POSITIVE', 'MIXED')).toBe(false);
    expect(positionsConflict('NEGATIVE', 'UNCERTAIN')).toBe(false);
  });

  it('treats the same position as agreement', () => {
    expect(positionsConflict('POSITIVE', 'POSITIVE')).toBe(false);
  });
});

describe('subject matching', () => {
  it('collapses casing, punctuation and filler words', () => {
    expect(subjectKey('Project Q')).toBe(subjectKey('the project q'));
    expect(subjectKey('Project-Q!')).toBe(subjectKey('Project Q'));
  });

  it('picks named things out of a post and not ordinary words', () => {
    const subjects = candidateSubjects('I think Project Q got the distribution wrong, unlike Acme Labs.');
    expect(subjects).toContain('Project Q');
    expect(subjects).toContain('Acme Labs');
    expect(subjects.join(' ')).not.toMatch(/\bdistribution\b/);
  });
});

describe('holding and changing a position', () => {
  it('records a position with the evidence it rests on', async () => {
    const fixture = await createFixture();
    const stance = await stances.assert({
      agentId: fixture.agentId,
      subject: 'Project Q',
      position: 'NEGATIVE',
      summary: 'Sceptical about the distribution schedule.',
      confidence: 0.7,
      evidence: { excerpt: 'The unlock schedule is the weak point.' },
    });

    expect(stance.position).toBe('NEGATIVE');
    const evidence = await stances.listEvidence(stance.id);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.excerpt).toMatch(/unlock schedule/);
  });

  it('reinforces rather than duplicating when it says the same thing again', async () => {
    const fixture = await createFixture();
    const first = await stances.assert({
      agentId: fixture.agentId,
      subject: 'Project Q',
      position: 'NEGATIVE',
      summary: 'Sceptical.',
      confidence: 0.5,
    });
    const second = await stances.assert({
      agentId: fixture.agentId,
      subject: 'project q',
      position: 'NEGATIVE',
      summary: 'Still sceptical.',
    });

    expect(second.id).toBe(first.id);
    expect(Number(second.confidence)).toBeGreaterThan(Number(first.confidence));
  });

  it('caps how confident repetition alone can make it', async () => {
    const fixture = await createFixture();
    for (let i = 0; i < 30; i += 1) {
      await stances.assert({
        agentId: fixture.agentId,
        subject: 'Project Q',
        position: 'NEGATIVE',
        summary: 'Sceptical.',
        confidence: 0.5,
      });
    }
    const held = await stances.active(fixture.agentId, 'Project Q');
    // Saying a thing forty times is not the same as having grounds for it.
    expect(Number(held!.confidence)).toBeLessThanOrEqual(0.92);
  });

  it('supersedes rather than overwrites when the position changes', async () => {
    const fixture = await createFixture();
    const before = await stances.assert({
      agentId: fixture.agentId,
      subject: 'Project Q',
      position: 'NEGATIVE',
      summary: 'Sceptical about distribution.',
      confidence: 0.7,
    });
    const after = await stances.assert({
      agentId: fixture.agentId,
      subject: 'Project Q',
      position: 'POSITIVE',
      summary: 'The new schedule addresses it.',
      confidence: 0.6,
    });

    expect(after.id).not.toBe(before.id);
    const history = await stances.history(fixture.agentId, 'Project Q');
    expect(history).toHaveLength(2);
    // The old view is kept, which is what lets the agent say it changed its mind.
    const old = history.find((s) => s.id === before.id)!;
    expect(old.status).toBe('SUPERSEDED');
    expect(old.supersededBy).toBe(after.id);
  });

  it('offers a recent revision so a reply can acknowledge it', async () => {
    const fixture = await createFixture();
    await stances.assert({ agentId: fixture.agentId, subject: 'Project Q', position: 'NEGATIVE', summary: 'a' });
    await stances.assert({ agentId: fixture.agentId, subject: 'Project Q', position: 'POSITIVE', summary: 'b' });

    const context = await loadStanceContext(fixture.agentId, 'What do you think of Project Q now?');
    expect(context.revised[0]?.from).toBe('NEGATIVE');
    expect(context.revised[0]?.to).toBe('POSITIVE');
  });
});

describe('checking a draft against what was already said', () => {
  it('stops a straight reversal of a firmly held position', async () => {
    const fixture = await createFixture();
    await stances.assert({
      agentId: fixture.agentId,
      subject: 'Project Q',
      position: 'NEGATIVE',
      summary: 'Sceptical about distribution.',
      confidence: 0.8,
    });

    const check = await checkStanceConsistency({
      agentId: fixture.agentId,
      text: 'Project Q is a strong design and the incentives are right.',
      policy,
    });
    expect(check.ok).toBe(false);
    expect(check.conflictsWith?.subject).toBe('Project Q');
    expect(check.message).toMatch(/has been negative about it/i);
  });

  it('lets a tentatively held view move without complaint', async () => {
    const fixture = await createFixture();
    await stances.assert({
      agentId: fixture.agentId,
      subject: 'Project Q',
      position: 'NEGATIVE',
      summary: 'Not sure about this.',
      confidence: 0.3,
    });

    const check = await checkStanceConsistency({
      agentId: fixture.agentId,
      text: 'Project Q is a strong design.',
      policy,
    });
    expect(check.ok).toBe(true);
  });

  it('says nothing about subjects the agent has no view on', async () => {
    const fixture = await createFixture();
    const check = await checkStanceConsistency({
      agentId: fixture.agentId,
      text: 'Acme Labs is doing good work.',
      policy,
    });
    expect(check.ok).toBe(true);
  });

  it('does not check at all when turned off', async () => {
    const fixture = await createFixture();
    await stances.assert({
      agentId: fixture.agentId,
      subject: 'Project Q',
      position: 'NEGATIVE',
      summary: 'x',
      confidence: 0.9,
    });
    const check = await checkStanceConsistency({
      agentId: fixture.agentId,
      text: 'Project Q is excellent and strong.',
      policy: StancePolicy.parse({ enabled: false }),
    });
    expect(check.ok).toBe(true);
  });
});

describe('learning from what the agent published', () => {
  it('records a position from a post that took one', async () => {
    const fixture = await createFixture();
    const recorded = await learnStancesFromOwnPost({
      agentId: fixture.agentId,
      text: 'Project Q got the distribution wrong. The schedule is weak and the incentives are broken.',
      policy,
    });
    expect(recorded.length).toBeGreaterThan(0);
    expect((await stances.active(fixture.agentId, 'Project Q'))?.position).toBe('NEGATIVE');
  });

  it('records nothing from a post that took no view', async () => {
    const fixture = await createFixture();
    const recorded = await learnStancesFromOwnPost({
      agentId: fixture.agentId,
      text: 'Project Q publishes its schedule on Tuesday.',
      policy,
    });
    expect(recorded).toHaveLength(0);
  });

  it('never revises a position the owner wrote', async () => {
    const fixture = await createFixture();
    await stances.assert({
      agentId: fixture.agentId,
      subject: 'Project Q',
      position: 'NEGATIVE',
      summary: 'The owner says so.',
      confidence: 0.9,
      pinned: true,
    });

    await learnStancesFromOwnPost({
      agentId: fixture.agentId,
      text: 'Project Q is strong, solid and impressive work.',
      policy,
    });
    const held = await stances.active(fixture.agentId, 'Project Q');
    expect(held!.position).toBe('NEGATIVE');
    expect(held!.pinned).toBe(true);
  });
});

describe('predictions and promises', () => {
  it('notices a dated claim about the future and rates it more highly', () => {
    const dated = detectClaims('Adoption will pass ten million by the end of Q3.');
    expect(dated.prediction?.confidence).toBeGreaterThan(0.5);

    const vague = detectClaims('People will always find a way.');
    expect(vague.prediction?.confidence).toBeLessThan(0.5);
  });

  it('notices a promise to somebody', () => {
    const claims = detectClaims("Good question. I'll look into that and get back to you.");
    expect(claims.commitment?.promise).toMatch(/look into/i);
  });

  it('does not treat an ordinary sentence as an obligation', () => {
    expect(detectClaims('That is a fair point, and the numbers agree.').commitment).toBeNull();
  });

  it('keeps an open promise findable by who it was made to', async () => {
    const fixture = await createFixture();
    await stances.recordCommitment({
      agentId: fixture.agentId,
      promise: "I'll look into the unlock schedule.",
      recipientHandle: 'alice',
    });
    const open = await stances.openCommitmentsTo(fixture.agentId, '@alice');
    expect(open).toHaveLength(1);
  });

  it('leaves judging a prediction to a person', async () => {
    const fixture = await createFixture();
    await stances.recordPrediction({
      agentId: fixture.agentId,
      claim: 'It will ship by March.',
      reviewAt: new Date(Date.now() - 1000).toISOString(),
    });

    const due = await stances.predictionsDue(fixture.agentId);
    expect(due).toHaveLength(1);
    // Still open: nothing decides an outcome on its own.
    expect((due[0] as { outcome: string }).outcome).toBe('OPEN');
  });
});
