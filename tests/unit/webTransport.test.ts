import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * One AI17Z interface, two transports.
 *
 * A local owner's browser talks to the API on their machine; a hosted owner's
 * talks to an authenticated gateway reaching their isolated runtime. The same
 * components and the same API contracts serve both, which only stays true if
 * every request in the web client goes through the one seam. These tests read
 * the source, because the thing being protected is that no second path grows
 * back: a fetch that keeps its own base URL would quietly send a hosted
 * owner's request to their own empty localhost.
 */

const root = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');
const api = read('apps/web/src/lib/api.ts');
const transport = read('apps/web/src/lib/transport.ts');

describe('every request in the web client goes through the one seam', () => {
  it('has no fetch left with its own base url', () => {
    // The whole point: one place decides where requests go.
    expect(api).not.toContain('${BASE}');
    const fetches = [...api.matchAll(/await fetch\(`([^`]+)`/g)].map((m) => m[1]!);
    expect(fetches.length, 'there should be several, and all of them routed').toBeGreaterThan(2);
    for (const target of fetches) {
      expect(target, target).toContain('${transportBase()}');
    }
  });

  it('sends the transport headers rather than building its own', () => {
    // A request that assembles `authorization` itself is a request that will
    // not carry a hosted grant.
    expect(api).toContain('transportHeaders(token)');
    expect(api).not.toMatch(/authorization: `Bearer \$\{token\}`/);
  });

  it('does not clear a local session because a hosted grant expired', () => {
    // A grant is not a session. Clearing the local token on a gateway 401
    // would sign somebody out of their own machine.
    expect(api).toContain('clearsSessionOn401()');
  });
});

describe('a hosted client cannot name its own runtime', () => {
  it('has no runtime id anywhere in the transport', () => {
    // A client that can name a backend is a client that can try naming
    // somebody else's. The grant decides, server-side.
    expect(transport).not.toMatch(/runtimeId/i);
    expect(transport).not.toMatch(/runtime_id/i);
  });

  it('carries a grant and not a session for hosted requests', () => {
    expect(transport).toContain("'x-ai17z-grant'");
    // And the grant is held in memory. Browser storage would leave it behind
    // on a shared machine, and it is meant to expire rather than persist.
    // Matched on use rather than on the word, since the comment explaining
    // this says it too.
    expect(transport).not.toMatch(/localStorage\s*\.\s*(get|set|remove)Item/);
    expect(transport).not.toMatch(/sessionStorage\s*\.\s*(get|set|remove)Item/);
  });

  it('defaults to local, so nothing changes for an owner on their own machine', () => {
    expect(transport).toContain("mode: 'LOCAL'");
    expect(transport).toContain('VITE_XBAM_API_URL');
    // The default is assigned at module load, not chosen per request.
    expect(transport).toMatch(/let current: Transport = \{ mode: 'LOCAL'/);
  });
});
