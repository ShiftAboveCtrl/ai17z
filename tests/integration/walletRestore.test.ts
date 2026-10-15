import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import { query, wallets as walletsRepo } from '@xbam/database';
import {
  approveIntent,
  base58,
  draftIntent,
  isRecoveryPhrase,
  newRecoveryPhrase,
  registerWalletAdapter,
  resetWalletAdapterForTest,
  secretFromPhrase,
  simulateIntent,
  submitIntent,
  type WalletAdapter,
} from '@xbam/runtime';
import { buildServer } from '../../apps/api/src/server';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';

/**
 * An agent wallet restored from the recovery phrase its owner holds. What is
 * pinned: the phrase opens the address its owner expected or is refused; the
 * key that signs is the one the phrase derives, so a signature made in the
 * ordinary approved path verifies against the address alone; and the phrase
 * and the key are nowhere afterwards, not in a response, an error, the
 * process's output or any row of any table.
 */

installHarness();

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});
afterAll(async () => {
  await app?.close();
});
afterEach(() => resetWalletAdapterForTest());

/** A Solana adapter whose signatures are real ed25519 over a fixed message, so the test can verify the key that signed. */
const MESSAGE = new TextEncoder().encode('ai17z wallet restore proof');
function signingAdapter(): WalletAdapter {
  return {
    id: 'test-solana-signer', version: '0', families: ['SOLANA'],
    generateSecret: () => new Uint8Array(32).fill(7),
    addressOf: (_f, secret) => base58(ed25519.getPublicKey(secret)),
    validAddress: (_f, address) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address),
    balances: async () => [],
    networkStatus: async () => ({ reachable: true, height: '1', chainProof: 'solana', detail: 'ok' }),
    recentActivity: async () => [],
    simulate: async () => ({ ok: true, maxFee: '5000', balanceBefore: '10000000', balanceAfter: '9000000', warnings: [], failure: null, pinned: { blockhash: 'test-blockhash' } }),
    sign: async (_n, secret) => ({ txHash: base58(ed25519.sign(MESSAGE, secret)), raw: 'signed' }),
    broadcast: async () => undefined,
    receipt: async () => 'CONFIRMED',
  };
}

async function signIn(email: string) {
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'test-password-1234' } });
  return { authorization: `Bearer ${(response.json() as { data: { token: string } }).data.token}` };
}

describe('restoring an agent wallet from its recovery phrase', () => {
  it('opens the expected address, signs with the key the phrase derives, and leaves the phrase and key nowhere', async () => {
    registerWalletAdapter(signingAdapter());
    const f = await createFixture();
    const auth = await signIn(f.ownerEmail);
    // A phrase made for this test, controlling nothing.
    const phrase = newRecoveryPhrase();
    const secret = secretFromPhrase('SOLANA', phrase);
    const address = base58(ed25519.getPublicKey(secret));
    const secretB64 = Buffer.from(secret).toString('base64');
    const secretHex = Buffer.from(secret).toString('hex');

    const captured: string[] = [];
    const out = process.stdout.write.bind(process.stdout);
    const err = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => (captured.push(String(chunk)), out(chunk as never, ...(rest as [])))) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => (captured.push(String(chunk)), err(chunk as never, ...(rest as []))) ) as typeof process.stderr.write;
    const answers: string[] = [];
    try {
      // A phrase that opens a different wallet from the one expected is refused, naming addresses and never words.
      const mismatch = await app.inject({ method: 'POST', url: `/api/agents/${f.agentId}/wallets/restore`, headers: auth, payload: { family: 'SOLANA', phrase, expectedAddress: 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk' } });
      answers.push(mismatch.body);
      expect(mismatch.statusCode).toBe(422);
      expect(mismatch.body).toContain(address);

      // A phrase with one word changed is not a phrase, and the answer does not repeat it. The last word carries
      // only four checksum bits, so one replacement in sixteen is still a valid phrase: choose one that is not.
      const words = phrase.split(' ');
      const broken = ['zoo', 'abandon', 'ability', 'able', 'about'].map((w) => [...words.slice(0, 11), w].join(' ')).find((p) => p !== phrase && !isRecoveryPhrase(p))!;
      const bad = await app.inject({ method: 'POST', url: `/api/agents/${f.agentId}/wallets/restore`, headers: auth, payload: { family: 'SOLANA', phrase: broken } });
      answers.push(bad.body);
      expect(bad.statusCode).toBe(422);

      const ok = await app.inject({ method: 'POST', url: `/api/agents/${f.agentId}/wallets/restore`, headers: auth, payload: { family: 'SOLANA', phrase, expectedAddress: address } });
      answers.push(ok.body);
      expect(ok.statusCode).toBe(200);
      expect((ok.json() as { data: { wallet: { address: string; origin: string } } }).data.wallet).toMatchObject({ address, origin: 'PHRASE' });
      // Restored again: the same wallet, not a second one.
      const again = await app.inject({ method: 'POST', url: `/api/agents/${f.agentId}/wallets/restore`, headers: auth, payload: { family: 'SOLANA', phrase } });
      answers.push(again.body);
      expect((again.json() as { data: { wallet: { address: string } } }).data.wallet.address).toBe(address);
      expect((await walletsRepo.liveWallets(f.agentId)).filter((w) => w.family === 'SOLANA')).toHaveLength(1);

      // Somebody else cannot restore into this agent.
      const stranger = await createFixture();
      const theirs = await app.inject({ method: 'POST', url: `/api/agents/${f.agentId}/wallets/restore`, headers: await signIn(stranger.ownerEmail), payload: { family: 'SOLANA', phrase } });
      answers.push(theirs.body);
      expect(theirs.statusCode).toBe(404);

      // The ordinary approved path signs with the restored key: the signature verifies against the address alone.
      const { intent } = await draftIntent({ agentId: f.agentId, ownerId: f.ownerId, params: { kind: 'NATIVE_TRANSFER', network: 'solana', to: 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk', amount: '1000' }, idempotencyKey: 'restore-proof-1' });
      const simulated = await simulateIntent(intent.id, f.ownerId);
      await approveIntent(intent.id, f.ownerId, simulated.digest!);
      const sent = await submitIntent(intent.id, f.ownerId);
      expect(ed25519.verify(Buffer.from(base58Decode(sent.txHash!)), MESSAGE, base58Decode(address))).toBe(true);
    } finally {
      process.stdout.write = out;
      process.stderr.write = err;
    }

    // Nowhere afterwards: not in an answer, not in the process's output, not in any row of any table.
    const haystacks = [...answers, ...captured];
    for (const needle of [phrase, secretB64, secretHex, phrase.split(' ').slice(0, 4).join(' ')]) {
      expect(haystacks.some((h) => h.includes(needle))).toBe(false);
    }
    const tables = await query<{ table_name: string }>(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`);
    for (const { table_name } of tables) {
      const hit = await query<{ n: number }>(
        `SELECT count(*)::int AS n FROM "${table_name}" t WHERE row_to_json(t)::text LIKE $1 OR row_to_json(t)::text LIKE $2 OR row_to_json(t)::text LIKE $3`,
        [`%${phrase.split(' ').slice(0, 4).join(' ')}%`, `%${secretB64}%`, `%${secretHex}%`],
      );
      expect(hit[0]!.n, table_name).toBe(0);
    }
    secret.fill(0);
  });
});

function base58Decode(s: string): Uint8Array {
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(A.indexOf(c));
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const c of s) {
    if (c !== '1') break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}
