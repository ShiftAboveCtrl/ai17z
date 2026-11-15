import { describe, expect, it } from 'vitest';
import { renderTransactionReading, fitTransactionReading, TX_BANNED, txShortAddress } from '@xbam/prompts';
import { explainTransactionRequest } from '../../packages/runtime/src/research';
import { buildTransactionReport, transactionAddresses, transactionCurrent } from '../../packages/runtime/src/transactionReading';
import { validateOutput } from '../../packages/runtime/src/validator';
import { DEFAULT_POLICY } from '@xbam/shared/contracts';
import {
  MINT, TX_OTHER_SIGNATURE, TX_SIGNATURE, UNKNOWN_PROGRAM, createdAccountTransaction, failedTransaction, successfulTransaction, withoutBalances,
} from '../support/transactionFixtures';

const build = (result: unknown, commitment: 'finalized' | 'confirmed' = 'finalized', maxCharacters = 5000) =>
  buildTransactionReport({ signature: TX_SIGNATURE, result, commitment, source: 'solana_rpc.test', fetchedAt: new Date().toISOString(), maxCharacters });

describe('which messages ask to explain a transaction', () => {
  it('takes one signature that decodes to 64 bytes, bare or inside an explorer link', () => {
    expect(explainTransactionRequest(`@agent what did this do? ${TX_SIGNATURE}`)).toEqual({ signature: TX_SIGNATURE });
    expect(explainTransactionRequest(`explain https://solscan.io/tx/${TX_SIGNATURE}`)).toEqual({ signature: TX_SIGNATURE });
  });

  it('refuses a run that is the right shape but not 64 bytes, and does not repair it', () => {
    const tooLong = `${TX_SIGNATURE}${TX_SIGNATURE.slice(0, 10)}`;
    const request = explainTransactionRequest(`what did this do ${tooLong}`);
    expect(request).toMatchObject({ refusal: expect.stringMatching(/does not decode/) });
    const shortRun = 'A'.repeat(90);
    expect(explainTransactionRequest(`explain ${shortRun}`)).toMatchObject({ refusal: expect.stringMatching(/does not decode/) });
  });

  it('refuses two signatures and a question about whose it is, and reads for neither', () => {
    expect(explainTransactionRequest(`explain ${TX_SIGNATURE} and ${TX_OTHER_SIGNATURE}`)).toMatchObject({ refusal: expect.stringMatching(/One transaction at a time/) });
    expect(explainTransactionRequest(`whose is this tx ${TX_SIGNATURE}`)).toMatchObject({ refusal: expect.stringMatching(/do not say who/) });
    expect(explainTransactionRequest(`who owns the wallet in ${TX_SIGNATURE}`)).toMatchObject({ refusal: expect.stringMatching(/do not say who/) });
  });

  it('is not triggered by ordinary speech, a bare string, or a token ask', () => {
    expect(explainTransactionRequest('what did this do?')).toBeNull();
    expect(explainTransactionRequest(`gm ${TX_SIGNATURE}`)).toBeNull();
    expect(explainTransactionRequest(`what did this do ${TX_SIGNATURE} ${MINT}`)).toBeNull();
  });
});

describe('the address rule', () => {
  // Long enough that the length rule does not trim the appended address away before the address rule sees it.
  const policy = { ...DEFAULT_POLICY, output: { ...DEFAULT_POLICY.output, maxCharacters: 5000 } };
  it('lets through a program address the node reported and still holds any other address', () => {
    const { text, report } = build(successfulTransaction())!;
    const proven = transactionAddresses(report);
    expect(validateOutput(text, policy, null, '', null, proven).violations.filter(v => v.rule === 'unverified_address')).toEqual([]);
    expect(validateOutput(text, policy, null, '', null, null).violations.some(v => v.rule === 'unverified_address')).toBe(true);
    const added = `${text}\n${MINT}`;
    expect(validateOutput(added, policy, null, '', null, proven).violations.some(v => v.rule === 'unverified_address')).toBe(true);
  });
});

describe('the reading', () => {
  it('lists only what was read: status, slot, commitment, time, fee, programs, and per account amounts', () => {
    const { text, report } = build(successfulTransaction())!;
    expect(text).toContain('Status: succeeded, finalized, slot 446036119, block time 2026-');
    expect(text).toContain('fee 5000 lamports');
    expect(text).toContain('Programs called: Compute Budget, System Program, ' + UNKNOWN_PROGRAM + ', SPL Token');
    expect(text).toContain('#1 Compute Budget not decoded');
    expect(text).toContain('#2 System Program transfer');
    expect(text).toContain(`#3 ${UNKNOWN_PROGRAM} not decoded`);
    expect(text).toContain('2000000000 -> 1994995000 lamports, 9 decimals (-5005000)');
    expect(text).toContain('1500000 -> 500000 raw, 6 decimals (-1000000)');
    expect(text).toContain('10000000 -> 11000000 raw, 6 decimals (+1000000)');
    expect(renderTransactionReading(report)).toBe(text);
  });

  it('never uses wording that claims intent, and names nobody', () => {
    for (const result of [successfulTransaction(), failedTransaction(), createdAccountTransaction()]) {
      const { text } = build(result)!;
      expect(text).not.toMatch(TX_BANNED);
      expect(text).not.toMatch(/whale|insider|smart money|dumped|bought|sold|profit|loss|swap|rug/i);
    }
    expect(txShortAddress('rugGgGgGgGgGgGgGgGgGgGgGgGgGgGgGgGg4xyz')).not.toMatch(TX_BANNED);
  });

  it('reports a failure first and still lists the fee, without interpreting the error', () => {
    const { text } = build(failedTransaction())!;
    expect(text).toContain('Status: failed, finalized');
    expect(text).toContain('The cluster reported: {"InstructionError":[2,{"Custom":6001}]}');
    expect(text).toContain('fee 5000 lamports');
    expect(text).toContain('Token balance changes (raw amounts): none in this transaction');
  });

  it('says confirmed is not yet finalized', () => {
    expect(build(successfulTransaction(), 'confirmed')!.text).toContain('confirmed (not yet finalized)');
  });

  it('prints a side the transaction did not record as not recorded, never as zero', () => {
    const { text } = build(createdAccountTransaction())!;
    expect(text).toContain('not recorded -> 250000 raw, 6 decimals');
    expect(text).not.toContain('0 -> 250000');
  });

  it('says balances were not read when the node sent none, and does not invent changes', () => {
    const { text, report } = build(withoutBalances())!;
    expect(report.solChanges).toBeNull();
    expect(text).toContain('SOL balance changes (raw lamports): not read');
    expect(text).toContain('Token balance changes (raw amounts): not read');
  });

  it('is nothing at all when the node returned nothing', () => {
    expect(build(null)).toBeNull();
  });

  it('fits the length policy by showing fewer changes and counting the rest', () => {
    const full = build(successfulTransaction())!;
    const tight = build(successfulTransaction(), 'finalized', full.text.length - 40)!;
    expect(tight.text.length).toBeLessThan(full.text.length);
    expect(tight.text).toMatch(/\d+ more not shown/);
    expect(renderTransactionReading(tight.report)).toBe(tight.text);
    const { report } = fitTransactionReading({ ...full.report }, 10);
    expect(report.shownChanges).toBe(0);
  });

  it('is current for five minutes and not after', () => {
    const { report } = build(successfulTransaction())!;
    expect(transactionCurrent(report)).toBe(true);
    expect(transactionCurrent(report, Date.parse(report.fetchedAt) + 6 * 60_000)).toBe(false);
  });
});
