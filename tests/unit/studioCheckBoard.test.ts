import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PolicyConfig, CheckBoard, CheckContributionBatch, CheckContributionReceipt, CHECK_BOARD_MIN_ASKERS } from '@xbam/shared/contracts';
import { checkMostCheckedText, digestRows, mostCheckedIdea, SAYS_NOT_ENDORSED, checkMostCheckedAtSend, MOST_CHECKED_IDEA_SOURCE } from '../../packages/runtime/src/studioCheckBoard';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/studio-check-board.json', import.meta.url), 'utf8'));
const SOL = 'So11111111111111111111111111111111111111112';

describe('the frozen Studio payload', () => {
  it('parses the fixture Studio copies, and nothing else is in it', () => {
    expect(Object.keys(fixture).sort()).toEqual(['board', 'contribution_batch', 'contribution_receipt']);
    expect(CheckContributionBatch.parse(fixture.contribution_batch)).toEqual(fixture.contribution_batch);
    expect(CheckBoard.parse(fixture.board)).toEqual(fixture.board);
    expect(CheckContributionReceipt.parse(fixture.contribution_receipt)).toEqual(fixture.contribution_receipt);
  });
  it('carries no field that could identify an asker, an agent, an owner or text', () => {
    for (const extra of [{ handle: 'x' }, { agent_id: 'x' }, { owner: 'x' }, { text: 'x' }, { asker: 'x' }, { requester: 'x' }]) {
      const row = { ...fixture.contribution_batch.contributions[0], ...extra };
      expect(CheckContributionBatch.safeParse({ protocol: 1, contributions: [row] }).success).toBe(false);
    }
    expect(CheckContributionBatch.safeParse({ ...fixture.contribution_batch, agent_id: 'x' }).success).toBe(false);
  });
  it('refuses a bucket that is not on the UTC hour, a zero count and an unknown protocol', () => {
    const row = fixture.contribution_batch.contributions[0];
    expect(CheckContributionBatch.safeParse({ protocol: 1, contributions: [{ ...row, bucket_start: '2026-11-14T09:30:00.000Z' }] }).success).toBe(false);
    expect(CheckContributionBatch.safeParse({ protocol: 1, contributions: [{ ...row, askers: 0 }] }).success).toBe(false);
    expect(CheckContributionBatch.safeParse({ protocol: 2, contributions: [row] }).success).toBe(false);
  });
  it('refuses a board below the floor, out of count order, or listing a mint twice', () => {
    const [a, b] = fixture.board.rows;
    expect(CheckBoard.safeParse({ ...fixture.board, rows: [b, a] }).success).toBe(false);
    expect(CheckBoard.safeParse({ ...fixture.board, rows: [{ ...a, askers: 2 }] }).success).toBe(false);
    expect(CheckBoard.safeParse({ ...fixture.board, rows: [a, a] }).success).toBe(false);
    expect(CheckBoard.safeParse({ ...fixture.board, min_askers: 1 }).success).toBe(false);
  });
});

describe('opt-ins', () => {
  it('are both off by default and independent', () => {
    const policy = PolicyConfig.parse({});
    expect(policy.studio.contributeChecks).toBe(false);
    expect(policy.studio.postMostChecked).toBe(false);
    expect(PolicyConfig.parse({ studio: { contributeChecks: true } }).studio.postMostChecked).toBe(false);
  });
});

describe('the digest', () => {
  const board = CheckBoard.parse(fixture.board);
  it('lists rows by count only and says checked, not endorsed', () => {
    const idea = mostCheckedIdea(board)!;
    expect(idea.summary).toContain(SAYS_NOT_ENDORSED);
    expect(idea.summary.indexOf(SOL)).toBeLessThan(idea.summary.indexOf('0x4200'));
    expect(idea.summary).not.toMatch(/[—–]| - |--/);
  });
  it('lists nothing when no row clears the floor', () => {
    expect(CHECK_BOARD_MIN_ASKERS).toBe(3);
    expect(digestRows(board).every((r) => r.askers >= 3)).toBe(true);
    expect(mostCheckedIdea({ ...board, rows: [] })).toBeNull();
  });
  it('is keyed by the day and the figures so the same board is one idea', () => {
    expect(mostCheckedIdea(board)!.key).toBe(mostCheckedIdea(board)!.key);
    expect(mostCheckedIdea({ ...board, rows: [{ ...board.rows[0]!, askers: 10 }] })!.key).not.toBe(mostCheckedIdea(board)!.key);
  });
  it('holds finished text that gives advice, drops the framing or names a stray address or account', () => {
    const facts = mostCheckedIdea(board)!.summary;
    expect(checkMostCheckedText(`Most checked today: ${SOL} (9 askers). Checked, not endorsed.`, facts)).toEqual([]);
    expect(checkMostCheckedText(`Most checked today: ${SOL}.`, facts).join()).toMatch(/not endorsed/);
    expect(checkMostCheckedText(`Checked, not endorsed. You should buy ${SOL}`, facts).join()).toMatch(/advice/);
    expect(checkMostCheckedText(`Checked, not endorsed. ${SOL} looks safe`, facts).join()).toMatch(/advice/);
    expect(checkMostCheckedText('Checked, not endorsed. 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', facts).join()).toMatch(/address/);
    expect(checkMostCheckedText(`Checked, not endorsed. ${SOL} thanks @someone`, facts).join()).toMatch(/account/);
  });
  it('ignores any post that did not come from the digest', async () => {
    await expect(checkMostCheckedAtSend({ raw: { ideaSource: 'other' }, text: 'buy it', policy: PolicyConfig.parse({}) })).resolves.toBeUndefined();
  });
  it('refuses at send when the owner has not switched posting on', async () => {
    await expect(checkMostCheckedAtSend({ raw: { ideaSource: MOST_CHECKED_IDEA_SOURCE }, text: 'x', policy: PolicyConfig.parse({}) })).rejects.toThrow(/switched off/);
  });
});
