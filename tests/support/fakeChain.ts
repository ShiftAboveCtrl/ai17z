import { createServer, type Server } from 'node:http';

/**
 * A stand-in for Robinhood Chain and for DexScreener, for the Studio contract
 * harness only. Studio is started pointing at it, so when the harness reports
 * a transaction, Studio reads that transaction off this server exactly as it
 * would off the real chain: receipts, native transfers, blocks and finality.
 * Nothing here signs or sends, and no real chain is touched.
 *
 * `mine` puts a transaction in the next block and makes it final at once. The
 * transaction is built from what AI17Z prepared for the wallet, so what Studio
 * confirms is what the wallet would have sent.
 */

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const hex = (n: bigint) => `0x${n.toString(16)}`;
const blockHash = (n: bigint) => `0x${'c'.repeat(48)}${n.toString(16).padStart(16, '0')}`;
const word = (address: string) => `0x${address.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;

export interface MinedTransaction {
  from: string;
  to: string;
  value: string;
  data: string;
}

export class FakeChain {
  head = 1_000n;
  private receipts = new Map<string, unknown>();
  private transactions = new Map<string, unknown>();
  private server: Server | null = null;

  constructor(
    private readonly port: number,
    private readonly market: { poolId: string; token: string; priceNative: string },
  ) {}

  /** A wallet's transaction, in the next block, final immediately. `ok: false` mines a revert. */
  mine(hash: string, tx: MinedTransaction, options: { ok?: boolean } = {}): void {
    this.head += 1n;
    const block = this.head;
    const isTokenTransfer = tx.data.startsWith('0xa9059cbb');
    const logs = isTokenTransfer
      ? [
          {
            address: tx.to,
            topics: [TRANSFER_TOPIC, word(tx.from), `0x${tx.data.slice(10, 74)}`],
            data: `0x${tx.data.slice(74, 138)}`,
            logIndex: '0x0',
            blockHash: blockHash(block),
            transactionHash: hash,
          },
        ]
      : [];
    this.receipts.set(hash, { status: options.ok === false ? '0x0' : '0x1', blockNumber: hex(block), blockHash: blockHash(block), transactionHash: hash, logs });
    this.transactions.set(hash, { hash, from: tx.from, to: tx.to, value: tx.value, input: tx.data, blockNumber: hex(block), blockHash: blockHash(block) });
    this.head += 1n;
  }

  private answer(method: string, params: unknown[]): unknown {
    switch (method) {
      case 'eth_chainId':
        return '0x1237';
      case 'eth_blockNumber':
        return hex(this.head);
      case 'eth_getTransactionReceipt':
        return this.receipts.get(String(params[0]).toLowerCase()) ?? null;
      case 'eth_getTransactionByHash':
        return this.transactions.get(String(params[0]).toLowerCase()) ?? null;
      case 'eth_getBlockByNumber': {
        const tag = String(params[0]);
        const n = tag === 'latest' || tag === 'safe' || tag === 'finalized' ? this.head : BigInt(tag);
        return { number: hex(n), hash: blockHash(n), timestamp: hex(BigInt(Math.floor(Date.now() / 1000))) };
      }
      default:
        throw new Error(`the fake chain does not answer ${method}`);
    }
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        if (req.method === 'GET' && req.url?.startsWith('/dex/tokens/v1/robinhood/')) {
          res.end(JSON.stringify([{ pairAddress: this.market.poolId, priceNative: this.market.priceNative, baseToken: { address: this.market.token } }]));
          return;
        }
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id: number; method: string; params: unknown[] };
          res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: this.answer(body.method, body.params ?? []) }));
        } catch (error) {
          res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: (error as Error).message } }));
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.port, '127.0.0.1', () => resolve());
    });
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}
