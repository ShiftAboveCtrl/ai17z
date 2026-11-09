import { createServer } from 'node:http';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { ActivityTapeBatch, type ActivityEvent } from '@xbam/shared/contracts';
import type { InstallationKey } from '../../packages/runtime/src/studioJose';
import { listenReachable } from './listen';

/** Contract implementation, not evidence about the deployed Studio. */
export async function activityStudioServer(key: InstallationKey) {
  const batches: Array<ReturnType<typeof ActivityTapeBatch.parse>> = [];
  const visible = new Map<string, ActivityEvent>();
  const removed = new Set<string>();
  const proofs = new Set<string>();
  let requests = 0;
  let unavailable = false;
  let origin = '';
  const server = createServer(async (req, res) => {
    requests++;
    const answer = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    try {
      const proof = String(req.headers.dpop).split('.');
      const header = JSON.parse(Buffer.from(proof[0]!, 'base64url').toString());
      const claims = JSON.parse(Buffer.from(proof[1]!, 'base64url').toString());
      const tokenRequest = req.url === '/api/v1/token';
      const valid = header.typ === 'dpop+jwt' && header.alg === 'ES256'
        && JSON.stringify(header.jwk) === JSON.stringify(key.publicJwk)
        && verify('sha256', Buffer.from(`${proof[0]}.${proof[1]}`), { key: createPublicKey({ key: key.publicJwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(proof[2]!, 'base64url'))
        && claims.htm === 'POST' && claims.htu === origin + req.url
        && Math.abs(Date.now() / 1000 - claims.iat) < 60 && !proofs.has(claims.jti)
        && (tokenRequest || (req.headers.authorization === 'DPoP tape-test-token'
          && claims.ath === createHash('sha256').update('tape-test-token').digest('base64url')));
      if (!valid) return answer(401, {});
      proofs.add(claims.jti);
      if (tokenRequest) return answer(200, { access_token: 'tape-test-token', expires_in: 300 });
      if (req.url !== '/api/v1/installation/activity-tape') return answer(404, {});
      if (unavailable) { req.socket.destroy(); return; }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const batch = ActivityTapeBatch.parse(JSON.parse(Buffer.concat(chunks).toString()));
      batches.push(batch);
      for (const id of batch.remove) {
        removed.add(id);
        for (const [key, event] of visible) if (event.id === id) visible.delete(key);
      }
      for (const event of batch.events) {
        const key = `${event.agent_id}:${event.id}`;
        if (!removed.has(event.id) && !visible.has(key)) visible.set(key, event);
      }
      answer(200, { protocol: 1, accepted: true });
    } catch { answer(400, {}); }
  });
  origin = `http://127.0.0.1:${await listenReachable(server)}`;
  return { origin, batches, visible, get requests() { return requests; },
    setUnavailable(value: boolean) { unavailable = value; },
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
