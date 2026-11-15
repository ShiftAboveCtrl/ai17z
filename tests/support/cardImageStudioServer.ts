import { createServer } from 'node:http';
import { createHash, createPublicKey, verify } from 'node:crypto';
import type { InstallationKey } from '../../packages/runtime/src/studioJose';
import { listenReachable } from './listen';

export const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

/** The proposed Studio card image endpoint, with real DPoP verification. */
export async function cardImageStudioServer(key: InstallationKey) {
  const seen = new Set<string>();
  const requests: { method: string; path: string; valid: boolean; body: string }[] = [];
  const state = { mode: 'png' as 'png' | 'html' | 'status500' | 'slow' | 'svg' };
  let origin = '';
  const server = createServer(async (req, res) => {
    const json = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    try {
      const proof = String(req.headers.dpop).split('.');
      const header = JSON.parse(Buffer.from(proof[0]!, 'base64url').toString());
      const claims = JSON.parse(Buffer.from(proof[1]!, 'base64url').toString());
      const token = req.url === '/api/v1/token';
      const valid = header.alg === 'ES256' && header.typ === 'dpop+jwt'
        && JSON.stringify(header.jwk) === JSON.stringify(key.publicJwk)
        && verify('sha256', Buffer.from(`${proof[0]}.${proof[1]}`), { key: createPublicKey({ key: key.publicJwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(proof[2]!, 'base64url'))
        && claims.htm === req.method && claims.htu === origin + req.url
        && Math.abs(Date.now() / 1000 - claims.iat) < 60 && !seen.has(claims.jti)
        && (token || (req.headers.authorization === 'DPoP card-image-token' && claims.ath === createHash('sha256').update('card-image-token').digest('base64url')));
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      requests.push({ method: req.method!, path: req.url!, valid, body: Buffer.concat(chunks).toString() });
      if (!valid) return json(401, {});
      seen.add(claims.jti);
      if (token) return json(200, { access_token: 'card-image-token', expires_in: 300 });
      if (req.method !== 'POST' || req.url !== '/api/v1/installation/evidence-card-image') return json(404, {});
      if (state.mode === 'status500') return json(500, {});
      if (state.mode === 'html') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end('<html>not a picture</html>'); }
      if (state.mode === 'svg') { res.writeHead(200, { 'content-type': 'image/svg+xml' }); return res.end('<svg xmlns="http://www.w3.org/2000/svg"/>'); }
      if (state.mode === 'slow') { await new Promise(r => setTimeout(r, 15_000)); return json(200, {}); }
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(TINY_PNG);
    } catch { json(422, {}); }
  });
  origin = `http://127.0.0.1:${await listenReachable(server)}`;
  return { origin, state, requests,
    imageRequests: () => requests.filter(r => r.path === '/api/v1/installation/evidence-card-image'),
    close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections?.(); server.close(error => error ? reject(error) : resolve()); }),
  };
}
