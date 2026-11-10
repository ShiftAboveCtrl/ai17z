import { createServer } from 'node:http';
import { createHash, createPublicKey, verify } from 'node:crypto';
import type { InstallationKey } from '../../packages/runtime/src/studioJose';
import { listenReachable } from './listen';

/** Proposed receiver contract. This does not stand in for a deployed Studio check. */
export async function publicHomeStudioServer(key: InstallationKey) {
  const requests: Array<Record<string, unknown>> = [];
  const receipts = new Map<string, Record<string, unknown>>();
  const proofs = new Set<string>();
  let origin = '';
  let unavailable = false;
  let loseAnswer = false;
  let mismatch = false;
  let published = false;
  let renewalAnswer: { status: number; body: Record<string, unknown> } | null = null;
  const server = createServer(async (req, res) => {
    const answer = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    try {
      const parts = String(req.headers.dpop).split('.');
      const header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString());
      const claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString());
      const token = req.url === '/api/v1/token';
      const valid = header.typ === 'dpop+jwt' && header.alg === 'ES256'
        && JSON.stringify(header.jwk) === JSON.stringify(key.publicJwk)
        && verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), { key: createPublicKey({ key: key.publicJwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(parts[2]!, 'base64url'))
        && claims.htm === 'POST' && claims.htu === origin + req.url && !proofs.has(claims.jti)
        && Math.abs(Date.now() / 1000 - claims.iat) < 60
        && (token || (req.headers.authorization === 'DPoP home-test-token' && claims.ath === createHash('sha256').update('home-test-token').digest('base64url')));
      if (!valid) return answer(401, {});
      proofs.add(claims.jti);
      if (token) return answer(200, { access_token: 'home-test-token', expires_in: 300 });
      if (!/^\/api\/v1\/installation\/agents\/[0-9a-f-]+\/home$/.test(req.url ?? '')) return answer(404, {});
      if (unavailable) { req.socket.destroy(); return; }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
      requests.push(body);
      if (body.operation === 'RENEW') {
        if (renewalAnswer) return answer(renewalAnswer.status, renewalAnswer.body);
        if (Object.keys(body).sort().join(',') !== 'idempotency_key,manifest_sha256,operation,protocol,publication_key'
          || !receipts.has(String(body.publication_key))) return answer(409, { error: 'unknown_publication' });
        if (!published) return answer(409, { error: 'publication_removed' });
        const renewal = { protocol: 1, published: true, slug: 'night-owl', manifest_sha256: body.manifest_sha256,
          valid_until: new Date(Date.now() + 15 * 60_000).toISOString() };
        const saved = receipts.get(String(body.idempotency_key)) ?? renewal;
        receipts.set(String(body.idempotency_key), saved);
        if (loseAnswer) { loseAnswer = false; req.socket.destroy(); return; }
        return answer(200, saved);
      }
      const id = String(body.idempotency_key);
      let receipt = receipts.get(id);
      if (!receipt) {
        published = body.operation === 'PUBLISH';
        receipt = { protocol: 1, published, slug: 'night-owl', manifest_sha256: mismatch ? '0'.repeat(64) : body.manifest_sha256 };
        receipts.set(id, receipt);
      }
      if (loseAnswer) { loseAnswer = false; req.socket.destroy(); return; }
      answer(200, receipt);
    } catch { answer(400, {}); }
  });
  origin = `http://127.0.0.1:${await listenReachable(server)}`;
  return { origin, requests, receipts, get published() { return published; },
    setUnavailable(value: boolean) { unavailable = value; }, loseNextAnswer() { loseAnswer = true; },
    mismatchNextReceipt() { mismatch = true; },
    setRenewalAnswer(value: typeof renewalAnswer) { renewalAnswer = value; },
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
