import { createServer } from 'node:http';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { STUDIO_RISK_PATH, StudioRiskObservationBatch, type StudioRiskObservation, type StudioRiskWatch } from '@xbam/shared/contracts';
import type { InstallationKey } from '../../packages/runtime/src/studioJose';
import { listenReachable } from './listen';

/** The proposed Studio contract, with real DPoP verification and durable-key behavior. */
export async function riskStudioServer(key: InstallationKey) {
  const seenProofs = new Set<string>();
  const observations = new Map<string, StudioRiskObservation>();
  const requests: { method: string; path: string; valid: boolean }[] = [];
  const batches: unknown[] = [];
  const state = { watches: [] as StudioRiskWatch[], document: null as unknown, status: 200, loseAcknowledgement: false };
  let origin = '';
  const server = createServer(async (req, res) => {
    const answer = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    try {
      const proof = String(req.headers.dpop).split('.');
      const header = JSON.parse(Buffer.from(proof[0]!, 'base64url').toString());
      const claims = JSON.parse(Buffer.from(proof[1]!, 'base64url').toString());
      const token = req.url === '/api/v1/token';
      const valid = header.alg === 'ES256' && header.typ === 'dpop+jwt'
        && JSON.stringify(header.jwk) === JSON.stringify(key.publicJwk)
        && verify('sha256', Buffer.from(`${proof[0]}.${proof[1]}`), { key: createPublicKey({ key: key.publicJwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(proof[2]!, 'base64url'))
        && claims.htm === req.method && claims.htu === origin + req.url
        && Math.abs(Date.now() / 1000 - claims.iat) < 60 && !seenProofs.has(claims.jti)
        && (token || (req.headers.authorization === 'DPoP risk-test-token' && claims.ath === createHash('sha256').update('risk-test-token').digest('base64url')));
      requests.push({ method: req.method!, path: req.url!, valid });
      if (!valid) return answer(401, {});
      seenProofs.add(claims.jti);
      if (token) return answer(200, { access_token: 'risk-test-token', expires_in: 300 });
      if (state.status !== 200) return answer(state.status, {});
      if (req.method === 'GET' && req.url === STUDIO_RISK_PATH) return answer(200, state.document ?? { protocol: 1, generated_at: new Date().toISOString(), watches: state.watches });
      if (req.method !== 'POST' || req.url !== `${STUDIO_RISK_PATH}/observations`) return answer(404, {});
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const batch = StudioRiskObservationBatch.parse(JSON.parse(Buffer.concat(chunks).toString()));
      batches.push(batch);
      for (const observation of batch.observations) {
        const watch = state.watches.find(w => w.id === observation.watch_id && w.mint === observation.mint);
        const revision = watch ? createHash('sha256').update(JSON.stringify([watch.id, watch.mint, watch.kind, watch.threshold])).digest('hex') : null;
        const digest = createHash('sha256').update(JSON.stringify([observation.watch_id, observation.watch_revision, observation.mint, observation.source, observation.after.observed_at, observation.after.value])).digest('hex');
        if (!watch || observation.watch_revision !== revision || digest !== observation.observation_id) return answer(422, {});
        const prior = observations.get(digest);
        if (prior && JSON.stringify(prior) !== JSON.stringify(observation)) return answer(409, {});
      }
      for (const observation of batch.observations) observations.set(observation.observation_id, observation);
      // Simulates committing successfully and losing the response on the wire.
      if (state.loseAcknowledgement) return answer(503, {});
      answer(200, { protocol: 1, accepted: batch.observations.map(o => o.observation_id) });
    } catch { answer(422, {}); }
  });
  origin = `http://127.0.0.1:${await listenReachable(server)}`;
  return { origin, state, observations, requests, batches,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}
