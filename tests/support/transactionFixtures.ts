/**
 * Recorded-shape `getTransaction` results (encoding jsonParsed), written out by hand
 * from the node's documented response. No live RPC is involved anywhere in the tests.
 * Addresses are well formed placeholders.
 */
export const TX_SIGNATURE = '95QFYJxcjSJ9pMkYHEr2JLxfuM21P6BRMHxw7bvkEkSsVB8PEtGeCrqZnkSzfZAtpiX17z9Yg8hLB5RfXRJvQkv';
export const TX_OTHER_SIGNATURE = '2Qv8c3hq7bDtvA3jZk2uZtV9o6cJm4nB1yHq5RkYcLw8PqXr3nTfG7sD2aKe9uVbMhN4jWxCzR6yTp1LsQfE8gHa';
export const PAYER = 'FeePayer1111111111111111111111111111111111';
export const RECEIVER = 'Receiver111111111111111111111111111111111';
export const TOKEN_ACCOUNT_A = 'TokenAcctA11111111111111111111111111111111';
export const TOKEN_ACCOUNT_B = 'TokenAcctB11111111111111111111111111111111';
export const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const OWNER_A = 'OwnerA11111111111111111111111111111111111';
export const UNKNOWN_PROGRAM = 'DEXdexDEXdexDEXdexDEXdexDEXdexDEXdexDEXdex1';
const SYSTEM = '11111111111111111111111111111111';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const BUDGET = 'ComputeBudget111111111111111111111111111111';

const key = (pubkey: string, signer = false, writable = true) => ({ pubkey, signer, writable, source: 'transaction' });
const token = (accountIndex: number, amount: string, owner = OWNER_A) => ({
  accountIndex, mint: MINT, owner, programId: TOKEN, uiTokenAmount: { amount, decimals: 6, uiAmount: Number(amount) / 1e6, uiAmountString: String(Number(amount) / 1e6) },
});

/** A transfer of SOL and USDC through a program the reader has no decoder for. */
export function successfulTransaction() {
  return {
    slot: 446036119,
    blockTime: 1789091442,
    version: 0,
    meta: {
      err: null,
      fee: 5000,
      preBalances: [2_000_000_000, 500_000_000, 2_039_280, 2_039_280, 1, 1, 1],
      postBalances: [1_994_995_000, 505_000_000, 2_039_280, 2_039_280, 1, 1, 1],
      preTokenBalances: [token(2, '1500000'), token(3, '10000000')],
      postTokenBalances: [token(2, '500000'), token(3, '11000000')],
      innerInstructions: [{ index: 1, instructions: [{ programId: TOKEN, program: 'spl-token', parsed: { type: 'transfer', info: {} } }] }],
    },
    transaction: {
      signatures: [TX_SIGNATURE],
      message: {
        accountKeys: [key(PAYER, true), key(RECEIVER), key(TOKEN_ACCOUNT_A), key(TOKEN_ACCOUNT_B), key(UNKNOWN_PROGRAM, false, false), key(SYSTEM, false, false), key(BUDGET, false, false)],
        instructions: [
          { programId: BUDGET, accounts: [], data: '3DTZbgwzwhw3' },
          { programId: SYSTEM, program: 'system', parsed: { type: 'transfer', info: { lamports: 5_000_000 } } },
          { programId: UNKNOWN_PROGRAM, accounts: [TOKEN_ACCOUNT_A, TOKEN_ACCOUNT_B], data: '7YJ3Qx' },
        ],
      },
    },
  };
}

/** A transaction that reverted: it still paid its fee. */
export function failedTransaction() {
  const tx = successfulTransaction();
  return {
    ...tx,
    meta: { ...tx.meta, err: { InstructionError: [2, { Custom: 6001 }] }, preBalances: [2_000_000_000, 500_000_000, 2_039_280, 2_039_280, 1, 1, 1],
      postBalances: [1_999_995_000, 500_000_000, 2_039_280, 2_039_280, 1, 1, 1], preTokenBalances: [], postTokenBalances: [], innerInstructions: [] },
  };
}

/** A token account that only exists afterwards, and a token section the node did not send at all. */
export function createdAccountTransaction() {
  const tx = successfulTransaction();
  return { ...tx, meta: { ...tx.meta, preTokenBalances: [], postTokenBalances: [token(2, '250000')] } };
}

export function withoutBalances() {
  const tx = successfulTransaction();
  const { preBalances: _a, postBalances: _b, preTokenBalances: _c, postTokenBalances: _d, ...meta } = tx.meta;
  return { ...tx, meta };
}
